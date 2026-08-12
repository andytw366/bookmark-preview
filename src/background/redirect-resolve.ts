/**
 * 問「這個網址最後會停在哪裡」。
 *
 * **一定要在頁面的脈絡裡問，不能在背景頁問。** 轉址常常取決於 cookie 與語系，而
 * 背景頁那次請求兩者都沒有：`https://poedb.tw/` 在瀏覽器裡停在 `/tw/`，用
 * 無 cookie 的背景請求問則得到 `/us/` —— 拿後者去比對分頁，永遠配不上。
 *
 * 注入的函式只回傳一個字串。**不要讓它回傳位元組或需要迭代的東西** ——
 * 那跨不過 Xray 邊界（見 `image-grab.ts` 的 `fetchInPage`）。
 */
const TIMEOUT_MS = 8_000;

/** 在頁面裡問，回傳跟完轉址之後的網址。失敗一律回 null，呼叫端當作「不知道」。 */
function finalUrlOf(url: string): Promise<string | null> {
  // HEAD 就夠了：只要最後那個網址，不需要內容。伺服器不接受 HEAD（405）也沒關係，
  // 轉址已經跟完了，`response.url` 仍然是最後那一個。
  return fetch(url, { method: 'HEAD', credentials: 'include', redirect: 'follow' })
    .then((response) => (response.url === '' ? null : response.url))
    .catch(() => null);
}

export async function resolveFinalUrlViaTab(tabId: number, url: string): Promise<string | null> {
  const inject = browser.scripting.executeScript as unknown as (options: {
    target: { tabId: number };
    func: unknown;
    args: unknown[];
  }) => Promise<{ result?: unknown }[]>;
  try {
    const results = await Promise.race([
      inject({ target: { tabId }, func: finalUrlOf, args: [url] }),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error('resolve timed out'));
        }, TIMEOUT_MS);
      }),
    ]);
    const value = results[0]?.result;
    return typeof value === 'string' && value !== '' ? value : null;
  } catch {
    return null;
  }
}
