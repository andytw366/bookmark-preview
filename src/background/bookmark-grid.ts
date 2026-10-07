import { createSerialQueue } from '@/shared/serial-queue';
import { broadcast } from '@/shared/messages';
import type { BookmarkGrid, GridSyncStatus, StoredGroup } from '@/shared/messages';
import {
  applyOp,
  buildBoard,
  insertItems,
  membersInOrder,
  removeItems,
  replaceItem,
  type Board,
  type GridOp,
} from '@/shared/board';
import { indexOfId, readingOrder, unmoved } from '@/shared/grid';
import { nextColor, sameName, tagMatches, type GroupInfo } from '@/shared/groups';
import { t } from '@/shared/i18n';
import { isPreviewableUrl } from '@/shared/url';
import { getSettings } from '@/storage/settings';
import { GRID_ITEM_LIMIT, GRID_PREFIX, GRID_SYNC_BUDGET, gridBytes, gridKey } from '@/storage/grid-sync';
import { deviceId, syncAvailable } from '@/storage/vault-sync';
import { placeBefore } from './bookmark-order';

/**
 * 原生書籤的版面（欄數）與群組。
 *
 * **WebExtension 讀不到 Firefox 原生的標籤**，所以群組是擴充套件自己存的：
 * `storage.local` 的 `grid:<資料夾 guid>`，一個資料夾一份
 * `{ v, columns, groups: [{ id, name, color, members }], updatedAt, deviceId }`。
 * 明文沒有問題 —— 那些本來就是明文的 Firefox 書籤。
 *
 * - **順序就是 Firefox 原生的順序**：卡片緊密排列、不留空格，所以不另外存順序；每次版面操作後
 *   把原生書籤搬成畫面的順序（只搬變了的那幾筆）。擴充套件不在時，Firefox 的書籤選單裡群組成員也是相鄰的。
 * - `columns` 是使用者按 − / + 定下來的欄數，0 = 跟著視窗（自動排列）。
 * - **跨裝置同步**：同一份也寫進 `storage.sync` 的同名鍵（預設打開，固定預算 20 KB）。
 *   讀到遠端那份時整份較新者勝。Firefox 同步會讓同一個書籤在各台電腦的 GUID 一致，
 *   這是能同步的前提；成員裡本機還沒有的 GUID 保留著（那筆書籤可能還沒同步過來）。
 *
 * **所有改動走同一個佇列，連 `onRemoved` / `onMoved` 的清理也是。** 版面操作自己就會
 * 搬書籤，那些搬動觸發的 `onMoved` 若與操作本身交錯，「讀 → 改 → 寫」會互相蓋掉。
 */
const exclusive = createSerialQueue();

/** 第 3 期（還沒發布過）的舊格式。不遷移，啟動時刪掉 */
const LEGACY_PREFIX = 'groups:';

interface GridDoc {
  v: 1;
  /** 0 = 跟著視窗（自動排列） */
  columns: number;
  groups: StoredGroup[];
  updatedAt: number;
  deviceId: string;
}

function isStoredGroup(value: unknown): value is StoredGroup {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const group = value as Partial<StoredGroup>;
  return (
    typeof group.id === 'string' &&
    typeof group.name === 'string' &&
    typeof group.color === 'number' &&
    Array.isArray(group.members) &&
    group.members.every((member) => typeof member === 'string')
  );
}

function asDoc(value: unknown): GridDoc | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const doc = value as Partial<GridDoc>;
  if (
    doc.v !== 1 ||
    typeof doc.columns !== 'number' ||
    !Array.isArray(doc.groups) ||
    typeof doc.updatedAt !== 'number' ||
    typeof doc.deviceId !== 'string'
  ) {
    return null;
  }
  return {
    v: 1,
    columns: doc.columns,
    groups: doc.groups.filter(isStoredGroup),
    updatedAt: doc.updatedAt,
    deviceId: doc.deviceId,
  };
}

/** 同一個資料夾的兩份：較新的勝，同時間比 deviceId（兩台裝置選的是同一個就好） */
function isNewer(a: GridDoc, b: GridDoc | null): boolean {
  if (b === null) {
    return true;
  }
  return a.updatedAt !== b.updatedAt ? a.updatedAt > b.updatedAt : a.deviceId > b.deviceId;
}

