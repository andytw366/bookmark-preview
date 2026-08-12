import { hostnameOf } from '@/shared/url';
import { isSamePageIgnoringScheme } from '@/shared/url-match';
import { loadRedirects, rememberRedirect } from '@/storage/redirect-map';
import { resolveFinalUrlViaTab } from './redirect-resolve';

/**
 * 「這個書籤的頁面現在有沒有開著」。
 *
 * 這是整個管線裡品質最好的那條路的入口：頁面開著就能從已渲染的 DOM 找封面，
 * 找不到還能截圖。所以**這裡答錯的代價很大** —— 回 undefined 就等於整個功能退回
 * 伺服器端那條弱路，而使用者明明正看著那一頁。
 *
 * 比對放寬到「只差協定」與「已知的轉址目標」，理由見 `shared/url-match.ts`。
 *
 * **隱私瀏覽的分頁一律不算。** 自動擷取本來就跳過隱私視窗（使用者的明確意圖是不留
 * 痕跡），那條規則不該因為換了一個入口就失效。
 */
function usable(tab: browser.tabs.Tab): boolean {
  return tab.id !== undefined && tab.incognito !== true && tab.url !== undefined && tab.url !== '';
}

/**
 * 找到的分頁，**連它停在哪個網址一起回**。
 *
 * 兩個都要，因為放寬比對之後它們可能不一樣，而用錯一個的後果是安靜的：
 * `coverThumbnailFor` 與 `screenshotThumbnailFor` 拿這個網址比對「使用者是不是已經
 * 換頁了」，傳書籤那個網址進去會讓它們每次都判定成換頁而什麼都不做；反過來，
 * 縮圖的鍵一定要從**書籤**的網址算，否則寫進去的圖那個書籤讀不到。
 * 分成兩個欄位就沒得混。
 */
export interface OpenTab {
  tabId: number;
  /** 分頁現在停在的網址（可能是書籤網址轉址後的結果） */
  pageUrl: string;
}

function found(tab: browser.tabs.Tab | undefined): OpenTab | undefined {
  return tab?.id === undefined ? undefined : { tabId: tab.id, pageUrl: tab.url ?? '' };
}

/** 只比對，不發任何請求、不寫任何東西。 */
export async function findOpenTab(url: string): Promise<OpenTab | undefined> {
  const tabs = (await browser.tabs.query({})).filter(usable);
  const direct = tabs.find((tab) => isSamePageIgnoringScheme(tab.url ?? '', url));
  if (direct !== undefined) {
    return found(direct);
  }
  const target = (await loadRedirects()).get(url);
  if (target === undefined) {
    return undefined;
  }
  return found(tabs.find((tab) => isSamePageIgnoringScheme(tab.url ?? '', target)));
}

/**
 * 找不到時的第二步：借同一個主機上開著的分頁解析一次轉址，再比對一次。
 *
 * 為什麼值得多這一步：使用者是**明確按了「重新抓預覽圖」**才走到這裡的，而失敗的
 * 訊息會叫他「先開啟那個頁面」—— 頁面明明開著，只是網址被轉走了。那句話會讓人
 * 反覆試同一件事。
 *
 * `remember` 決定要不要把解析結果寫進 `storage.local`。**隱私書籤一律傳 false**：
 * 那張表會把網址明文留在磁碟上（見 `storage/redirect-map.ts`）。
 */
export async function findOpenTabResolving(
  url: string,
  remember: boolean,
): Promise<OpenTab | undefined> {
  const direct = await findOpenTab(url);
  if (direct !== undefined) {
    return direct;
  }
  const tabs = (await browser.tabs.query({})).filter(usable);
  const host = hostnameOf(url);
  const sameHost = tabs.find((tab) => hostnameOf(tab.url ?? '') === host);
  if (sameHost?.id === undefined) {
    return undefined;
  }
  const finalUrl = await resolveFinalUrlViaTab(sameHost.id, url);
  if (finalUrl === null) {
    return undefined;
  }
  if (remember) {
    await rememberRedirect(url, finalUrl);
  }
  return found(tabs.find((tab) => isSamePageIgnoringScheme(tab.url ?? '', finalUrl)));
}
