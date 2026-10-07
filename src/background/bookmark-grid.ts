import { createSerialQueue } from '@/shared/serial-queue';
import { broadcast } from '@/shared/messages';
import type { BookmarkGrid, GridSyncStatus, StoredGroup } from '@/shared/messages';
import {
  applyOp,
  buildBoard,
  membersInOrder,
  removeItems,
  type Board,
  type GridOp,
} from '@/shared/board';
import {
  EMPTY,
  appendShape,
  decodeCells,
  indexOfId,
  insertPush,
  readingOrder,
  restoreGhosts,
  unmoved,
  type Grid,
} from '@/shared/grid';
import { nextColor, sameName } from '@/shared/groups';
import { t } from '@/shared/i18n';
import { isPreviewableUrl } from '@/shared/url';
import { getSettings } from '@/storage/settings';
import { GRID_ITEM_LIMIT, GRID_PREFIX, GRID_SYNC_BUDGET, gridBytes, gridKey } from '@/storage/grid-sync';
import { deviceId, syncAvailable } from '@/storage/vault-sync';
import { mergeIntoNewFolder, placeBefore } from './bookmark-order';

/**
 * 原生書籤的固定格子與群組（第 3 期改版）。
 *
 * **WebExtension 讀不到 Firefox 原生的標籤**，所以群組與格子是擴充套件自己存的：
 * `storage.local` 的 `grid:<資料夾 guid>`，一個資料夾一份。明文沒有問題 —— 那些本來就是
 * 明文的 Firefox 書籤。
 *
 * - **原生順序 = 格子的閱讀順序**：每次格子變動後把原生書籤搬成那個順序（只搬變了的那幾筆），
 *   擴充套件不在時，Firefox 的書籤選單與書籤管理員裡排列仍然合理。
 * - **跨裝置同步**：同一份也寫進 `storage.sync` 的同名鍵（預設打開，固定預算 20 KB）。
 *   讀到遠端那份時整份較新者勝。Firefox 同步會讓同一個書籤在各台電腦的 GUID 一致，
 *   這是能同步的前提；格子裡指向本機不存在的 GUID 當空格、但不刪掉它的位置
 *   （那筆書籤可能還沒同步過來，見 `restoreGhosts`）。
 * - 「恢復自動排列」寫一份 `columns: 0` 的墓碑而不是刪掉：刪掉的話另一台裝置的舊格子
 *   下次寫入就會傳回來。
 *
 * **所有改動走同一個佇列，連 `onRemoved` / `onMoved` 的清理也是。** 版面操作自己就會
 * 搬書籤，那些搬動觸發的 `onMoved` 若與操作本身交錯，「讀 → 改 → 寫」會互相蓋掉。
 */
const exclusive = createSerialQueue();

/** 第 3 期（還沒發布過）的舊格式。不遷移，啟動時刪掉 */
const LEGACY_PREFIX = 'groups:';

