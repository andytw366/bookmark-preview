import { broadcast } from '@/shared/messages';
import { urlKey } from '@/shared/url';
import { getSettings } from '@/storage/settings';
import { deleteThumb, putThumb } from '@/storage/thumbs-db';
import {
  coverThumbnailFor,
  hasHostAccess,
  produceThumbnailNow,
  screenshotThumbnailFor,
} from './capture';
import { fetchOgThumbnail } from './og-fetcher';
import { findOpenTabResolving } from './open-tab';
import { findVaultBookmarkById, storeVaultThumbnail, vaultThumbKey } from './vault';
import { t } from '@/shared/i18n';

export interface RefreshReport {
  ok: boolean;
  detail: string;
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

  // 使用者是明確按下去的，所以找不到時值得多花一個請求解析轉址：書籤存 http、
  // 分頁停在 https（或首頁被轉到語系路徑）時，頁面明明開著，而失敗訊息卻會叫他
  // 「先開啟那個頁面」—— 那句話會讓人反覆試同一件事
  const open = await findOpenTabResolving(url, true);
  if (open !== undefined) {
    const settings = await getSettings();
    const produced = await produceThumbnailNow(open.tabId, open.pageUrl, key, settings.previewSource);
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
  /*
   * `remember: false` —— 隱私書籤的網址不准寫進 `storage.local`。解析轉址的結果
   * 只留在記憶體裡、用完就丟（`storage/redirect-map.ts` 開頭寫了同一條規則）。
   * 一般書籤那條路記，隱私空間這條不記，與診斷（`recordCapture`）完全一樣的取捨。
   */
  const open = await findOpenTabResolving(url, false);
  if (open !== undefined) {
    const { previewSource } = await getSettings();
    const order: ('cover' | 'capture')[] =
      previewSource === 'cover-first' ? ['cover', 'capture'] : ['capture', 'cover'];
    for (const attempt of order) {
      const thumbnail =
        attempt === 'cover'
          ? await coverThumbnailFor(open.tabId, open.pageUrl)
          : await screenshotThumbnailFor(open.tabId, open.pageUrl);
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
        open !== undefined
          ? t('refresh_no_cover_no_server')
          : t('refresh_no_tab_no_server'),
    };
  }
  await store(thumbnail);
  return { ok: true, detail: t('refresh_done_via_og') };
}
