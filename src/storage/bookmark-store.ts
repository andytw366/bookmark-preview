import { fromBase32, toBase32 } from '@/crypto/base32';
import type { Bytes } from '@/crypto/bytes';
import { t } from '@/shared/i18n';
import { PACK_META_KEY } from './pack-sync';

/**
 * 隱私空間的雲端副本放在書籤裡（「改用書籤同步」打開時）。`storage.sync` 只有 100 KB，
 * 書籤同步沒有這個上限 —— 代價是密文會出現在使用者的書籤資料夾裡，所以要盡量不礙眼。
 *
 * ```
 * 其他書籤
 * └─ 書籤預覽：隱私空間的同步資料（請勿修改）
 *    ├─ (無標題)  data:,<base32>     第 i 塊：1 byte 塊號 + 至多 37,499 bytes 密文
 *    └─ ...
 * ```
 *
 * 中介資料（salt、包裹、塊數、digest、指紋）仍在 `storage.sync` 的 `vaultPack`，多帶
 * `store: 'bookmarks'` 與資料夾 id（`storage/pack-sync`）。兩條同步彼此獨立，meta 先到、
 * 書籤後到是常態 —— 讀到的塊湊不齊或 digest 對不上一律當成傳輸中。
 *
 * 實測過的限制（Firefox 153，NEXT.md 有表）決定了這裡的每個數字與寫法：
 *
 * - 網址總長上限 65,536，超過就 `Invalid bookmark` → 每塊 ≤ 60,000 字元。
 * - 標題會截到 4,096 字元 → 資料只能放網址；標題也會被網址列比對 → **留空**。
 * - base91 進 `data:` 會被改寫 → 用只有英數字的 base32（`crypto/base32` 檔頭）。
 * - 同步合併可能重排書籤 → **順序不靠位置**，每塊明文開頭放 1 byte 的塊號。
 */
export const SYNC_FOLDER_LOCAL_KEY = 'vaultSyncFolderId';

/** 37,499 + 1 byte 塊號 = 37,500 bytes = 60,000 個 base32 字元，剛好不用補位 */
export const BOOKMARK_CHUNK_BYTES = 37_499;
/** 塊號只有 1 byte。256 塊約 9.6 MB 密文，遠超過實際會用到的量 */
export const BOOKMARK_CHUNK_LIMIT = 256;

const DATA_PREFIX = 'data:,';
const UNFILED = 'unfiled_____';

/**
 * 找資料夾時認得的標題。兩種語言都要認：A 用中文介面建的資料夾，B 用英文介面也要找得到。
 * 這兩串要與 `_locales` 裡的 `sync_bookmarks_folder_title` 一致 —— 改文案就要一起改。
 */
const FOLDER_TITLES = [
  '書籤預覽：隱私空間的同步資料（請勿修改）',
  'Bookmark Preview: vault sync data (do not edit)',
];

// ── 切塊與接回（純函式，單元測試直接測） ─────────────────────────────

/** 密文 → 一筆筆書籤的網址 */
export function toBookmarkChunks(bytes: Bytes): string[] {
  const count = Math.ceil(bytes.length / BOOKMARK_CHUNK_BYTES);
  if (count > BOOKMARK_CHUNK_LIMIT) {
    throw new Error(t('sync_bookmarks_too_large', Math.ceil(bytes.length / 1024 / 1024)));
  }
  const urls: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const body = bytes.subarray(index * BOOKMARK_CHUNK_BYTES, (index + 1) * BOOKMARK_CHUNK_BYTES);
    const chunk = new Uint8Array(body.length + 1);
    chunk[0] = index;
    chunk.set(body, 1);
    urls.push(`${DATA_PREFIX}${toBase32(chunk)}`);
  }
  return urls;
}

/**
 * 一筆筆書籤的網址 → 密文。湊不齊（缺塊、多塊、塊號重複、內容不是我們的格式）回 null ——
 * 呼叫端當成傳輸中，不當成損毀：書籤同步逐筆到，半途看到的就是這個樣子。
 */
