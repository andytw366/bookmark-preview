/**
 * 全頁瀏覽的「上一頁」：把資料夾巡覽接到瀏覽器的歷史紀錄上。
 *
 * 書籤這邊照一般網頁的做法，網址帶 `#folder=<guid>`、`history.state` 放 `{ f }`，
 * 重新整理或把網址存起來再開都停在同一個資料夾。
 *
 * **隱私空間不能這樣做。** Firefox 的 session restore 會把每個分頁的歷史項目
 * （網址與 state）寫到磁碟，`vaultEntry: 'hidden'` 的隱密性會因此破功。所以隱私
 * 空間裡的歷史項目只放一個隨機代號 `{ n }`、網址不帶 hash，代號對應到哪個資料夾
 * 只記在記憶體（`VaultTokens`），上鎖時清空。拿到不認得的代號一律退回書籤最上層。
 */

/** 畫面停在哪裡 —— 一筆歷史項目要還原的全部資訊 */
export type GalleryPlace =
  | { mode: 'bookmarks'; folderId: string | null }
  | { mode: 'vault'; folderId: string | null };

/** 寫進 `history.state` 的形狀。隱私空間那一種只有代號 */
export type HistoryState = { f: string | null } | { n: string };

const FOLDER_PREFIX = '#folder=';

/** `#folder=<guid>` → guid；其他（含空 hash、壞掉的編碼）都當最上層 */
export function parseFolderHash(hash: string): string | null {
  if (!hash.startsWith(FOLDER_PREFIX)) {
    return null;
  }
  try {
    const id = decodeURIComponent(hash.slice(FOLDER_PREFIX.length));
    return id === '' ? null : id;
  } catch {
    return null;
  }
}

/** 最上層不帶 hash，網址保持乾淨 */
export function folderHash(folderId: string | null): string {
  return folderId === null ? '' : `${FOLDER_PREFIX}${encodeURIComponent(folderId)}`;
}

export function samePlace(a: GalleryPlace, b: GalleryPlace): boolean {
  return a.mode === b.mode && a.folderId === b.folderId;
}

/**
 * 這次導覽要怎麼寫歷史。
 *
 * - 使用者的動作（點卡片、麵包屑、↑、Backspace、切換空間）→ `push`，上一頁才回得來
 * - 程式自己退回（所在的資料夾被刪了）→ `replace`，否則上一頁會回到一個不存在的地方
 *   然後又被退回來，看起來像上一頁壞了
 * - 目的地就是現在的位置 → 什麼都不寫，連點兩次同一個麵包屑不該多出一筆
 */
export function historyStep(
  from: GalleryPlace,
  to: GalleryPlace,
  reason: 'user' | 'fallback',
): 'push' | 'replace' | 'none' {
  if (samePlace(from, to)) {
    return 'none';
  }
  return reason === 'user' ? 'push' : 'replace';
}

/** 解讀 `history.state`：不是我們寫的形狀就回 null */
export function readHistoryState(state: unknown): HistoryState | null {
  if (typeof state !== 'object' || state === null) {
    return null;
  }
  const record = state as Record<string, unknown>;
  if (typeof record.n === 'string') {
    return { n: record.n };
  }
  if (record.f === null || typeof record.f === 'string') {
    return { f: record.f };
  }
  return null;
}

/**
 * 隱私空間歷史項目的代號表，只活在記憶體裡。
 *
 * 代號是隨機的，不是遞增的序號 —— 序號會透露「在隱私空間裡點了幾次」。
 */
export class VaultTokens {
  private readonly places = new Map<string, string | null>();

  constructor(private readonly random: () => string = () => crypto.randomUUID()) {}

  issue(folderId: string | null): string {
    const token = this.random();
    this.places.set(token, folderId);
    return token;
  }

  /** 認得就回隱私資料夾 id（`null` 是隱私空間最上層），不認得回 `undefined` */
  resolve(token: string): string | null | undefined {
    return this.places.has(token) ? this.places.get(token) : undefined;
  }

  clear(): void {
    this.places.clear();
  }
}

/**
 * 一個位置要寫成什麼樣的歷史項目。
 *
 * 隱私空間的網址一律不帶 hash：從書籤的某個資料夾切過去時，也不要讓
 * `#folder=` 留在網址列上，免得看起來像停在書籤那邊。
 */
export function historyEntry(
  place: GalleryPlace,
  tokens: VaultTokens,
): { state: HistoryState; hash: string } {
  if (place.mode === 'vault') {
    return { state: { n: tokens.issue(place.folderId) }, hash: '' };
  }
  return { state: { f: place.folderId }, hash: folderHash(place.folderId) };
}

/**
 * 上一頁／下一頁回到某筆項目時，要停在哪裡。
 *
 * 代號不認得（上鎖後代號表清空、或重新整理後記憶體沒了）→ 書籤最上層，
 * 不是解鎖畫面 —— 隱密模式下跳出解鎖畫面就等於承認隱私空間存在。
 * 書籤那邊以網址的 hash 為準，使用者手改網址列也照樣有效。
 */
export function placeFromHistory(
  state: unknown,
  hash: string,
  tokens: VaultTokens,
  vaultUnlocked: boolean,
): { place: GalleryPlace; known: boolean } {
  const parsed = readHistoryState(state);
  if (parsed !== null && 'n' in parsed) {
    const folderId = vaultUnlocked ? tokens.resolve(parsed.n) : undefined;
    if (folderId === undefined) {
      return { place: { mode: 'bookmarks', folderId: null }, known: false };
    }
    return { place: { mode: 'vault', folderId }, known: true };
  }
  return { place: { mode: 'bookmarks', folderId: parseFolderHash(hash) }, known: true };
}
