import { fromChunks } from '@/crypto/chunk';
import type { VaultMeta } from '@/shared/types';
import { textDigest } from '@/shared/vault-merge';
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
 *
 * **改格式就要升這個數字。** 看到比自己新的版本，舊版會停下來等（`isPackMeta` 不認得 → 當成傳輸中），
 * 而不是把解不開的東西當成「雲端壞了」拿本機那份蓋過去 —— 那會讓還沒更新的裝置每一輪都覆蓋雲端。
 */
export const PACK_META_VERSION = 2;

export interface PackSyncMeta {
  version: 1 | typeof PACK_META_VERSION;
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
  | { kind: 'ok'; meta: PackSyncMeta; blob: string };

function chunkKeys(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${PACK_CHUNK_PREFIX}${String(index)}`);
}

function isPackMeta(value: unknown): value is PackSyncMeta {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const meta = value as Partial<PackSyncMeta>;
  const vault = meta.vault as Partial<VaultMeta> | undefined;
  return (
    (meta.version === 1 || meta.version === PACK_META_VERSION) &&
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

export async function writePackEnvelope(identity: PackIdentity, chunks: readonly string[]): Promise<void> {
  const items: Record<string, string> = {};
  chunks.forEach((chunk, index) => {
    items[`${PACK_CHUNK_PREFIX}${String(index)}`] = chunk;
  });
  await browser.storage.sync.set(items);
  const meta: PackSyncMeta = {
    version: PACK_META_VERSION,
    vault: identity.vault,
    chunks: chunks.length,
    digest: await textDigest(fromChunks(chunks)),
    tag: identity.tag,
    layoutTag: identity.layoutTag,
    updatedAt: Date.now(),
    deviceId: identity.deviceId,
  };
  await browser.storage.sync.set({ [PACK_META_KEY]: meta });
  await removeStalePackChunks(chunks.length);
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

export async function clearPackEnvelope(): Promise<void> {
  if (!syncAvailable()) {
    return;
  }
  // meta 先移除：即使接著清塊時失敗，也不會留下一份指向殘塊的認可標記
  await browser.storage.sync.remove(PACK_META_KEY);
  await removeStalePackChunks(0);
}
