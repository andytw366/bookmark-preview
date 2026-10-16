import type { Bytes } from '@/crypto/bytes';
import { fromChunks } from '@/crypto/chunk';
import type { VaultMeta } from '@/shared/types';
import { textDigest } from '@/shared/vault-merge';
import { readBookmarkChunks, removeSyncFolder, writeBookmarkChunks } from './bookmark-store';
import { clearSyncGone, syncAvailable } from './vault-sync';

/**
 * `storage.sync` 上的隱私空間（1.3.0 之後的版本）：書籤與版面合成**一份**精簡編碼的密文
 * （格式在 `shared/sync-pack`）。
 *
 * ```
 * vaultPack     中介資料（明文）：整份 VaultMeta / 塊數 / digest / 兩個內容指紋
 * vaultPackC0   加密 base64 的第 0 塊
 * ```
 *
 * 取代 1.3.x 以前的 `vaultSync*`（書籤）與 `vaultLayout*`（版面）。那兩組鍵還留著讀取與清除的
 * 程式碼：新版讀到就合併進來、推上新格式之後刪掉（`background/vault-sync`）。鍵名**不能以
 * `vaultSyncC` 或 `vaultLayoutC` 開頭** —— 舊版會把那兩個前綴的鍵全部當殘塊刪掉。
 *
 * 其餘規則（先塊後 meta、digest 判斷塊是否湊齊、tag 判斷內容是否相同、VaultMeta 為什麼明文）
 * 與舊格式一樣，理由寫在 `storage/vault-sync` 的檔頭。
 */
export const PACK_META_KEY = 'vaultPack';
export const PACK_CHUNK_PREFIX = 'vaultPackC';
/**
 * 中介資料的版本，也就是「塊怎麼解」：
 *
 * - 1：base64 的密文，裡面是第 1 版的精簡編碼（只出現在沒有上架的建置裡）
 * - 2：base91 的密文（`crypto/base91`），裡面是第 2 版的精簡編碼
 * - 3：塊放在書籤裡（`storage/bookmark-store`，base32），`store: 'bookmarks'` 與 `folderId` 必填。
 *   **只有放書籤時才寫 3**；放 `storage.sync` 時照寫 2，讓沒打開書籤同步的人不必所有裝置一起更新
 *
 * **改格式就要升這個數字。** 看到比自己新的版本，舊版會停下來等（`isPackMeta` 不認得 → 當成傳輸中），
 * 而不是把解不開的東西當成「雲端壞了」拿本機那份蓋過去 —— 那會讓還沒更新的裝置每一輪都覆蓋雲端。
 */
export const PACK_META_VERSION = 3;
/** 塊放在 `storage.sync` 時寫的版本 */
export const PACK_META_VERSION_SYNC = 2;

/** 雲端那份的塊放在哪裡。這是**雲端那份**的屬性（寫在 meta 裡），不是每台裝置各自的設定 */
export type PackStore = 'sync' | 'bookmarks';

export interface PackSyncMeta {
  version: 1 | typeof PACK_META_VERSION_SYNC | typeof PACK_META_VERSION;
  /** 只在 version 3 出現 */
  store?: 'bookmarks';
  /** 同步資料夾的 id（Firefox 同步保留 GUID，各裝置相同；對不上時用標題找） */
  folderId?: string;
  vault: VaultMeta;
  chunks: number;
  digest: string;
  /** 書籤的內容指紋（`contentTag`） */
  tag: string;
  /** 版面的內容指紋（`layoutTag`） */
  layoutTag: string;
  updatedAt: number;
  deviceId: string;
}

export type PackSyncRead =
  | { kind: 'absent' }
  /**
   * 塊沒到齊、新舊混雜，或 meta 還沒到（`meta` 為 null）。稍後會自己好，不能覆蓋。
   * `newer`：meta 是更新版本的擴充套件寫的 —— 不會自己好，要更新這台
   */
  | { kind: 'partial'; meta: PackSyncMeta | null; newer?: true }
  /**
   * `blob` 是塊接回來的文字：`storage.sync` 是 base91（version 1 是 base64），書籤是 base32。
   * 怎麼解看 `meta.version`（`background/vault` 的 `openPack`）
   */
  | { kind: 'ok'; meta: PackSyncMeta; blob: string };

