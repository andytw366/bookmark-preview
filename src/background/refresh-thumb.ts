import { broadcast } from '@/shared/messages';
import { isSamePage, urlKey } from '@/shared/url';
import { getSettings } from '@/storage/settings';
import { deleteThumb, putThumb } from '@/storage/thumbs-db';
import {
  coverThumbnailFor,
  hasHostAccess,
  produceThumbnailNow,
  screenshotThumbnailFor,
} from './capture';
import { fetchOgThumbnail } from './og-fetcher';
import { findVaultBookmarkById, storeVaultThumbnail, vaultThumbKey } from './vault';
import { t } from '@/shared/i18n';

export interface RefreshReport {
  ok: boolean;
  detail: string;
}

/**
 * 找出這個網址現在有沒有開著的分頁。
 *
 * **刻意不用 `tabs.query({ url })`。** match pattern 的兩個硬性限制會讓它對很常見
 * 的網址直接丟 `Invalid url pattern`：主機不能帶連接埠、而且一定要有路徑。
 * 實測踩到的兩個都是日常網址 —— `https://news.ycombinator.com/`（去掉尾端斜線
 * 就沒有路徑了）與 `http://127.0.0.1:8899/`（帶連接埠）。改成把分頁全部拿回來
 * 自己比對，判準與縮圖鍵一致（`isSamePage`），沒有語法上的地雷。
 *
 * 這也與 `capture.ts` 找分頁的做法一致 —— 兩邊對「同一頁」的定義本來就該一樣。
 */
async function findOpenTab(url: string): Promise<number | undefined> {
  const tabs = await browser.tabs.query({});
  const target = tabs.find(
    (tab) => tab.id !== undefined && tab.url !== undefined && isSamePage(tab.url, url),
  );
  return target?.id;
}

/**
 * 對單一書籤重新抓預覽圖。
 *
 * 自動擷取有「還很新就跳過」的機制，所以抓錯時光是重新造訪頁面沒有用。
 * 這裡先刪掉既有縮圖再重跑，等於明確覆寫。
 *
 * 兩條路徑，取決於那個頁面現在有沒有開著：
 * - **有開著**：走完整管線（從已渲染的 DOM 找封面，失敗才截圖）。品質最好。
 * - **沒開著**：只能從伺服器端抓 og:image，前端渲染或有防護的站台會失敗，
 *   此時明確告知使用者「請先開啟該頁面再重試」而不是靜默失敗。
 */
export async function refreshThumbnail(url: string): Promise<RefreshReport> {
  if (!(await hasHostAccess())) {
    return { ok: false, detail: t('refresh_needs_host_permission') };
  }

  const key = await urlKey(url);
  await deleteThumb(key);
  // 廣播刪除：舊縮圖此刻已經不在資料庫裡了，不通知的話畫面會繼續顯示一張
  // 已經不存在的圖，重抓失敗時更會讓人以為「還在，只是沒更新」。
  broadcast('thumbs/updated', { key });

  const openTabId = await findOpenTab(url);
  if (openTabId !== undefined) {
    const settings = await getSettings();
    const produced = await produceThumbnailNow(openTabId, url, key, settings.previewSource);
    return produced
      ? { ok: true, detail: t('refresh_done') }
      : { ok: false, detail: t('refresh_no_cover_on_page') };
  }

  // 頁面沒開著：退回伺服器端的 og:image
  const thumbnail = await fetchOgThumbnail(url);
  if (thumbnail === null) {
    return {
      ok: false,
      detail: t('refresh_no_tab_no_server'),
    };
  }
  await putThumb({
    key,
    ...thumbnail,
    source: 'og',
    capturedAt: Date.now(),
    encrypted: false,
    iv: null,
  });
  // 少了這一行的話：圖確實抓到並寫進 IndexedDB 了，但沒有人通知 UI 去重讀，
  // 畫面停在舊圖 —— 表現成「訊息說抓好了，但預覽圖沒變」。
  // 其他每一條寫入縮圖的路徑（capture、backfill、隱私空間）都有廣播，只有這裡漏掉。
  broadcast('thumbs/updated', { key });
  return { ok: true, detail: t('refresh_done_via_og') };
}

/**
 * 對單一隱私書籤重新抓預覽圖。
 *
 * **不能複用上面的 `refreshThumbnail`。** 那條路走 `putThumb` 寫明文，
 * 而隱私書籤的縮圖必須加密 —— 明文躺在 IndexedDB 裡的話，任何能翻擴充套件
 * 儲存目錄的人看圖就知道內容，整個加密設計就白做了。
 *
 * **截圖退路是有的，但走的是不落地的那條。** 原本這裡沒有截圖，理由是「截圖會先把
 * 明文寫進 IndexedDB 再加密、刪除明文，等於為了一張縮圖在磁碟上開一個明文的時間窗」——
 * 那個理由是 `capture()` 當時實作方式綁的，不是本質限制。`screenshotThumbnailFor`
 * 只回傳位元組，交給 `storeVaultThumbnail` 直接加密寫入，明文從頭到尾不存在。
 *
 * 少了它的代價是實際遇到的：Cloudflare 之類會擋掉背景頁的無 cookie 請求，於是
 * 封面判定與伺服器端 og 兩條同時失效，而那正是截圖唯一能派上用場的時候 ——
 * 使用者只能把書籤移出隱私空間、抓好圖、再移回去。
 */
export async function refreshVaultThumbnail(id: string): Promise<RefreshReport> {
  if (!(await hasHostAccess())) {
    return { ok: false, detail: t('refresh_needs_host_permission') };
  }
  const record = findVaultBookmarkById(id);
  if (record === null) {
    return { ok: false, detail: t('vault_bookmark_not_found') };
  }
  const url = record.url;

  const store = async (thumbnail: { bytes: ArrayBuffer; mime: string; width: number; height: number }) => {
    await storeVaultThumbnail(id, thumbnail);
    broadcast('thumbs/updated', { key: vaultThumbKey(id) });
  };

  /*
   * 頁面開著時走完整的判定：封面與截圖，順序照設定頁的「預覽圖來源」——
   * 與一般書籤的 `produceThumbnailNow` 同一個規則，隱私書籤沒有理由不一樣。
   *
   * 兩者都只回傳位元組，由 `store` 加密寫入，明文不落地。
   */
  const openTabId = await findOpenTab(url);
  if (openTabId !== undefined) {
    const { previewSource } = await getSettings();
    const order: ('cover' | 'capture')[] =
      previewSource === 'cover-first' ? ['cover', 'capture'] : ['capture', 'cover'];
    for (const attempt of order) {
      const thumbnail =
        attempt === 'cover'
          ? await coverThumbnailFor(openTabId, url)
          : await screenshotThumbnailFor(openTabId, url);
      if (thumbnail !== null) {
        await store(thumbnail);
        return { ok: true, detail: t('refresh_done') };
      }
    }
  }

  const thumbnail = await fetchOgThumbnail(url);
  if (thumbnail === null) {
    // 「分頁沒開」與「分頁開著但這頁沒有可用的封面」是兩件事，不能用同一句話帶過：
    // 前者的下一步是去開那個頁面，後者再開幾次也沒用。實測時就被這句話誤導過一次
    // （分頁明明開著，訊息卻叫我去開分頁）。
    return {
      ok: false,
      detail:
        openTabId !== undefined
          ? t('refresh_no_cover_no_server')
          : t('refresh_no_tab_no_server'),
    };
  }
  await store(thumbnail);
  return { ok: true, detail: t('refresh_done_via_og') };
}
