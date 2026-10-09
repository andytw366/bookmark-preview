import { forgetCapture } from '@/storage/diagnostics';
import { forgetRedirects } from '@/storage/redirect-map';
import { forgetPages } from '@/storage/site-image-stats';

/**
 * 把這些網址在 `storage.local` 明文快取裡的痕跡清掉。書籤移進隱私空間時、以及每次解鎖時呼叫。
 *
 * 那三份快取（轉址表、全站共用圖的學習紀錄、最後一次擷取的診斷）都只記一般書籤，
 * 隱私空間那幾條路不寫進去（`tests/vault-thumb-privacy.test.ts` 釘著）。但書籤**還是一般書籤的時候**
 * 寫下的紀錄不會因為它被移進隱私空間就消失 —— 1.2.0 以前就是這樣，Wikipedia 移進去之後
 * 頁面網址還躺在 `siteImageStats` 裡。
 *
 * 解鎖時也跑一次：舊版本留下的、以及另一台裝置移進隱私空間（這台的原生書籤是被 Firefox 同步刪掉的，
 * 這裡的移入流程根本沒跑）的，都只有在解鎖、看得到隱私書籤的網址時才清得掉。
 *
 * 轉址表要先清：它記著書籤網址實際停在哪裡，另外兩份記的往往是那個最終網址。
 */
export async function forgetPlaintextTraces(urls: readonly string[]): Promise<void> {
  if (urls.length === 0) {
    return;
  }
  const finals = await forgetRedirects(urls);
  const all = [...urls, ...finals];
  await forgetPages(all);
  await forgetCapture(all);
}
