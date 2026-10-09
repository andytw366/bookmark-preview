import { t } from './i18n';
import type { PrivateBookmark, PrivateFolder, VaultPayload } from './types';

/**
 * 隱私空間的逐筆合併。
 *
 * 匯入備份檔與 storage.sync 同步走的是同一段邏輯：兩邊都是「本機有一份、外面
 * 來了一份，要合成一份」。刻意寫成不碰 storage 也不碰加密的純函式，因為這是
 * 整個 M4 最容易靜默弄丟資料的地方 —— 純函式才能把每條規則都用測試釘住。
 *
 * 合併規則：
 *
 * 1. 以 `id` 為鍵。id 是 `crypto.randomUUID()`，兩台裝置各自新增不會撞號，
 *    所以「同一個 id」必然是同一筆記錄的兩個版本。
 * 2. 一般衝突取 `updatedAt` 較大者。
 * 3. **墓碑優先**：任一邊已刪除就維持刪除，不看時間。這條刻意違反「較新者勝」——
 *    使用者刪掉一筆之後，另一台裝置的舊編輯把它救回來，表現是「以為刪了卻復活」，
 *    那比「刪錯了要重新加一次書籤」嚴重得多（尤其這是隱私書籤）。
 * 4. 合併完要正規化：父項在合併後不存在的記錄拉回最上層，環狀 parentId 打斷。
 *    兩台裝置分別搬動資料夾就足以造出這兩種狀態，而它們的症狀是「書籤還在資料
 *    裡但畫面上永遠看不到」——那和弄丟沒有差別。
 */

/** 墓碑保留期限：超過就實體刪除。太短會讓刪除在下次同步時復活。 */
export const TOMBSTONE_TTL_MS = 30 * 86_400_000;

/** parentId 鏈的深度上限，同時是「這條鏈是不是環」的判定界線。 */
const MAX_DEPTH = 32;

export interface MergeCounts {
  added: number;
  updated: number;
}

export interface MergeReport {
  bookmarks: MergeCounts;
  folders: MergeCounts;
  /** 因為父項在合併後不存在（或成環）而被移到最上層的筆數 */
  reattached: number;
}

export interface MergeResult {
  payload: VaultPayload;
  report: MergeReport;
}

interface Versioned {
  id: string;
  updatedAt: number;
  deleted?: true;
}

/** 兩個版本取一。規則見本檔開頭第 2、3 條。 */
function pickWinner<T extends Versioned>(mine: T, theirs: T): T {
  const mineDead = mine.deleted === true;
  const theirsDead = theirs.deleted === true;
  if (mineDead !== theirsDead) {
    return mineDead ? mine : theirs;
  }
  return theirs.updatedAt > mine.updatedAt ? theirs : mine;
}

function mergeById<T extends Versioned>(
  local: readonly T[],
  incoming: readonly T[],
): { items: T[]; counts: MergeCounts } {
  // 複製每一筆：合併不該改動呼叫端手上的物件（本機那份可能還是解鎖中的 payload）
  const byId = new Map<string, T>(local.map((item) => [item.id, { ...item }]));
  let added = 0;
  let updated = 0;

  for (const item of incoming) {
    const mine = byId.get(item.id);
    if (mine === undefined) {
      byId.set(item.id, { ...item });
      added += 1;
      continue;
    }
    if (pickWinner(mine, item) !== mine) {
      byId.set(item.id, { ...item });
      updated += 1;
    }
  }

  return { items: [...byId.values()], counts: { added, updated } };
}

/** 從 `id` 沿 parentId 往上走，是否走不出去（成環或深度異常）。 */
function isTangled(folders: readonly PrivateFolder[], id: string): boolean {
  let cursor = folders.find((folder) => folder.id === id)?.parentId ?? null;
  for (let depth = 0; cursor !== null; depth += 1) {
    if (cursor === id || depth >= MAX_DEPTH) {
      return true;
    }
    cursor = folders.find((folder) => folder.id === cursor)?.parentId ?? null;
  }
  return false;
}

