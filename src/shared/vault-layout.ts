import { textDigest } from './vault-merge';

/**
 * 隱私空間的「版面」文件：排列順序（第 3 期再加群組）。
 *
 * **為什麼不直接在 `PrivateBookmark` 上加欄位**（NEXT.md「隱私空間的版面資料」有完整推理）：
 * 舊版的 `sanitizeVaultPayload` 逐欄重建記錄，不認得的欄位一律丟掉；剝掉之後兩邊的
 * 內容指紋永遠對不上，就是「兩秒一輪互相覆蓋」那一類問題。所以版面是**另一份**加密文件，
 * 存在別的鍵上，舊版完全不碰它。
 *
 * **同一個陷阱也不能留給下一個版本。** 文件是「若干區段，每個區段是一張 id → 項目的表」，
 * 每個項目自帶 `updatedAt`，合併規則是**逐項目、較新者勝**，與項目的內容無關。所以這一版
 * 不認得的區段（例如第 3 期的 `groups`）會原封不動地保留、照同一條規則合併 —— 不會有
 * 「舊版把新版的資料剝掉」這回事。
 *
 * `order` 區段：鍵是資料夾 id（最上層用 `ROOT_KEY`），值是那個資料夾裡的完整排列。
 * 一個資料夾一筆而不是一個記錄一筆：在沒排過的資料夾裡挪一張卡片，旁邊的卡片本來就
 * 沒有位置可言，等於整個資料夾都要記下來；一筆一份還省掉每個記錄的時間戳。
 * 代價是兩台裝置在同一個同步週期內各自重排**同一個**資料夾時，後排的那邊整份勝出 ——
 * 掉的只是順序，不是資料。
 */

export const LAYOUT_VERSION = 1;

/** 最上層在 `order` 裡的鍵。不會與 `crypto.randomUUID()` 撞名 */
export const ROOT_KEY = '~root';

export interface LayoutEntry {
  updatedAt: number;
  [field: string]: unknown;
}

export interface FolderOrder extends LayoutEntry {
  ids: string[];
}

export interface VaultLayout {
  version: typeof LAYOUT_VERSION;
  sections: Record<string, Record<string, LayoutEntry>>;
}

export function emptyLayout(): VaultLayout {
  return { version: LAYOUT_VERSION, sections: {} };
}

export function folderKey(folderId: string | null): string {
  return folderId ?? ROOT_KEY;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOrder(entry: LayoutEntry): entry is FolderOrder {
  return Array.isArray(entry.ids) && entry.ids.every((id) => typeof id === 'string');
}

/**
 * 把解出來的 JSON 轉成可信的版面。形狀不對的項目丟掉，不認得的區段保留。
 *
 * 保留不認得的區段是這個格式能向前相容的唯一理由（見檔頭），所以這裡**不能**
 * 寫成「只撿認得的欄位」—— 那正是 `sanitizeVaultPayload` 造成的問題。
 */
export function sanitizeLayout(value: unknown): VaultLayout {
  const layout = emptyLayout();
  const sections = isObject(value) && isObject(value.sections) ? value.sections : {};
  for (const [name, rawSection] of Object.entries(sections)) {
    if (!isObject(rawSection)) {
      continue;
    }
    const section: Record<string, LayoutEntry> = {};
    for (const [id, rawEntry] of Object.entries(rawSection)) {
      if (!isObject(rawEntry)) {
        continue;
      }
      const updatedAt = rawEntry.updatedAt;
      if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) {
        continue;
      }
      // 深拷貝：呼叫端手上的物件不該因為合併而被改到
      const entry = JSON.parse(JSON.stringify(rawEntry)) as LayoutEntry;
      if (name === 'order' && !isOrder(entry)) {
        continue;
      }
      section[id] = entry;
    }
    layout.sections[name] = section;
  }
  return layout;
}