export function fromBookmarkChunks(urls: readonly string[], expected: number): Bytes | null {
  if (urls.length !== expected || expected <= 0) {
    return null;
  }
  const parts = new Array<Bytes | undefined>(expected);
  for (const url of urls) {
    if (!url.startsWith(DATA_PREFIX)) {
      return null;
    }
    let chunk: Bytes;
    try {
      chunk = fromBase32(url.slice(DATA_PREFIX.length));
    } catch {
      return null;
    }
    const index = chunk[0];
    if (index === undefined || index >= expected || parts[index] !== undefined) {
      return null;
    }
    parts[index] = chunk.subarray(1);
  }
  let total = 0;
  for (const part of parts) {
    if (part === undefined) {
      return null;
    }
    total += part.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts as Bytes[]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// ── 資料夾 id 的快取 ────────────────────────────────────────────────

/*
 * 兩個來源：雲端 meta 帶的 folderId（別台裝置建的，Firefox 同步保留 GUID，所以這台的 id 相同）
 * 與本機記住的（自己建的、或用標題找到的）。兩個都算 —— 切換存放位置的過程中兩者可能短暫不同，
 * 寧可多藏一個資料夾也不要讓同步資料露出來、或讓每次推送都觸發側邊欄重整。
 */
let metaFolderId: string | null = null;
let localFolderId: string | null = null;
/**
 * 第三個來源：「其他書籤」底下標題是同步資料夾名稱的資料夾。
 *
 * 給「書籤比 meta 先到」的那台裝置：書籤同步把資料夾帶過來了，`storage.sync` 的 meta 還沒到，
 * 前兩個來源都沒有它的 id —— 少了這個，資料夾會在側邊欄露出來，直到 meta 到達。
 */
const titledFolderIds = new Set<string>();
let cacheStarted = false;

function isFolderTitle(title: string): boolean {
  return FOLDER_TITLES.includes(title) || title === t('sync_bookmarks_folder_title');
}

function isTitledFolder(node: { parentId?: string | undefined; url?: string | undefined; title: string }): boolean {
  return node.parentId === UNFILED && node.url === undefined && isFolderTitle(node.title);
}

/** 重新掃一次「其他書籤」底下的標題 */
async function scanTitledFolders(): Promise<void> {
  try {
    const children = await browser.bookmarks.getChildren(UNFILED);
    titledFolderIds.clear();
    for (const node of children) {
      if (isTitledFolder(node)) {
        titledFolderIds.add(node.id);
      }
    }
  } catch {
    // 沒有「其他書籤」（理論上不會）：只靠前兩個來源
  }
}

function watchTitledFolders(): void {
  browser.bookmarks.onCreated.addListener((id, node) => {
    if (isTitledFolder(node)) {
      titledFolderIds.add(id);
    }
  });
  browser.bookmarks.onRemoved.addListener((id) => {
    titledFolderIds.delete(id);
  });
  // 改名、搬移：重讀那一筆（事件不帶完整的節點）
  const recheck = (id: string): void => {
    void browser.bookmarks.get(id).then(
      ([node]) => {
        if (node !== undefined && isTitledFolder(node)) {
          titledFolderIds.add(id);
        } else {
          titledFolderIds.delete(id);
        }
      },
      () => undefined,
    );
  };
  browser.bookmarks.onChanged.addListener((id, info) => {
    if (info.title !== undefined && (isFolderTitle(info.title) || titledFolderIds.has(id))) {
      recheck(id);
    }
  });
  browser.bookmarks.onMoved.addListener((id, info) => {
    if (info.parentId === UNFILED || info.oldParentId === UNFILED) {
      recheck(id);
    }
  });
}

function folderIdOfMeta(value: unknown): string | null {
  const meta = value as { store?: unknown; folderId?: unknown } | undefined;
  return meta?.store === 'bookmarks' && typeof meta.folderId === 'string' ? meta.folderId : null;
}

async function readMetaFolderId(): Promise<string | null> {
  try {
    const stored = await browser.storage.sync.get(PACK_META_KEY);
    return folderIdOfMeta(stored[PACK_META_KEY]);
  } catch {
    // storage.sync 被企業政策關掉之類：只剩本機記住的那個
    return null;
  }
}

async function readLocalFolderId(): Promise<string | null> {
  const stored = await browser.storage.local.get(SYNC_FOLDER_LOCAL_KEY);
  const value = stored[SYNC_FOLDER_LOCAL_KEY];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 背景啟動時呼叫一次：載入快取並開始跟著 storage 的變動更新。
 *
 * 跟著 `storage.onChanged` 而不是只在自己寫入時更新：meta 是別台裝置透過 `storage.sync`
 * 送來的，這台什麼都沒做，快取也得知道新的資料夾 id，否則書籤同步把那個資料夾帶過來時
 * 側邊欄會把它顯示出來。
 */
export async function initSyncFolderCache(): Promise<void> {
  if (!cacheStarted) {
    cacheStarted = true;
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && SYNC_FOLDER_LOCAL_KEY in changes) {
        const value = changes[SYNC_FOLDER_LOCAL_KEY]?.newValue;
        localFolderId = typeof value === 'string' && value !== '' ? value : null;
      }
      if (area === 'sync' && PACK_META_KEY in changes) {
        metaFolderId = folderIdOfMeta(changes[PACK_META_KEY]?.newValue);
      }
    });
    watchTitledFolders();
  }
  [metaFolderId, localFolderId] = await Promise.all([readMetaFolderId(), readLocalFolderId(), scanTitledFolders()]);
}