/**
 * 把指不到活資料夾的 parentId / folderId 拉回最上層，並打斷環。
 *
 * 回傳被動到的筆數。這個數字要顯示給使用者：它代表「有東西的位置變了」，
 * 而不是靜靜地把幾百筆書籤藏進看不到的角落。
 */
function normalize(payload: VaultPayload): number {
  const live = new Set(
    payload.folders.filter((folder) => folder.deleted !== true).map((folder) => folder.id),
  );
  let reattached = 0;

  for (const folder of payload.folders) {
    if (folder.deleted !== true && folder.parentId !== null && !live.has(folder.parentId)) {
      folder.parentId = null;
      reattached += 1;
    }
  }

  // 環的偵測要在孤兒處理之後：父項不存在時往上走本來就會停，兩者混在一起判不準。
  // 打斷環上的任一個節點，同一個環的其他成員就走得出去了，所以每個環只會計一次。
  for (const folder of payload.folders) {
    if (folder.deleted !== true && folder.parentId !== null && isTangled(payload.folders, folder.id)) {
      folder.parentId = null;
      reattached += 1;
    }
  }

  for (const record of payload.bookmarks) {
    if (record.deleted !== true && record.folderId !== null && !live.has(record.folderId)) {
      record.folderId = null;
      reattached += 1;
    }
  }

  return reattached;
}

export function mergeVaults(
  local: VaultPayload,
  incoming: VaultPayload,
  now: number = Date.now(),
): MergeResult {
  const bookmarks = mergeById<PrivateBookmark>(local.bookmarks, incoming.bookmarks);
  const folders = mergeById<PrivateFolder>(local.folders, incoming.folders);
  const payload: VaultPayload = {
    version: 1,
    bookmarks: bookmarks.items,
    folders: folders.items,
  };
  const reattached = normalize(payload);
  pruneTombstones(payload, now);
  return {
    payload,
    report: { bookmarks: bookmarks.counts, folders: folders.counts, reattached },
  };
}

/**
 * 清掉過期的墓碑（就地修改）。
 *
 * 只能在合併之後做：先清掉再合併的話，對方那份還帶著原始記錄，剛清掉的刪除
 * 就會被當成「本機沒有的新記錄」加回來。
 */
export function pruneTombstones(
  payload: VaultPayload,
  now: number = Date.now(),
  ttlMs: number = TOMBSTONE_TTL_MS,
): void {
  const cutoff = now - ttlMs;
  payload.bookmarks = payload.bookmarks.filter(
    (record) => record.deleted !== true || record.updatedAt >= cutoff,
  );
  payload.folders = payload.folders.filter(
    (record) => record.deleted !== true || record.updatedAt >= cutoff,
  );
}

// ── 外來資料的清洗 ────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asParent(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 把「解出來的 JSON」轉成可信的 `VaultPayload`，丟掉形狀不對的記錄。
 *
 * 備份檔是使用者手上的一個檔案，可能被編輯器改壞、被截斷、或是另一個版本的
 * 格式。少了這一層，一筆 `updatedAt: null` 就會讓合併的比較全部變成 false，
 * 表現成「匯入成功但什麼都沒進來」而且完全沒有線索。
 *
 * 刻意用「丟掉壞的、留下好的」而不是整批拒絕：備份檔是最後一道防線，能救回
 * 九成也遠勝於因為一筆壞資料而全部救不回來。
 */