/** 鍵排序後的 JSON：同樣的內容在任何裝置上都是同一個字串 */
function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(',')}]`;
  }
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** 同時間戳時的決勝：比內容字串。只要兩台裝置選的是同一個就好，選哪個不重要 */
function newer(a: LayoutEntry, b: LayoutEntry): LayoutEntry {
  if (a.updatedAt !== b.updatedAt) {
    return a.updatedAt > b.updatedAt ? a : b;
  }
  return stable(a) >= stable(b) ? a : b;
}

/** 逐項目較新者勝。純函式，不改兩個輸入 */
export function mergeLayouts(local: VaultLayout, incoming: VaultLayout): VaultLayout {
  const merged = sanitizeLayout(local);
  const theirs = sanitizeLayout(incoming);
  for (const [name, section] of Object.entries(theirs.sections)) {
    const target = (merged.sections[name] ??= {});
    for (const [id, entry] of Object.entries(section)) {
      const mine = target[id];
      target[id] = mine === undefined ? entry : newer(mine, entry);
    }
  }
  return merged;
}

/**
 * 內容指紋，同步用來判斷「雲端是不是已經是這個內容」。
 *
 * 與 `contentTag` 同一個道理：密文每次加密都不同，不能拿來比。
 */
export async function layoutTag(layout: VaultLayout): Promise<string> {
  return textDigest(stable(layout));
}

// ── 排列 ─────────────────────────────────────────────────────────────

export function folderOrder(layout: VaultLayout, folderId: string | null): readonly string[] | null {
  const entry = layout.sections.order?.[folderKey(folderId)];
  return entry !== undefined && isOrder(entry) ? entry.ids : null;
}

/**
 * 照記下的排列排好一個資料夾的內容。
 *
 * 記錄裡有的照記錄的順序；沒記到的（還沒排過、舊版裝置新增的、別處搬進來的）接在後面，
 * 維持傳進來的順序 —— 呼叫端傳的是原本的預設排序（資料夾依名稱、書籤新的在前），
 * 所以從沒排過的資料夾看起來與以前完全一樣。記錄裡指向已不在這裡的 id 直接略過。
 */
export function orderChildren<T extends { id: string }>(
  items: readonly T[],
  ids: readonly string[] | null,
): T[] {
  if (ids === null || ids.length === 0) {
    return [...items];
  }
  const byId = new Map(items.map((item) => [item.id, item]));
  const placed = new Set<string>();
  const out: T[] = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (item !== undefined && !placed.has(id)) {
      out.push(item);
      placed.add(id);
    }
  }
  for (const item of items) {
    if (!placed.has(item.id)) {
      out.push(item);
    }
  }
  return out;
}

/**
 * 把 `moving` 這幾個 id 挪到 `beforeId` 前面（null = 最後），保持它們原本的相對順序。
 *
 * `current` 是畫面上現在的完整順序。`beforeId` 本身在 `moving` 裡時，往後找第一個
 * 不在 `moving` 裡的當錨點 —— 拖一批卡片放到其中一張的前面，意思是「留在這一帶」。
 */
export function moveIds(
  current: readonly string[],
  moving: readonly string[],
  beforeId: string | null,
): string[] {
  const movingSet = new Set(moving);
  const ordered = current.filter((id) => movingSet.has(id));
  // 不在目前清單裡的（剛從別的資料夾搬進來）接在選取順序後面
  for (const id of moving) {
    if (!current.includes(id) && !ordered.includes(id)) {
      ordered.push(id);
    }
  }
  let anchor = beforeId;
  if (anchor !== null && movingSet.has(anchor)) {
    const start = current.indexOf(anchor);
    anchor = current.slice(start).find((id) => !movingSet.has(id)) ?? null;
  }
  const rest = current.filter((id) => !movingSet.has(id));
  const at = anchor === null ? rest.length : rest.indexOf(anchor);
  const index = at === -1 ? rest.length : at;
  return [...rest.slice(0, index), ...ordered, ...rest.slice(index)];
}

/**
 * 寫入一個資料夾的新排列。只留下 `live` 裡的 id：已刪除、搬走的記錄在這一刻順手清掉，
 * 文件不會一直長大。（合併時不清 —— 那時另一份資料可能還沒傳到，看起來不存在的 id
 * 其實只是還沒到。）
 */
export function withFolderOrder(
  layout: VaultLayout,
  folderId: string | null,
  ids: readonly string[],
  live: ReadonlySet<string>,
  now: number = Date.now(),
): VaultLayout {
  const next = sanitizeLayout(layout);
  const order = (next.sections.order ??= {});
  order[folderKey(folderId)] = { ids: ids.filter((id) => live.has(id)), updatedAt: now };
  return next;
}

export type VaultChild<F, B> = { kind: 'folder'; folder: F } | { kind: 'bookmark'; record: B };

/**
 * 一個隱私資料夾在畫面上的內容與順序。**畫面與背景頁都用這一個**：拖拽送出去的錨點是
 * 「畫面上某張卡片的前面」，兩邊若各算各的順序，放開之後東西會落在別的地方。
 *
 * `folders` / `bookmarks` 要是已經排好預設順序的活記錄（`listFolders` / `listBookmarks`
 * 的輸出：資料夾依名稱、書籤新的在前）。
 */
export function vaultChildren<
  F extends { id: string; parentId: string | null },
  B extends { id: string; folderId: string | null },
>(
  folders: readonly F[],
  bookmarks: readonly B[],
  folderId: string | null,
  layout: VaultLayout,
): VaultChild<F, B>[] {
  const children: (VaultChild<F, B> & { id: string })[] = [
    ...folders
      .filter((folder) => folder.parentId === folderId)
      .map((folder) => ({ kind: 'folder' as const, folder, id: folder.id })),
    ...bookmarks
      .filter((record) => record.folderId === folderId)
      .map((record) => ({ kind: 'bookmark' as const, record, id: record.id })),
  ];
  return orderChildren(children, folderOrder(layout, folderId)).map(
    (child): VaultChild<F, B> =>
      child.kind === 'folder' ? { kind: 'folder', folder: child.folder } : { kind: 'bookmark', record: child.record },
  );
}

export function vaultChildId<F extends { id: string }, B extends { id: string }>(child: VaultChild<F, B>): string {
  return child.kind === 'folder' ? child.folder.id : child.record.id;
}
