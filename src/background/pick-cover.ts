import { broadcast } from '@/shared/messages';
import { urlKey } from '@/shared/url';
import { recordCapture } from '@/storage/diagnostics';
import { putThumb } from '@/storage/thumbs-db';
import { matchBookmark, resolveBookmarkForPage } from './bookmark-index';
import { grabImage } from './image-grab';
import { findVaultBookmarkByUrl, storeVaultThumbnail, vaultThumbKey } from './vault';
import { t } from '@/shared/i18n';

/**
 * 右鍵手動指定預覽圖。
 *
 * 自動判定的啟發式再怎麼調，都不可能對所有站台都挑對 —— 有些頁面
 * 就是沒有任何可辨識的封面，或有好幾張同樣像封面的圖。與其為個別站台
 * 加特例（那會變成永遠追不完的維護負擔），不如給一個直接指定的出口：
 * 對著你要的那張圖右鍵就好。
 *
 * 這也是為什麼自動判定可以放心保持「通用但不完美」—— 失手時有救。
 */
const MENU_ID = 'set-bookmark-preview';

export function registerPickCoverMenu(): void {
  // removeAll 再 create：事件頁被喚醒時會重跑頂層程式碼，
  // 直接 create 會因為 ID 重複而失敗。
  void browser.menus.removeAll().then(() => {
    browser.menus.create({
      id: MENU_ID,
      title: t('menu_set_as_preview'),
      contexts: ['image'],
    });
  });

  browser.menus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_ID) {
      return;
    }
    const imageUrl = info.srcUrl;
    const pageUrl = tab?.url;
    if (imageUrl === undefined || pageUrl === undefined) {
      return;
    }
    void applyManualCover(imageUrl, pageUrl, tab?.id);
  });
}

async function applyManualCover(
  imageUrl: string,
  pageUrl: string,
  tabId: number | undefined,
): Promise<void> {
  const stamp = { url: pageUrl, at: Date.now() };
  try {
    const grabbed = await grabImage(tabId, imageUrl);
    if (grabbed === null) {
      await recordCapture({
        ...stamp,
        stage: 'manual:failed',
        detail: t('pick_all_strategies_failed'),
      });
      return;
    }
    const thumbnail = grabbed.thumbnail;
    // 記下是三段裡的哪一段成功的：失敗時才知道該往哪裡查（`grabImage` 已經算出來了，
    // 這裡原本把它丟掉，於是診斷只看得到「成功」而看不出走了哪條路）
    const via = { detail: t('pick_strategy_used', grabbed.strategy) };

    // 隱私書籤已經不在原生書籤樹裡，要分開判斷，而且縮圖必須加密
    const priv = findVaultBookmarkByUrl(pageUrl);
    if (priv !== null) {
      await storeVaultThumbnail(priv.id, thumbnail);
      await recordCapture({ ...stamp, stage: 'manual:ok', ...via });
      broadcast('thumbs/updated', { key: vaultThumbKey(priv.id) });
      return;
    }

    /*
     * 用書籤自己的網址算鍵，不是這一頁的網址。
     *
     * 這條路一樣會被轉址擋掉：書籤存 `http://`、頁面停在 `https://` 時，
     * 原本會記成 `manual:not-bookmarked` —— 使用者對著自己的書籤右鍵指定圖片，
     * 卻被告知「這一頁沒有加入書籤」。連手動這條救命路都沒了。
     */
    const match =
      tabId === undefined ? await matchBookmark(pageUrl) : await resolveBookmarkForPage(pageUrl, tabId);
    if (match === null) {
      await recordCapture({ ...stamp, stage: 'manual:not-bookmarked' });
      return;
    }

    const key = await urlKey(match.bookmarkUrl);
    await putThumb({
      key,
      ...thumbnail,
      source: 'cover',
      capturedAt: Date.now(),
      encrypted: false,
      iv: null,
    });
    await recordCapture({ ...stamp, stage: 'manual:ok', ...via });
    broadcast('thumbs/updated', { key });
  } catch (cause) {
    await recordCapture({
      ...stamp,
      stage: 'manual:failed',
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
