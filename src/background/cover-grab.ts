import { MIN_COVER_EDGES } from '@/shared/image-structure';
import { grabImage } from './image-grab';
import { type Thumbnail } from './image';

/**
 * 把候選封面依序取下來做成縮圖，第一個成功的就採用。
 *
 * **每一個候選都走 `grabImage` 的策略階梯**（背景頁 fetch → 頁面內 fetch），
 * 與右鍵手動指定同一套。原本這裡只做一次背景頁 fetch，於是出現一個很難解釋的
 * 落差：**同一張圖，右鍵指定得到、自動判定拿不到**，而且失敗是安靜的 ——
 * 往下試到站台 logo（在人家自己家，一定成功）就停了。
 *
 * 兩個原因，都是背景頁 fetch 本身的限制：
 *
 * 1. **防盜連。** 擴充套件無法自行設定跨來源的 Referer（`fetch` 的 `referrer`
 *    選項會被瀏覽器丟掉，所以原本這裡設它是沒有效果的），檢查 Referer 的 CDN
 *    一律回 403。頁面內 fetch 是在頁面的脈絡裡發的，Referer 與 cookie 都是對的。
 * 2. **奇怪的 content-type。** 原本這裡硬性要求 `content-type` 開頭是 `image/`，
 *    但不少 CDN 對圖片回 `application/octet-stream` —— `image-grab.ts` 自己的
 *    註解早就寫了這件事，所以手動那條路刻意不看它。真正的判斷標準是
 *    「能不能解碼成圖片」，而那是 `makeCoverThumbnail` 在做的事。
 *
 * 實際案例：Cloudflare 後面的站台對無 cookie 的請求回 403 + captcha（容器實測，
 * 換瀏覽器 UA 也一樣），於是封面判定與伺服器端 og 同時失效。隱私書籤更痛 ——
 * 它連「移出去抓好再移回來」以外的出路都沒有。
 *
 * **不含畫面裁切那一段**（`allowScreenshot: false`）：那要先把圖捲進可見範圍，
 * 自動擷取只是因為使用者造訪了一個已加入書籤的頁面就會跑，頁面不該自己跳動。
 * 封面全部失敗時管線本來就會退回整頁截圖。
 *
 * **不記診斷、也不寫入。** 隱私書籤那條路（`refreshVaultThumbnail`）也會走到
 * 這裡，而 `recordCapture` 會把網址明文寫進 `storage.local`，等於把藏起來的
 * 網址又漏出去一次。要不要記由呼叫端決定。
 */
export async function grabCoverThumbnail(
  candidates: readonly string[],
  tabId: number,
): Promise<Thumbnail | null> {
  for (const candidate of candidates) {
    const grabbed = await grabImage(tabId, candidate, {
      allowScreenshot: false,
      minEdges: MIN_COVER_EDGES,
    });
    if (grabbed !== null) {
      return grabbed.thumbnail;
    }
    // 取不下來、解不出圖片、或那根本不是圖（純色／漸層）—— 換下一個候選
  }
  return null;
}