interface GridDoc {
  v: 1;
  /** 0 = 墓碑：這個資料夾恢復成自動排列 */
  columns: number;
  cells: string[];
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
  const cells = decodeCells(doc.cells);
  if (
    doc.v !== 1 ||
    typeof doc.columns !== 'number' ||
    cells === null ||
    !Array.isArray(doc.groups) ||
    typeof doc.updatedAt !== 'number' ||
    typeof doc.deviceId !== 'string'
  ) {
    return null;
  }
  return { ...doc, v: 1, columns: doc.columns, cells, groups: doc.groups.filter(isStoredGroup), updatedAt: doc.updatedAt, deviceId: doc.deviceId };
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

function gridOf(doc: GridDoc | null): Grid | null {
  return doc === null || doc.columns <= 0 ? null : { columns: doc.columns, cells: doc.cells };
}

export async function getBookmarkGrid(folderId: string): Promise<BookmarkGrid | null> {
  const doc = await readDoc(folderId);
  const grid = gridOf(doc);
  return grid === null || doc === null ? null : { ...grid, groups: doc.groups };
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
  live: Set<string>;
}

async function load(folderId: string, autoColumns: number): Promise<Loaded> {
  const doc = await readDoc(folderId);
  const children = await visibleChildren(folderId);
  const groupOf = new Map<string, string>();
  for (const group of doc?.groups ?? []) {
    for (const member of group.members) {
      groupOf.set(member, group.id);
    }
  }
  const board = buildBoard({
    stored: gridOf(doc),
    children: children.map((node) => node.id),
    autoColumns,
    groups: (doc?.groups ?? []).map(({ id, name, color }) => ({ id, name, color })),
    groupOf: (id) => groupOf.get(id) ?? null,
  });
  return {
    doc,
    board,
    links: new Set(children.filter((node) => node.url !== undefined).map((node) => node.id)),
    live: new Set(children.map((node) => node.id)),
  };
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

/** 版面寫回去：格子、群組（成員照閱讀順序）、原生順序 */
async function save(folderId: string, loaded: Loaded, next: Board): Promise<void> {
  const stamp = { v: 1 as const, updatedAt: Date.now(), deviceId: await deviceId() };
  if (!next.fixed) {
    await write(folderId, { ...stamp, columns: 0, cells: [], groups: [] });
    return;
  }
  const stored = gridOf(loaded.doc);
  const grid = stored === null ? next.grid : restoreGhosts(stored, next.grid, loaded.live);
  const groups = next.groups.map((group) => ({ ...group, members: membersInOrder(next, group.id) }));
  await write(folderId, { ...stamp, columns: grid.columns, cells: grid.cells, groups });
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

function requireGroup(board: Board, groupId: string): void {
  if (!board.groups.some((group) => group.id === groupId)) {
    throw new Error(t('group_not_found'));
  }
}

/** 轉成資料夾：在標籤那一格建子資料夾，成員照閱讀順序搬進去。回傳新資料夾 id */
export async function groupToFolder(folderId: string, groupId: string, columns: number): Promise<string> {
  return exclusive(async () => {
    const loaded = await load(folderId, columns);
    requireGroup(loaded.board, groupId);
    const group = loaded.board.groups.find((item) => item.id === groupId);
    const members = membersInOrder(loaded.board, groupId);
    const label = indexOfId(loaded.board.grid, members[0] ?? EMPTY);
    const folder = await browser.bookmarks.create({
      parentId: folderId,
      title: group === undefined || group.name === '' ? t('group_untitled') : group.name,
    });
    for (const id of members) {
      await browser.bookmarks.move(id, { parentId: folder.id });
    }
    const next = removeItems(loaded.board, new Set(members));
    const cells = [...next.grid.cells];
    while (cells.length <= label) {
      cells.push(EMPTY);
    }
    cells[label] = folder.id;
    next.grid = { columns: next.grid.columns, cells };
    loaded.live.add(folder.id);
    await save(folderId, loaded, next);
    return folder.id;
  });
}

/**
 * 攤平成群組：子資料夾裡的書籤搬回上層，從子資料夾原本那一格開始依序放（往後擠），
 * 成為一個同名群組（那裡已有同名的就加入），子資料夾刪掉。子資料夾裡還有資料夾時
 * 拒絕 —— 那些資料夾沒有地方放。
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
    const next = loaded.board;
    next.fixed = true;
    next.grid = insertPush(next.grid, links, at === -1 ? next.grid.cells.length : at);
    let group = next.groups.find((item) => sub.title.trim() !== '' && sameName(item.name, sub.title));
    if (group === undefined) {
      group = { id: crypto.randomUUID(), name: sub.title.trim(), color: nextColor(next.groups) };
      next.groups.push(group);
    }
    for (const id of links) {
      next.memberOf.set(id, group.id);
    }
    await save(parentId, loaded, next);
  });
}

/**
 * 拖群組的標籤到別的資料夾：整組照原形狀搬到那邊最後一列之後；那邊有同名群組就併進去，
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
    requireGroup(source.board, groupId);
    const group = source.board.groups.find((item) => item.id === groupId);
    const members = membersInOrder(source.board, groupId);
    for (const id of members) {
      await browser.bookmarks.move(id, { parentId: toFolderId });
    }
    const memberSet = new Set(members);
    await save(fromFolderId, source, removeItems(source.board, memberSet));

    const target = await load(toFolderId, columns);
    const next = target.board;
    next.fixed = true;
    next.grid = appendShape(next.grid, source.board.grid, memberSet);
    let joined = next.groups.find((item) => group !== undefined && group.name !== '' && sameName(item.name, group.name));
    if (joined === undefined) {
      joined = { id: groupId, name: group?.name ?? '', color: group?.color ?? nextColor(next.groups) };
      next.groups.push(joined);
    }
    for (const id of members) {
      next.memberOf.set(id, joined.id);
    }
    await save(toFolderId, target, next);
  });
}

/** 兩張卡片疊在一起 →「建立資料夾」：新資料夾佔被疊上去那張卡片的格子 */
export async function mergeIntoFolder(targetId: string, ids: readonly string[], title: string): Promise<string> {
  return exclusive(async () => {
    const [target] = await browser.bookmarks.get(targetId);
    const parentId = target?.parentId;
    const loaded = parentId === undefined ? null : await load(parentId, 1);
    const at = loaded === null ? -1 : indexOfId(loaded.board.grid, targetId);
    const id = await mergeIntoNewFolder(targetId, ids, title);
    if (parentId === undefined || loaded === null || !loaded.board.fixed) {
      return id;
    }
    const next = removeItems(loaded.board, new Set([targetId, ...ids]));
    if (at !== -1) {
      const cells = [...next.grid.cells];
      while (cells.length <= at) {
        cells.push(EMPTY);
      }
      cells[at] = id;
      next.grid = { columns: next.grid.columns, cells };
    }
    loaded.live.add(id);
    await save(parentId, loaded, next);
    return id;
  });
}

/** 從某個資料夾的格子與群組裡拿掉幾個 id（被刪、被搬到別的資料夾） */
async function forget(folderId: string, ids: ReadonlySet<string>): Promise<void> {
  const doc = await readDoc(folderId);
  if (doc === null || doc.columns <= 0) {
    return;
  }
  const touched =
    doc.cells.some((id) => ids.has(id)) || doc.groups.some((group) => group.members.some((id) => ids.has(id)));
  if (!touched) {
    return;
  }
  await write(folderId, {
    ...doc,
    cells: doc.cells.map((id) => (ids.has(id) ? EMPTY : id)),
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