async function readDoc(folderId: string): Promise<GridDoc | null> {
  const key = gridKey(folderId);
  return asDoc((await browser.storage.local.get(key))[key]);
}

export async function getBookmarkGrid(folderId: string): Promise<BookmarkGrid | null> {
  const doc = await readDoc(folderId);
  return doc === null ? null : { columns: doc.columns, groups: doc.groups };
}

/** 畫面上看得到的子項目（與 `bookmark-tree` 的過濾一致：沒有分隔線、沒有 `place:`） */
async function visibleChildren(folderId: string): Promise<browser.bookmarks.BookmarkTreeNode[]> {
  return (await browser.bookmarks.getChildren(folderId)).filter((node) => {
    if (node.type === 'separator') {
      return false;
    }
    const isFolder = node.type === 'folder' || node.url === undefined;
    return isFolder || (node.url !== undefined && isPreviewableUrl(node.url));
  });
}

interface Loaded {
  doc: GridDoc | null;
  board: Board;
  links: Set<string>;
}

async function load(folderId: string, autoColumns: number): Promise<Loaded> {
  const doc = await readDoc(folderId);
  const children = (await visibleChildren(folderId));
  const ids = children.map((node) => node.id);
  const groupOf = new Map<string, string>();
  for (const group of doc?.groups ?? []) {
    for (const member of group.members) {
      groupOf.set(member, group.id);
    }
  }
  const columns = doc?.columns ?? 0;
  const board = buildBoard({
    stored: columns > 0 ? { columns, cells: ids } : null,
    fixed: columns > 0,
    children: ids,
    autoColumns,
    groups: (doc?.groups ?? []).map(({ id, name, color, pinned }) => ({
      id,
      name,
      color,
      ...(pinned === true ? { pinned } : {}),
    })),
    groupOf: (id) => groupOf.get(id) ?? null,
  });
  return { doc, board, links: new Set(children.filter((node) => node.url !== undefined).map((node) => node.id)) };
}

/**
 * 把原生書籤排成 `want` 的順序。只搬不在最長遞增子序列裡的那幾筆，從後往前
 * 一筆一筆放到「它後面那一筆」的前面 —— 後面那一筆已經在對的位置上了。
 */
async function syncNativeOrder(folderId: string, want: readonly string[]): Promise<void> {
  const current = (await visibleChildren(folderId)).map((node) => node.id);
  const present = new Set(current);
  const order = want.filter((id) => present.has(id));
  const keep = unmoved(current, order);
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const id = order[index];
    if (id === undefined || keep.has(id)) {
      continue;
    }
    await placeBefore(id, folderId, order[index + 1] ?? null);
  }
}

async function write(folderId: string, doc: GridDoc): Promise<void> {
  const key = gridKey(folderId);
  await browser.storage.local.set({ [key]: doc });
  broadcast('grid/changed', { folderId });
  await upload([key]);
}

/**
 * 版面寫回去：欄數、群組（成員照順序）、原生順序。
 * 群組裡本機還沒有的成員（另一台裝置同步過來、書籤本身還沒到）照樣留著。
 */
async function save(folderId: string, loaded: Loaded, next: Board): Promise<void> {
  const present = new Set(next.grid.cells);
  const groups = next.groups.map((group) => ({
    ...group,
    members: [
      ...membersInOrder(next, group.id),
      ...(loaded.doc?.groups.find((old) => old.id === group.id)?.members.filter((id) => !present.has(id)) ?? []),
    ],
  }));
  await write(folderId, {
    v: 1,
    columns: next.fixed ? next.grid.columns : 0,
    groups,
    updatedAt: Date.now(),
    deviceId: await deviceId(),
  });
  await syncNativeOrder(folderId, readingOrder(next.grid));
}