export function packStoreOf(meta: Pick<PackSyncMeta, 'store'>): PackStore {
  return meta.store === 'bookmarks' ? 'bookmarks' : 'sync';
}

function chunkKeys(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${PACK_CHUNK_PREFIX}${String(index)}`);
}

export function isPackMeta(value: unknown): value is PackSyncMeta {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const meta = value as Partial<PackSyncMeta>;
  const vault = meta.vault as Partial<VaultMeta> | undefined;
  // 第 3 版一定在書籤裡、一定有資料夾 id；第 1、2 版一定在 storage.sync。混搭的當成看不懂
  const where =
    meta.version === PACK_META_VERSION
      ? meta.store === 'bookmarks' && typeof meta.folderId === 'string' && meta.folderId !== ''
      : (meta.version === 1 || meta.version === PACK_META_VERSION_SYNC) && meta.store === undefined;
  return (
    where &&
    typeof vault?.salt === 'string' &&
    vault.salt !== '' &&
    typeof vault.iterations === 'number' &&
    typeof vault.passwordWrap?.ct === 'string' &&
    typeof vault.recoveryWrap?.ct === 'string' &&
    typeof meta.chunks === 'number' &&
    meta.chunks > 0 &&
    typeof meta.digest === 'string' &&
    typeof meta.tag === 'string' &&
    typeof meta.layoutTag === 'string' &&
    typeof meta.updatedAt === 'number' &&
    typeof meta.deviceId === 'string'
  );
}

export async function readPackMeta(): Promise<PackSyncMeta | null> {
  if (!syncAvailable()) {
    return null;
  }
  const stored = await browser.storage.sync.get(PACK_META_KEY);
  const value = stored[PACK_META_KEY];
  return isPackMeta(value) ? value : null;
}

/** 雲端上有沒有一份（哪怕還不完整的）新格式副本。只看 meta 不夠，理由同 `syncEnvelopePresent` */
export async function packEnvelopePresent(): Promise<boolean> {
  if (!syncAvailable()) {
    return false;
  }
  if ((await readPackMeta()) !== null || (await newerMetaPresent())) {
    return true;
  }
  const all = await browser.storage.sync.get(null);
  return Object.keys(all).some((key) => key.startsWith(PACK_CHUNK_PREFIX));
}

/** 雲端那份的 meta 是不是比這一版新（版本號更大） */
async function newerMetaPresent(): Promise<boolean> {
  const stored = await browser.storage.sync.get(PACK_META_KEY);
  const version = (stored[PACK_META_KEY] as { version?: unknown } | undefined)?.version;
  return typeof version === 'number' && version > PACK_META_VERSION;
}

export async function readPackEnvelope(): Promise<PackSyncRead> {
  const meta = await readPackMeta();
  if (meta === null) {
    if (await newerMetaPresent()) {
      return { kind: 'partial', meta: null, newer: true };
    }
    return (await packEnvelopePresent()) ? { kind: 'partial', meta: null } : { kind: 'absent' };
  }
  if (meta.store === 'bookmarks') {
    // 書籤同步比 storage.sync 慢或快都有可能：資料夾還沒到、塊沒到齊都是傳輸中
    const blob = await readBookmarkChunks(meta.folderId ?? '', meta.chunks);
    if (blob === null || (await textDigest(blob)) !== meta.digest) {
      return { kind: 'partial', meta };
    }
    return { kind: 'ok', meta, blob };
  }
  const keys = chunkKeys(meta.chunks);
  const stored = await browser.storage.sync.get(keys);
  const parts: string[] = [];
  for (const key of keys) {
    const part = stored[key];
    if (typeof part !== 'string') {
      return { kind: 'partial', meta };
    }
    parts.push(part);
  }
  const blob = fromChunks(parts);
  if ((await textDigest(blob)) !== meta.digest) {
    return { kind: 'partial', meta };
  }
  return { kind: 'ok', meta, blob };
}

export interface PackIdentity {
  vault: VaultMeta;
  tag: string;
  layoutTag: string;
  deviceId: string;
}

/** 要寫的東西：放 `storage.sync` 的是已經切好的 base91 塊，放書籤的是密文位元組（切塊與編碼交給 `bookmark-store`） */
export type PackTarget = { store: 'sync'; chunks: readonly string[] } | { store: 'bookmarks'; bytes: Bytes };

/**
 * 寫一份完整的副本。兩種存放位置都是**先塊後 meta**：meta 是「這份完整了」的認可標記。
 *
 * 寫進書籤之後順手刪掉 `vaultPackC*`（meta 已經改指書籤，它們只是在佔配額）。
 * 反方向（寫回 `storage.sync` 之後刪書籤資料夾）**不在這裡做**：只有使用者切換存放位置、或移除
 * 雲端副本時才刪（`background/vault-sync`）。每次推送都去刪的話，另一台剛切到書籤、meta 還沒傳到
 * 這台的空檔裡，這台會把對方剛寫好的資料夾刪掉。
 */
export async function writePackEnvelope(identity: PackIdentity, target: PackTarget): Promise<void> {
  const base = {
    vault: identity.vault,
    tag: identity.tag,
    layoutTag: identity.layoutTag,
    updatedAt: Date.now(),
    deviceId: identity.deviceId,
  };
  let meta: PackSyncMeta;
  if (target.store === 'bookmarks') {
    const written = await writeBookmarkChunks(target.bytes);
    meta = {
      ...base,
      version: PACK_META_VERSION,
      store: 'bookmarks',
      folderId: written.folderId,
      chunks: written.chunks,
      digest: await textDigest(written.text),
    };
  } else {
    const items: Record<string, string> = {};
    target.chunks.forEach((chunk, index) => {
      items[`${PACK_CHUNK_PREFIX}${String(index)}`] = chunk;
    });
    await browser.storage.sync.set(items);
    meta = {
      ...base,
      version: PACK_META_VERSION_SYNC,
      chunks: target.chunks.length,
      digest: await textDigest(fromChunks(target.chunks)),
    };
  }
  await browser.storage.sync.set({ [PACK_META_KEY]: meta });
  await removeStalePackChunks(target.store === 'sync' ? target.chunks.length : 0);
  /*
   * 一份完整的新副本取代了刪除標記。
   *
   * 少了這一行，「A 刪掉隱私空間 → A 重新建立 → A 上傳」之後，B 會永遠停在
   * 「另一台裝置刪除了隱私空間」，而那句話已經不是事實，B 也永遠不會去合併
   * 雲端上那份確實存在的副本。
   */
  await clearSyncGone();
}

async function removeStalePackChunks(keep: number): Promise<void> {
  const all = await browser.storage.sync.get(null);
  const stale = Object.keys(all).filter((key) => {
    if (!key.startsWith(PACK_CHUNK_PREFIX)) {
      return false;
    }
    const index = Number(key.slice(PACK_CHUNK_PREFIX.length));
    return Number.isInteger(index) && index >= keep;
  });
  if (stale.length > 0) {
    await browser.storage.sync.remove(stale);
  }
}

/**
 * 清掉雲端副本。`withFolder`：連書籤資料夾一起刪（移除雲端副本時要；覆蓋雲端時若接著要寫回書籤就不必，
 * 留著讓 `writeBookmarkChunks` 用 `update` 換網址）。
 */
export async function clearPackEnvelope(withFolder = true): Promise<void> {
  if (!syncAvailable()) {
    return;
  }
  // 資料夾 id 要在 meta 移除之前讀出來
  const folderId = (await readPackMeta())?.folderId ?? null;
  // meta 先移除：即使接著清塊時失敗，也不會留下一份指向殘塊的認可標記
  await browser.storage.sync.remove(PACK_META_KEY);
  await removeStalePackChunks(0);
  if (withFolder) {
    await removeSyncFolder(folderId);
  }
}