/** 同步版，給過濾用（樹的走訪、書籤事件）。快取還沒載入時一律 false */
export function isSyncFolderIdSync(id: string): boolean {
  return id === metaFolderId || id === localFolderId || titledFolderIds.has(id);
}

/** 先看雲端 meta（store bookmarks 的 folderId），再看本機記住的。不保證那個資料夾還在 */
export async function syncFolderId(): Promise<string | null> {
  return (await readMetaFolderId()) ?? (await readLocalFolderId());
}

async function rememberFolder(id: string | null): Promise<void> {
  localFolderId = id;
  if (id === null) {
    await browser.storage.local.remove(SYNC_FOLDER_LOCAL_KEY);
  } else if ((await readLocalFolderId()) !== id) {
    await browser.storage.local.set({ [SYNC_FOLDER_LOCAL_KEY]: id });
  }
}

// ── 讀、寫、刪 ──────────────────────────────────────────────────────

async function folderExists(id: string): Promise<boolean> {
  try {
    const [node] = await browser.bookmarks.get(id);
    return node !== undefined && node.url === undefined;
  } catch {
    return false;
  }
}

/**
 * 找同步資料夾：先用指定的 id（meta 帶的），再用本機記住的，最後用標題在「其他書籤」底下找。
 * 標題那一步是給「id 對不上」的情況：例如使用者在書籤管理員裡剪下貼上過，或匯出匯入過。
 */
export async function findSyncFolder(preferred?: string | null): Promise<string | null> {
  for (const id of [preferred ?? null, await readLocalFolderId()]) {
    if (id !== null && (await folderExists(id))) {
      await rememberFolder(id);
      return id;
    }
  }
  let children: browser.bookmarks.BookmarkTreeNode[];
  try {
    children = await browser.bookmarks.getChildren(UNFILED);
  } catch {
    return null;
  }
  const found = children.find((node) => node.url === undefined && isFolderTitle(node.title));
  if (found === undefined) {
    return null;
  }
  await rememberFolder(found.id);
  return found.id;
}

/**
 * 從書籤讀回密文，回傳它的 base32（digest 就是用這串算的，見 `writeBookmarkChunks`）。
 * 資料夾不在、塊湊不齊都回 null（傳輸中）。
 */
export async function readBookmarkChunks(folderId: string, expected: number): Promise<string | null> {
  const found = await findSyncFolder(folderId);
  if (found === null) {
    return null;
  }
  const children = await browser.bookmarks.getChildren(found);
  const urls = children.flatMap((node) => (node.url === undefined ? [] : [node.url]));
  const bytes = fromBookmarkChunks(urls, expected);
  return bytes === null ? null : toBase32(bytes);
}

export interface BookmarkWrite {
  folderId: string;
  chunks: number;
  /** 接回後的 base32，用來算 digest —— 與讀的那邊算法一致 */
  text: string;
}

/**
 * 把密文寫進同步資料夾。資料夾不在就在「其他書籤」底下建。
 *
 * 既有的書籤用 `update` 換網址而不是全刪重建：刪一筆、建一筆在書籤同步裡是兩筆紀錄，
 * 而且新的那筆是新 GUID，別台裝置得先刪後建，中間更容易看到湊不齊的狀態。
 */
export async function writeBookmarkChunks(bytes: Bytes): Promise<BookmarkWrite> {
  const urls = toBookmarkChunks(bytes);
  let folderId = await findSyncFolder(metaFolderId);
  if (folderId === null) {
    const folder = await browser.bookmarks.create({ parentId: UNFILED, title: t('sync_bookmarks_folder_title') });
    folderId = folder.id;
    await rememberFolder(folderId);
  }
  const children = await browser.bookmarks.getChildren(folderId);
  const existing = children.filter((node) => node.url !== undefined);
  for (const [index, url] of urls.entries()) {
    const node = existing[index];
    if (node === undefined) {
      await browser.bookmarks.create({ parentId: folderId, title: '', url });
    } else if (node.url !== url || node.title !== '') {
      await browser.bookmarks.update(node.id, { title: '', url });
    }
  }
  // 多的書籤，以及使用者塞進來的子資料夾：都不是我們的資料，留著只會讓「湊不齊」更難判斷
  for (const node of existing.slice(urls.length)) {
    await browser.bookmarks.remove(node.id);
  }
  for (const node of children.filter((child) => child.url === undefined)) {
    await browser.bookmarks.removeTree(node.id);
  }
  return { folderId, chunks: urls.length, text: toBase32(bytes) };
}

/** 刪掉整個同步資料夾（存放位置改回 `storage.sync`、或移除雲端副本時） */
export async function removeSyncFolder(preferred?: string | null): Promise<void> {
  const folderId = await findSyncFolder(preferred ?? (await readMetaFolderId()));
  if (folderId !== null) {
    await browser.bookmarks.removeTree(folderId);
  }
  await rememberFolder(null);
}