export async function applyBookmarkGrid(folderId: string, columns: number, op: GridOp): Promise<void> {
  return exclusive(async () => {
    if (op.kind === 'place') {
      // 多選可以跨資料夾：別處勾的先搬進來（放到最後），再照落點排
      const here = new Set((await browser.bookmarks.getChildren(folderId)).map((node) => node.id));
      for (const id of op.ids) {
        if (!here.has(id)) {
          await browser.bookmarks.move(id, { parentId: folderId });
        }
      }
    }
    const loaded = await load(folderId, columns);
    const next = applyOp(loaded.board, op, {
      isLink: (id) => loaded.links.has(id),
      newId: () => crypto.randomUUID(),
    });
    await save(folderId, loaded, next);
  });
}

function requireGroup(board: Board, groupId: string): GroupInfo {
  const group = board.groups.find((item) => item.id === groupId);
  if (group === undefined) {
    throw new Error(t('group_not_found'));
  }
  return group;
}

/** 轉成資料夾：在第一個成員的位置建子資料夾，成員照順序搬進去。回傳新資料夾 id */
export async function groupToFolder(folderId: string, groupId: string, columns: number): Promise<string> {
  return exclusive(async () => {
    const loaded = await load(folderId, columns);
    const group = requireGroup(loaded.board, groupId);
    const members = membersInOrder(loaded.board, groupId);
    const folder = await browser.bookmarks.create({
      parentId: folderId,
      title: group.name === '' ? t('group_untitled') : group.name,
    });
    for (const id of members) {
      await browser.bookmarks.move(id, { parentId: folder.id });
    }
    const [first, ...rest] = members;
    const next = removeItems(replaceItem(loaded.board, first ?? '', folder.id), new Set(rest));
    await save(folderId, loaded, next);
    return folder.id;
  });
}

/**
 * 攤平成群組：子資料夾裡的書籤搬回上層、放在子資料夾原本的位置，成為一個同名群組
 * （那裡已有同名的就加入），子資料夾刪掉。子資料夾裡還有資料夾時拒絕 —— 那些資料夾沒有地方放。
 */
export async function flattenFolder(subfolderId: string, columns: number): Promise<void> {
  return exclusive(async () => {
    const [sub] = await browser.bookmarks.get(subfolderId);
    if (sub?.parentId === undefined) {
      throw new Error(t('group_not_found'));
    }
    const parentId = sub.parentId;
    const children = await browser.bookmarks.getChildren(subfolderId);
    if (children.some((child) => child.type === 'folder' || (child.type === undefined && child.url === undefined))) {
      throw new Error(t('group_flatten_has_folders'));
    }
    const before = await load(parentId, columns);
    const at = indexOfId(before.board.grid, subfolderId);
    const links = children.filter((child) => child.url !== undefined).map((child) => child.id);
    for (const id of links) {
      await browser.bookmarks.move(id, { parentId });
    }
    await browser.bookmarks.removeTree(subfolderId);

    const loaded = await load(parentId, columns);
    // 「轉成資料夾」替沒名字的群組取的資料夾名稱，攤平回來時還原成沒名字
    const name = sub.title.trim() === t('group_untitled') ? '' : sub.title.trim();
    const group = loaded.board.groups.find((item) => name !== '' && sameName(item.name, name)) ?? {
      id: crypto.randomUUID(),
      name,
      color: nextColor(loaded.board.groups),
    };
    await save(parentId, loaded, insertItems(loaded.board, links, group, at === -1 ? undefined : at));
  });
}

/**
 * 拖群組的標籤到別的資料夾：整組照順序接在那邊最後；那邊有同名群組就併進去，
 * 沒有就照原樣（名稱、顏色）帶過去。
 */
export async function moveGroup(
  fromFolderId: string,
  groupId: string,
  toFolderId: string,
  columns: number,
): Promise<void> {
  return exclusive(async () => {
    if (fromFolderId === toFolderId) {
      return;
    }
    const source = await load(fromFolderId, columns);
    const group = requireGroup(source.board, groupId);
    const members = membersInOrder(source.board, groupId);
    for (const id of members) {
      await browser.bookmarks.move(id, { parentId: toFolderId });
    }
    await save(fromFolderId, source, removeItems(source.board, new Set(members)));

    const target = await load(toFolderId, columns);
    const joined = target.board.groups.find((item) => group.name !== '' && sameName(item.name, group.name)) ?? group;
    await save(toFolderId, target, insertItems(target.board, members, joined));
  });
}

