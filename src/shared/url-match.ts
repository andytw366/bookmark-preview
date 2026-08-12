import { hostnameOf, normalizeUrl } from './url';

/**
 * 「書籤裡的網址」與「分頁現在停在的網址」的比對規則。
 *
 * 為什麼需要比 `normalizeUrl` 更寬的比對：**書籤存的網址常常不是最後停下來的
 * 那一個。** 實測使用者回報的四個「怎麼樣都抓不到」的站台，三個都是這個原因：
 *
 * | 書籤 | 分頁實際停在 |
 * |---|---|
 * | `http://www01.eyny.com/forum.php?gid=10` | `https://…`（http → https） |
 * | `http://www.poelab.com/` | `https://…`（http → https） |
 * | `https://poedb.tw/` | `https://poedb.tw/tw/`（依語系轉址） |
 *
 * `normalizeUrl` 保留協定與路徑，所以每一組在系統裡都是兩個不同的頁面，於是
 * 造訪時的自動擷取完全不跑（`isBookmarked` 對轉址後的網址回 false）、右鍵重抓
 * 找不到「開著的分頁」、連手動指定都會記成 `manual:not-bookmarked`。
 *
 * **這裡放寬的是「比對」，不是縮圖的鍵。** `urlKey` 仍然用 `normalizeUrl`：
 * 那是磁碟上既有縮圖的鍵，改了等於所有人的預覽圖一次全部對不上。所以配對成功之後
 * 一律用**書籤自己的網址**去算鍵，寫回它身上。
 */

/**
 * 忽略協定的頁面鍵。
 *
 * 只對 http/https 生效 —— 其他協定原樣回傳，`ftp://a/b` 不該與 `http://a/b`
 * 撞成同一頁。
 */
export function schemelessKey(url: string): string {
  const normalized = normalizeUrl(url);
  const scheme = /^https?:\/\//.exec(normalized);
  return scheme === null ? normalized : normalized.slice(scheme[0].length);
}

/** 兩個網址是不是同一頁，容許 http/https 的差異。 */
export function isSamePageIgnoringScheme(a: string, b: string): boolean {
  return schemelessKey(a) === schemelessKey(b);
}

/** 怎麼配上的。診斷用 —— 「配上了」與「怎麼配上的」在查問題時是兩件事。 */
export type MatchVia = 'exact' | 'scheme' | 'redirect';

export interface BookmarkIndex {
  /** 正規化後的書籤網址 */
  exact: ReadonlySet<string>;
  /** 去掉協定的鍵 → 正規化後的書籤網址 */
  schemeless: ReadonlyMap<string, string>;
}

export interface PageMatch {
  /** 命中的書籤網址。縮圖要寫在**它**的鍵上，不是分頁那個網址 */
  bookmarkUrl: string;
  via: MatchVia;
}

/**
 * 這個分頁對應到哪一個書籤。
 *
 * 三層，由嚴到寬：完全相同 → 只差協定 → 某個書籤已知會轉址到這裡。
 * 純函式，資料由呼叫端準備（索引在 `bookmark-index.ts`，轉址表在
 * `storage/redirect-map.ts`）。
 */
export function matchBookmarkForPage(
  pageUrl: string,
  index: BookmarkIndex,
  redirects: ReadonlyMap<string, string>,
): PageMatch | null {
  const exact = normalizeUrl(pageUrl);
  if (index.exact.has(exact)) {
    return { bookmarkUrl: exact, via: 'exact' };
  }
  const acrossScheme = index.schemeless.get(schemelessKey(pageUrl));
  if (acrossScheme !== undefined) {
    return { bookmarkUrl: acrossScheme, via: 'scheme' };
  }
  for (const [bookmarkUrl, target] of redirects) {
    // 書籤可能已經被刪掉了，轉址表留著它是無害的，但不能拿它去配
    if (index.exact.has(bookmarkUrl) && isSamePageIgnoringScheme(target, pageUrl)) {
      return { bookmarkUrl, via: 'redirect' };
    }
  }
  return null;
}

/**
 * 值得為了「它可能轉址到這一頁」而去解析的書籤。
 *
 * 解析要發一個請求，所以條件要窄。同一個主機是必要條件；再加上「書籤是站台首頁」
 * 或「這一頁的網址以書籤的網址開頭」—— 那涵蓋了實際的轉址形狀（首頁轉到語系或
 * dashboard 路徑），又不會讓「在某站有一個書籤」變成「在那站每逛一頁都多發請求」。
 *
 * 已經是同一頁的不必解析（上面兩層就配上了）。
 */
export function isPlausibleRedirectSource(bookmarkUrl: string, pageUrl: string): boolean {
  if (hostnameOf(bookmarkUrl) !== hostnameOf(pageUrl)) {
    return false;
  }
  if (isSamePageIgnoringScheme(bookmarkUrl, pageUrl)) {
    return false;
  }
  let path: string;
  try {
    path = new URL(bookmarkUrl).pathname;
  } catch {
    return false;
  }
  return path === '/' || schemelessKey(pageUrl).startsWith(schemelessKey(bookmarkUrl));
}
