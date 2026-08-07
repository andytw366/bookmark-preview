import { urlKey } from '@/shared/url';
import { pruneMissing } from '@/storage/thumbs-db';
import { readMeta } from '@/storage/vault-store';
import { bookmarkedUrls } from './bookmark-index';
import { isUnlocked, protectedThumbKeys } from './vault';

/**
 * 刪掉沒有對應書籤的孤兒縮圖（書籤被刪除後留下的）。
 *
 * 刻意「不」依縮圖年齡刪除：過期的縮圖只需要重新擷取，
 * 在重新擷取到之前，舊縮圖仍然比空白色卡有用。
 * thumbMaxAgeDays 只決定何時重抓，不決定何時刪。
 *
 * **隱私空間上鎖時一律跳過整理。** 隱私書籤已經從原生書籤樹移除，
 * 上鎖狀態下我們無法列出它們的縮圖鍵，照常整理會把它們全部當成孤兒刪掉。
 * 整理只是家務事，延到解鎖後再做沒有任何損失。
 */
export async function pruneOrphanThumbs(): Promise<number> {
  const vaultExists = (await readMeta()) !== null;
  if (vaultExists && !isUnlocked()) {
    return 0;
  }

  const urls = await bookmarkedUrls();
  const keys = await Promise.all([...urls].map(urlKey));
  const keep = new Set([...keys, ...protectedThumbKeys()]);
  return pruneMissing(keep);
}