/** 從某個資料夾的群組裡拿掉幾個 id（被刪、被搬到別的資料夾） */
async function forget(folderId: string, ids: ReadonlySet<string>): Promise<void> {
  const doc = await readDoc(folderId);
  if (doc === null || !doc.groups.some((group) => group.members.some((id) => ids.has(id)))) {
    return;
  }
  await write(folderId, {
    ...doc,
    groups: doc.groups
      .map((group) => ({ ...group, members: group.members.filter((id) => !ids.has(id)) }))
      .filter((group) => group.members.length > 0),
    updatedAt: Date.now(),
    deviceId: await deviceId(),
  });
}

function folderIdsIn(node: browser.bookmarks.BookmarkTreeNode | undefined): string[] {
  if (node === undefined || node.url !== undefined) {
    return [];
  }
  return [node.id, ...(node.children ?? []).flatMap(folderIdsIn)];
}

// ── 同步 ─────────────────────────────────────────────────────────────

let lastStatus: { over: boolean; total: number; folders: GridSyncStatus['folders'] } = {
  over: false,
  total: 0,
  folders: [],
};

async function syncEnabled(): Promise<boolean> {
  return syncAvailable() && (await getSettings()).syncGrid;
}

async function localDocs(): Promise<Map<string, GridDoc>> {
  const all = await browser.storage.local.get(null);
  const out = new Map<string, GridDoc>();
  for (const [key, value] of Object.entries(all)) {
    const doc = key.startsWith(GRID_PREFIX) ? asDoc(value) : null;
    if (doc !== null) {
      out.set(key, doc);
    }
  }
  return out;
}

/**
 * 搜尋的 `#名稱`：所有資料夾裡名稱相符（`tagMatches`）的群組成員。成員是不是真的還在那個資料夾裡
 * 由畫面對照書籤樹判斷（清理是非同步的，這裡讀到的可能慢一步）。
 */
export async function findTagged(name: string): Promise<{ folderId: string; id: string }[]> {
  const out: { folderId: string; id: string }[] = [];
  for (const [key, doc] of await localDocs()) {
    const folderId = key.slice(GRID_PREFIX.length);
    for (const group of doc.groups) {
      if (tagMatches(group.name, name)) {
        out.push(...group.members.map((id) => ({ folderId, id })));
      }
    }
  }
  return out;
}

async function removeRemote(keys?: readonly string[]): Promise<void> {
  if (!syncAvailable()) {
    return;
  }
  const targets =
    keys ?? Object.keys(await browser.storage.sync.get(null)).filter((key) => key.startsWith(GRID_PREFIX));
  if (targets.length > 0) {
    await browser.storage.sync.remove([...targets]);
  }
}

async function titleOf(key: string): Promise<string> {
  try {
    const [node] = await browser.bookmarks.get(key.slice(GRID_PREFIX.length));
    return node?.title ?? key;
  } catch {
    return key;
  }
}

/**
 * 把本機的格子推上去。`keys` 省略 = 全部（打開同步、啟動時）。
 *
 * 單筆超過上限的資料夾只存本機；全部合計超過預算就整個停下、清掉雲端那幾份，
 * 騰出空間給隱私空間 —— 狀態留給設定頁顯示。
 */
