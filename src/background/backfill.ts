import { broadcast, type BackfillReport } from '@/shared/messages';
import { hostnameOf, isPreviewableUrl, urlKey } from '@/shared/url';
import { getSettings, isBlocked } from '@/storage/settings';
import { getThumb, putThumb } from '@/storage/thumbs-db';
import { bookmarkedUrls } from './bookmark-index';
import { hasHostAccess } from './capture';
import { fetchOgThumbnail } from './og-fetcher';
import { fetchIconThumbnail, wantsSiteIcon } from './site-icon';
import type { Thumbnail } from './image';
import type { Settings, ThumbSource } from '@/shared/types';
import { listBookmarks, storeVaultThumbnail, vaultThumbKey } from './vault';
import { t } from '@/shared/i18n';

/**
 * 手動補抓：為還沒有任何縮圖的書籤抓 og:image。
 *
 * 刻意不做成安裝時自動執行 —— 這會對幾百個網域發出請求，
 * 使用者應該明確知道自己按了這個按鈕。
 *
 * 也刻意用 OG 抓取而不是「在隱藏分頁逐一開啟書籤再截圖」：
 * 後者要開關幾百個分頁、會執行頁面腳本、時間長得多，
 * 而 OG 圖正好就是規劃裡的第二層 fallback。
 */
const CONCURRENCY = 3;

let running = false;

export async function backfillThumbnails(): Promise<BackfillReport> {
  if (running) {
    throw new Error(t('backfill_already_running'));
  }
  if (!(await hasHostAccess())) {
    throw new Error(t('backfill_needs_host_permission'));
  }

  running = true;
  try {
    const settings = await getSettings();
    const candidates = [...(await bookmarkedUrls())].filter(
      (url) => isPreviewableUrl(url) && !isBlocked(hostnameOf(url), settings.captureBlocklist),
    );

    const targets: { url: string; key: string }[] = [];
    for (const url of candidates) {
      const key = await urlKey(url);
      if ((await getThumb(key)) === undefined) {
        targets.push({ url, key });
      }
    }

    const total = targets.length;
    let done = 0;
    let ok = 0;
    broadcast('backfill/progress', { done, total, ok });

    // 併發上限 3：這是對外部網站發請求，不該一次打上百個
    const queue = [...targets];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const item = queue.shift();
        if (item === undefined) {
          return;
        }
        const found = await iconOrOg(settings, item.url, { learn: true });
        if (found !== null) {
          await putThumb({
            key: item.key,
            ...found.thumbnail,
            source: found.source,
            capturedAt: Date.now(),
            encrypted: false,
            iv: null,
          });
          broadcast('thumbs/updated', { key: item.key });
          ok += 1;
        }
        done += 1;
        broadcast('backfill/progress', { done, total, ok });
      }
    });
    await Promise.all(workers);

    return { total, ok };
  } finally {
    running = false;
  }
}

/**
 * 隱私空間版的補抓。
 *
 * 不能複用上面那個：它掃的是原生書籤樹，而隱私書籤已經不在裡面；
 * 而且寫入必須經過 `storeVaultThumbnail` 加密，走 `putThumb` 會把明文
 * 留在 IndexedDB，整個加密設計就白做了。
 *
 * 只有 og:image 這條路可用 —— 隱私書籤沒有開啟中的分頁可以擷取封面，
 * 而「為了補縮圖去逐一開啟隱私書籤」既慢又會留下瀏覽痕跡。
 */
export async function backfillVaultThumbnails(): Promise<BackfillReport> {
  if (running) {
    throw new Error(t('backfill_already_running'));
  }
  if (!(await hasHostAccess())) {
    throw new Error(t('backfill_needs_host_permission'));
  }

  running = true;
  try {
    const settings = await getSettings();
    const targets: { id: string; url: string }[] = [];
    for (const record of listBookmarks()) {
      if (!isPreviewableUrl(record.url) || isBlocked(hostnameOf(record.url), settings.captureBlocklist)) {
        continue;
      }
      if ((await getThumb(vaultThumbKey(record.id))) === undefined) {
        targets.push({ id: record.id, url: record.url });
      }
    }

    const total = targets.length;
    let done = 0;
    let ok = 0;
    broadcast('backfill/progress', { done, total, ok });

    // 併發上限與一般補抓相同：對外部網站發請求，不該一次打上百個
    const queue = [...targets];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const item = queue.shift();
        if (item === undefined) {
          return;
        }
        const found = await iconOrOg(settings, item.url, { learn: false });
        if (found !== null) {
          await storeVaultThumbnail(item.id, found.thumbnail, found.source);
          broadcast('thumbs/updated', { key: vaultThumbKey(item.id) });
          ok += 1;
        }
        done += 1;
        broadcast('backfill/progress', { done, total, ok });
      }
    });
    await Promise.all(workers);

    return { total, ok };
  } finally {
    running = false;
  }
}

/**
 * 沒開分頁時能拿到的預覽：入口網址先試網站圖示（解析 HTML、最後試 `/favicon.ico`），
 * 再退回 og:image。兩種補抓共用，免得一邊有圖示、另一邊沒有。
 */
async function iconOrOg(
  settings: Settings,
  url: string,
  { learn }: { learn: boolean },
): Promise<{ thumbnail: Thumbnail; source: ThumbSource } | null> {
  if (wantsSiteIcon(settings, url)) {
    const icon = await fetchIconThumbnail(url);
    if (icon !== null) {
      return { thumbnail: icon, source: 'icon' };
    }
  }
  const og = await fetchOgThumbnail(url, { learn });
  return og === null ? null : { thumbnail: og, source: 'og' };
}
