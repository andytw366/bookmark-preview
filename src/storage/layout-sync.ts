import { fromChunks } from '@/crypto/chunk';
import { textDigest } from '@/shared/vault-merge';
import { syncAvailable } from './vault-sync';

/**
 * `storage.sync` 上那份加密**版面**的讀寫（書籤資料那份在 `vault-sync`）。
 *
 * ```
 * vaultLayoutMeta   中介資料（明文）：salt / 塊數 / 兩個指紋
 * vaultLayoutC0     加密 base64 的第 0 塊
 * ```
 *
 * 鍵名**不能以 `vaultSyncC` 開頭**：舊版的 `removeStaleChunks` 會把那個前綴的鍵全部當
 * 殘塊刪掉。舊版完全不碰其他鍵，所以新舊版本並存時，舊版只是看不到排序。
 *
 * 帶 salt 而不帶整份 `VaultMeta`：解開它的金鑰由書籤資料那份的中介資料決定，這裡只需要
 * 確認「是同一個隱私空間」—— salt 不同就是另一個隱私空間的版面，解不開也不該合併。
 *
 * 其餘規則（先塊後 meta、digest 判斷塊是否湊齊、tag 判斷內容是否相同）與書籤那份一樣，
 * 理由寫在 `vault-sync` 的檔頭。
 */
export const LAYOUT_META_KEY = 'vaultLayoutMeta';
export const LAYOUT_CHUNK_PREFIX = 'vaultLayoutC';

export interface LayoutSyncMeta {
  version: 1;
  salt: string;
  chunks: number;
  digest: string;
  tag: string;
  updatedAt: number;
  deviceId: string;
}

export type LayoutSyncRead =
  | { kind: 'absent' }
  | { kind: 'partial' }
  | { kind: 'ok'; meta: LayoutSyncMeta; blob: string };

function chunkKeys(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${LAYOUT_CHUNK_PREFIX}${String(index)}`);
}

function isLayoutMeta(value: unknown): value is LayoutSyncMeta {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const meta = value as Partial<LayoutSyncMeta>;
  return (
    meta.version === 1 &&
    typeof meta.salt === 'string' &&
    meta.salt !== '' &&
    typeof meta.chunks === 'number' &&
    meta.chunks > 0 &&
    typeof meta.digest === 'string' &&
    typeof meta.tag === 'string' &&
    typeof meta.updatedAt === 'number' &&
    typeof meta.deviceId === 'string'
  );
}

export async function readLayoutEnvelope(): Promise<LayoutSyncRead> {
  if (!syncAvailable()) {
    return { kind: 'absent' };
  }
  const stored = await browser.storage.sync.get(LAYOUT_META_KEY);
  const meta = stored[LAYOUT_META_KEY];
  if (!isLayoutMeta(meta)) {
    // meta 還沒到（或是更新的版本寫的）但塊已經在了：傳播中，不能當成「雲端沒有」
    const all = await browser.storage.sync.get(null);
    return Object.keys(all).some((key) => key.startsWith(LAYOUT_CHUNK_PREFIX))
      ? { kind: 'partial' }
      : { kind: 'absent' };
  }
  const keys = chunkKeys(meta.chunks);
  const parts = await browser.storage.sync.get(keys);
  const blobParts: string[] = [];
  for (const key of keys) {
    const part = parts[key];
    if (typeof part !== 'string') {
      return { kind: 'partial' };
    }
    blobParts.push(part);
  }
  const blob = fromChunks(blobParts);
  if ((await textDigest(blob)) !== meta.digest) {
    return { kind: 'partial' };
  }
  return { kind: 'ok', meta, blob };
}

export async function writeLayoutEnvelope(
  identity: { salt: string; tag: string; deviceId: string },
  chunks: readonly string[],
): Promise<void> {
  const items: Record<string, string> = {};
  chunks.forEach((chunk, index) => {
    items[`${LAYOUT_CHUNK_PREFIX}${String(index)}`] = chunk;
  });
  await browser.storage.sync.set(items);
  const meta: LayoutSyncMeta = {
    version: 1,
    salt: identity.salt,
    chunks: chunks.length,
    digest: await textDigest(fromChunks(chunks)),
    tag: identity.tag,
    updatedAt: Date.now(),
    deviceId: identity.deviceId,
  };
  await browser.storage.sync.set({ [LAYOUT_META_KEY]: meta });
  await removeStaleLayoutChunks(chunks.length);
}

async function removeStaleLayoutChunks(keep: number): Promise<void> {
  const all = await browser.storage.sync.get(null);
  const stale = Object.keys(all).filter((key) => {
    if (!key.startsWith(LAYOUT_CHUNK_PREFIX)) {
      return false;
    }
    const index = Number(key.slice(LAYOUT_CHUNK_PREFIX.length));
    return Number.isInteger(index) && index >= keep;
  });
  if (stale.length > 0) {
    await browser.storage.sync.remove(stale);
  }
}

/** 清掉雲端的版面。所有清掉書籤那份副本的路徑都要連這個一起呼叫 */
export async function clearLayoutEnvelope(): Promise<void> {
  if (!syncAvailable()) {
    return;
  }
  await browser.storage.sync.remove(LAYOUT_META_KEY);
  await removeStaleLayoutChunks(0);
}

/** 版面目前在雲端佔多少（估算，與 `estimateSyncBytes` 同一套算法） */
export async function layoutSyncBytes(): Promise<number> {
  if (!syncAvailable()) {
    return 0;
  }
  const stored = await browser.storage.sync.get(LAYOUT_META_KEY);
  const meta = stored[LAYOUT_META_KEY];
  if (!isLayoutMeta(meta)) {
    return 0;
  }
  return meta.chunks * (7_500 + LAYOUT_CHUNK_PREFIX.length + 2) + JSON.stringify(meta).length + LAYOUT_META_KEY.length;
}