async function upload(keys?: readonly string[]): Promise<void> {
  if (!(await syncEnabled())) {
    return;
  }
  const docs = await localDocs();
  const sizes = [...docs].map(([key, doc]) => ({ key, doc, bytes: gridBytes(key, doc) }));
  const syncable = sizes.filter((item) => item.bytes <= GRID_ITEM_LIMIT);
  const total = syncable.reduce((sum, item) => sum + item.bytes, 0);
  const over = total > GRID_SYNC_BUDGET;
  const listed = over
    ? [...sizes].sort((a, b) => b.bytes - a.bytes).slice(0, 5)
    : sizes.filter((item) => item.bytes > GRID_ITEM_LIMIT);
  lastStatus = {
    over,
    total,
    folders: await Promise.all(
      listed.map(async (item) => ({
        title: await titleOf(item.key),
        bytes: item.bytes,
        localOnly: item.bytes > GRID_ITEM_LIMIT,
      })),
    ),
  };
  if (over) {
    await removeRemote();
    return;
  }
  const wanted = keys === undefined ? syncable : syncable.filter((item) => keys.includes(item.key));
  const remote = await browser.storage.sync.get(wanted.map((item) => item.key));
  const items: Record<string, GridDoc> = {};
  for (const item of wanted) {
    const theirs = asDoc(remote[item.key]);
    if (isNewer(item.doc, theirs) && JSON.stringify(theirs) !== JSON.stringify(item.doc)) {
      items[item.key] = item.doc;
    }
  }
  if (Object.keys(items).length > 0) {
    await browser.storage.sync.set(items);
  }
  const tooBig = sizes.filter((item) => item.bytes > GRID_ITEM_LIMIT).map((item) => item.key);
  if (tooBig.length > 0) {
    await removeRemote(tooBig);
  }
}

/** 遠端比較新的那幾份採用進來 */
async function adopt(entries: Iterable<[string, unknown]>): Promise<void> {
  for (const [key, value] of entries) {
    const incoming = key.startsWith(GRID_PREFIX) ? asDoc(value) : null;
    if (incoming === null) {
      continue;
    }
    const local = asDoc((await browser.storage.local.get(key))[key]);
    if (isNewer(incoming, local) && JSON.stringify(incoming) !== JSON.stringify(local)) {
      await browser.storage.local.set({ [key]: incoming });
      broadcast('grid/changed', { folderId: key.slice(GRID_PREFIX.length) });
    }
  }
}

/** 啟動與打開同步時：先拉再推 */
export async function reconcileGridSync(): Promise<void> {
  return exclusive(async () => {
    if (!(await syncEnabled())) {
      return;
    }
    await adopt(Object.entries(await browser.storage.sync.get(null)));
    await upload();
  });
}

/** 關掉「同步書籤的排列與群組」：清掉雲端那幾份（本機的留著） */
export async function clearGridSync(): Promise<void> {
  return exclusive(async () => {
    lastStatus = { over: false, total: 0, folders: [] };
    await removeRemote();
  });
}

export async function gridSyncStatus(): Promise<GridSyncStatus> {
  return {
    available: syncAvailable(),
    enabled: await syncEnabled(),
    budget: GRID_SYNC_BUDGET,
    ...lastStatus,
  };
}

/**
 * 書籤被刪或被搬到別的資料夾：從原本資料夾的格子與群組拿掉；資料夾被刪就整份刪掉。
 * 遠端寫來的格子：較新就採用。啟動時刪掉第 3 期的舊鍵。
 */
export function startGridWatcher(): void {
  browser.bookmarks.onRemoved.addListener((id, info) => {
    void exclusive(async () => {
      const keys = [id, ...folderIdsIn(info.node)].map(gridKey);
      await browser.storage.local.remove(keys);
      if (await syncEnabled()) {
        await removeRemote(keys);
      }
      await forget(info.parentId, new Set([id]));
    });
  });
  browser.bookmarks.onMoved.addListener((id, info) => {
    if (info.parentId === info.oldParentId) {
      return;
    }
    void exclusive(async () => {
      await forget(info.oldParentId, new Set([id]));
    });
  });
  if (syncAvailable()) {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') {
        return;
      }
      const entries = Object.entries(changes)
        .filter(([key, change]) => key.startsWith(GRID_PREFIX) && change.newValue !== undefined)
        .map(([key, change]): [string, unknown] => [key, change.newValue]);
      if (entries.length === 0) {
        return;
      }
      void exclusive(async () => {
        if (await syncEnabled()) {
          await adopt(entries);
        }
      });
    });
  }
  void (async () => {
    const all = await browser.storage.local.get(null);
    const legacy = Object.keys(all).filter((key) => key.startsWith(LEGACY_PREFIX));
    if (legacy.length > 0) {
      await browser.storage.local.remove(legacy);
    }
    await reconcileGridSync();
  })();
}
