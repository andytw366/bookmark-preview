import { t } from '@/shared/i18n';

/**
 * 把一段 base64 切成能放進 storage.sync 的塊。
 *
 * storage.sync 的限制：單筆 item 8,192 bytes、總量 102,400 bytes、最多 512 筆。
 * 大小是以「JSON 序列化後的值長度 + 鍵長度」計算，base64 每個字元佔 1 byte，
 * 因此留 692 bytes 餘裕給鍵名與 JSON 的引號綽綽有餘。
 *
 * 刻意不做「一個書籤一筆 item」：那會同時撞上 512 筆上限與每筆的鍵名開銷。
 */
export const CHUNK_CHARS = 7_500;
export const SYNC_TOTAL_BUDGET = 102_400;
export const SYNC_ITEM_LIMIT = 512;

export function toChunks(text: string, size: number = CHUNK_CHARS): string[] {
  if (size <= 0) {
    throw new Error(t('crypto_chunk_size_invalid'));
  }
  if (text === '') {
    return [];
  }
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += size) {
    chunks.push(text.slice(offset, offset + size));
  }
  return chunks;
}

export function fromChunks(chunks: readonly string[]): string {
  return chunks.join('');
}

/** 估算這些塊寫進 storage.sync 後會佔用多少配額（含鍵名）。 */
export function estimateSyncBytes(chunks: readonly string[], keyPrefix: string): number {
  return chunks.reduce(
    (total, chunk, index) => total + chunk.length + `${keyPrefix}${String(index)}`.length,
    0,
  );
}

/**
 * 留給中介資料那一筆的餘裕。
 *
 * 同步的那一筆 meta 含 salt、verifier、塊數與裝置 id，實測約 250 bytes。
 * 留 1 KB 是因為「差一點就爆配額」的失敗代價不對稱：估太保守只是少同步一些
 * 書籤，估太寬鬆會讓 `storage.sync.set` 中途失敗，遠端留下寫了一半的副本。
 */
export const SYNC_META_RESERVE = 1_024;

/** 這些塊加上中介資料能否放進 storage.sync 的配額。 */
export function fitsInSync(
  chunks: readonly string[],
  keyPrefix: string,
  reserveBytes: number = SYNC_META_RESERVE,
): boolean {
  if (chunks.length + 1 > SYNC_ITEM_LIMIT) {
    return false;
  }
  return estimateSyncBytes(chunks, keyPrefix) + reserveBytes <= SYNC_TOTAL_BUDGET;
}