export function sanitizeVaultPayload(value: unknown): VaultPayload {
  const source = isObject(value) ? value : {};
  const rawBookmarks = Array.isArray(source.bookmarks) ? source.bookmarks : [];
  const rawFolders = Array.isArray(source.folders) ? source.folders : [];

  const bookmarks: PrivateBookmark[] = [];
  for (const item of rawBookmarks) {
    if (!isObject(item)) {
      continue;
    }
    const id = asText(item.id);
    const url = asText(item.url);
    const updatedAt = asTime(item.updatedAt);
    if (id === null || url === null || updatedAt === null) {
      continue;
    }
    const record: PrivateBookmark = {
      id,
      url,
      title: typeof item.title === 'string' ? item.title : '',
      folderId: asParent(item.folderId),
      createdAt: asTime(item.createdAt) ?? updatedAt,
      updatedAt,
    };
    if (item.preview === 'icon' || item.preview === 'page') {
      record.preview = item.preview;
    }
    if (item.deleted === true) {
      record.deleted = true;
    }
    bookmarks.push(record);
  }

  const folders: PrivateFolder[] = [];
  for (const item of rawFolders) {
    if (!isObject(item)) {
      continue;
    }
    const id = asText(item.id);
    const updatedAt = asTime(item.updatedAt);
    if (id === null || updatedAt === null) {
      continue;
    }
    const record: PrivateFolder = {
      id,
      name: typeof item.name === 'string' ? item.name : t('vault_untitled_folder'),
      parentId: asParent(item.parentId),
      updatedAt,
    };
    if (item.deleted === true) {
      record.deleted = true;
    }
    folders.push(record);
  }

  return { version: 1, bookmarks, folders };
}

// ── 內容指紋 ──────────────────────────────────────────────────────────

/**
 * 把 payload 攤成一個與寫入順序無關的字串。
 *
 * 兩台裝置的陣列順序不會一致（合併是用 Map 收斂的，順序取決於誰先誰後），
 * 所以先按 id 排序；欄位也逐一列出而不是 `JSON.stringify(record)`，因為物件的
 * 鍵順序取決於它是怎麼被建出來的。
 */
function canonical(payload: VaultPayload): string {
  const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const bookmarks = [...payload.bookmarks]
    .sort(byId)
    .map((r) =>
      JSON.stringify([
        r.id,
        r.url,
        r.title,
        r.folderId,
        r.createdAt,
        r.updatedAt,
        r.deleted === true,
        // 只在有值時才加：沒選過的書籤指紋與加這個欄位之前一樣，升級後同步不會整份重寫
        ...(r.preview === undefined ? [] : [r.preview]),
      ]),
    );
  const folders = [...payload.folders]
    .sort(byId)
    .map((r) => JSON.stringify([r.id, r.name, r.parentId, r.updatedAt, r.deleted === true]));
  return JSON.stringify([payload.version, bookmarks, folders]);
}

/**
 * 內容指紋：同樣的內容在任何裝置上都得到同一個值。
 *
 * 同步需要判斷「本機與雲端的內容是不是已經一樣」，而**密文比對做不到這件事**：
 * 每次加密都用新的 IV，同一份資料每次加密的位元組都不同。若用密文判斷，兩台
 * 裝置會輪流認定「雲端跟我不一樣」而把對方的副本覆蓋掉，覆蓋又觸發對方再覆蓋
 * 一次 —— 一個永遠停不下來的來回寫入。指紋讓「內容相同」有一個穩定的答案。
 *
 * 不需要抗碰撞攻擊（這不是驗證），但 SHA-256 免費且省得自己想雜湊函式。
 * 只取前 16 bytes：夠短，放進 storage.sync 的中介資料不佔配額。
 */
export async function contentTag(payload: VaultPayload): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(payload)));
  return hex(new Uint8Array(digest).subarray(0, 16));
}

/** 位元組轉十六進位字串。同步的中介資料是 JSON，放 hex 比 base64 少一層轉義顧慮。 */
export function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/** 對整段字串取指紋。同步用它判斷「塊有沒有湊齊、而且是同一代的」。 */
export async function textDigest(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return hex(new Uint8Array(digest).subarray(0, 16));
}

/** 活著的筆數。用於「採用整份備份」時回報進來多少東西。 */
export function countAlive(payload: VaultPayload): MergeReport {
  return {
    bookmarks: { added: payload.bookmarks.filter((item) => item.deleted !== true).length, updated: 0 },
    folders: { added: payload.folders.filter((item) => item.deleted !== true).length, updated: 0 },
    reattached: 0,
  };
}
