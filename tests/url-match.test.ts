import { describe, expect, it } from 'vitest';

import { urlKey } from '../src/shared/url';
import {
  isPlausibleRedirectSource,
  isSamePageIgnoringScheme,
  matchBookmarkForPage,
  schemelessKey,
  type BookmarkIndex,
} from '../src/shared/url-match';

/**
 * 「書籤裡的網址」對上「分頁停在的網址」。
 *
 * 這一組規則是從四個真實站台回推出來的（使用者回報「1.1.0 怎麼樣都抓不到」）：
 * 三個站台的書籤都不是最後停下來的那個網址 —— 兩個 http → https，一個首頁被轉到
 * 語系路徑。比對失敗的後果是**三條路一起斷**：造訪時的自動擷取不跑、右鍵重抓找不到
 * 「開著的分頁」、手動指定記成「這一頁沒有加入書籤」。三者都不會有任何錯誤訊息，
 * 只是預覽圖永遠不出現。
 */
function indexOf(urls: string[]): BookmarkIndex {
  const exact = new Set(urls);
  const schemeless = new Map<string, string>();
  for (const url of exact) {
    const key = schemelessKey(url);
    if (!schemeless.has(key)) {
      schemeless.set(key, url);
    }
  }
  return { exact, schemeless };
}

const NONE = new Map<string, string>();

describe('忽略協定的頁面鍵', () => {
  it('http 與 https 是同一頁', () => {
    expect(isSamePageIgnoringScheme('http://a.test/x', 'https://a.test/x')).toBe(true);
  });

  it('其他協定不參與 —— ftp 與 http 不該撞成同一頁', () => {
    expect(isSamePageIgnoringScheme('ftp://a.test/x', 'http://a.test/x')).toBe(false);
  });

  it('尾端斜線與 fragment 的差異照舊忽略（沿用 normalizeUrl）', () => {
    expect(isSamePageIgnoringScheme('http://a.test', 'https://a.test/#top')).toBe(true);
  });

  it('查詢字串仍然算在內 —— 論壇的 `?gid=10` 是不同的版面', () => {
    expect(isSamePageIgnoringScheme('http://a.test/f?gid=10', 'https://a.test/f?gid=11')).toBe(false);
  });
});

describe('分頁對應到哪一個書籤', () => {
  it('完全相同時就是它', () => {
    const match = matchBookmarkForPage('https://a.test/x', indexOf(['https://a.test/x']), NONE);
    expect(match).toEqual({ bookmarkUrl: 'https://a.test/x', via: 'exact' });
  });

  /** eyny 與 poelab 的實際情況：書籤是多年前的 http，站台早就轉到 https。 */
  it('只差協定時也配上，而且回的是**書籤**那個網址', () => {
    const match = matchBookmarkForPage(
      'https://www01.eyny.com/forum.php?gid=10',
      indexOf(['http://www01.eyny.com/forum.php?gid=10']),
      NONE,
    );
    expect(match).toEqual({
      bookmarkUrl: 'http://www01.eyny.com/forum.php?gid=10',
      via: 'scheme',
    });
  });

  it('完全相同的那筆優先於只差協定的那筆', () => {
    const match = matchBookmarkForPage(
      'https://a.test/x',
      indexOf(['http://a.test/x', 'https://a.test/x']),
      NONE,
    );
    expect(match?.bookmarkUrl).toBe('https://a.test/x');
  });

  /** poedb 的實際情況：`https://poedb.tw/` 帶著 cookie 會停在 `/tw/`。 */
  it('已知會轉址到這一頁的書籤也配得上', () => {
    const match = matchBookmarkForPage(
      'https://poedb.tw/tw/',
      indexOf(['https://poedb.tw']),
      new Map([['https://poedb.tw', 'https://poedb.tw/tw']]),
    );
    expect(match).toEqual({ bookmarkUrl: 'https://poedb.tw', via: 'redirect' });
  });

  it('轉址表裡的書籤已經被刪掉時不算 —— 表是純快取，不是書籤清單', () => {
    const match = matchBookmarkForPage(
      'https://poedb.tw/tw/',
      indexOf(['https://other.test/']),
      new Map([['https://poedb.tw', 'https://poedb.tw/tw']]),
    );
    expect(match).toBeNull();
  });

  it('沒有任何書籤對得上就回 null（那一頁本來就沒被加入書籤）', () => {
    expect(matchBookmarkForPage('https://b.test/', indexOf(['https://a.test/']), NONE)).toBeNull();
  });
});

/**
 * 縮圖的鍵**沒有**跟著放寬 —— 那是磁碟上既有縮圖的鍵，改了等於所有人的預覽圖一次
 * 全部對不上。所以配對是寬的、鍵是嚴的，配上之後一律拿書籤那個網址去算鍵。
 */
describe('鍵沒有跟著放寬', () => {
  it('http 與 https 仍然是兩個不同的鍵', async () => {
    expect(await urlKey('http://a.test/x')).not.toBe(await urlKey('https://a.test/x'));
  });

  it('尾端斜線仍然是同一個鍵（本來就是）', async () => {
    expect(await urlKey('https://a.test')).toBe(await urlKey('https://a.test/'));
  });
});

/**
 * 解析轉址要發一個請求，所以候選必須窄。這幾條釘的是「不要因為在某個站台有一個
 * 書籤，就在那個站台每逛一頁都多發請求」。
 */
describe('值得解析轉址的候選', () => {
  it('站台首頁的書籤值得 —— 首頁常被轉到語系或 dashboard 路徑', () => {
    expect(isPlausibleRedirectSource('https://poedb.tw/', 'https://poedb.tw/tw/')).toBe(true);
  });

  it('這一頁是書籤網址的延伸時值得', () => {
    expect(isPlausibleRedirectSource('https://a.test/docs', 'https://a.test/docs/intro')).toBe(true);
  });

  it('同一個站台的無關頁面不值得', () => {
    expect(isPlausibleRedirectSource('https://a.test/docs', 'https://a.test/blog/1')).toBe(false);
  });

  it('不同主機不值得', () => {
    expect(isPlausibleRedirectSource('https://a.test/', 'https://b.test/x')).toBe(false);
  });

  it('`www.` 的差異不算不同主機', () => {
    expect(isPlausibleRedirectSource('http://www.poelab.com/', 'https://poelab.com/daily')).toBe(true);
  });

  it('已經是同一頁的不必解析 —— 前面兩層就配上了', () => {
    expect(isPlausibleRedirectSource('http://a.test/x', 'https://a.test/x')).toBe(false);
  });
});
