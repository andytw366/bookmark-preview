import { normalizeUrl } from '@/shared/url';
import {
  isPlausibleRedirectSource,
  matchBookmarkForPage,
  schemelessKey,
  type BookmarkIndex,
  type PageMatch,
} from '@/shared/url-match';
import { loadRedirects, rememberRedirect } from '@/storage/redirect-map';
import { resolveFinalUrlViaTab } from './redirect-resolve';

/**
 * 已加入書籤的網址索引。
 *
 * 用索引而非每次呼叫 bookmarks.search({url})，有兩個理由：
 * 1. search 只做完全比對，`https://example.com` 與 `https://example.com/`
 *    會被當成不同網址而永遠比不中。
 * 2. 每次頁面載入完成都查一次資料庫是不必要的開銷。
 *
 * 除了完全比對的集合，另外備一份**去掉協定**的對照表：多年前存的書籤幾乎都是
 * `http://`，而現在幾乎每個站台都轉到 `https://`（比對規則見 `shared/url-match.ts`）。
 * 兩份一起建，因為它們一定要描述同一批書籤 —— 分開建就有機會漂走。
 *
 * 事件頁可能被卸載，快取消失後下次呼叫會自動重建。
 */
let cache: Promise<BookmarkIndex> | null = null;

/**
 * 一次頁面載入最多解析幾個書籤的轉址。
 *
 * 解析要發請求，所以要有上限；而候選本來就窄（同一個主機、而且是首頁或是這一頁的
 * 前綴，見 `isPlausibleRedirectSource`），實務上幾乎都是 0 或 1 個。
 */
const RESOLVE_LIMIT = 3;

export function invalidateBookmarkIndex(): void {
  cache = null;
}

function index(): Promise<BookmarkIndex> {
  cache ??= build();
  return cache;
}

export async function bookmarkedUrls(): Promise<Set<string>> {
  return new Set((await index()).exact);
}

export async function isBookmarked(url: string): Promise<boolean> {
  return (await index()).exact.has(normalizeUrl(url));
}

/**
 * 這個分頁對應到哪一個書籤 —— 只比對，不發任何請求。
 *
 * 回傳的是**書籤自己的網址**，縮圖的鍵要從它算（見 `shared/url-match.ts` 開頭）。
 */
export async function matchBookmark(pageUrl: string): Promise<PageMatch | null> {
  return matchBookmarkForPage(pageUrl, await index(), await loadRedirects());
}

/**
 * 同上，但配不上時借這個分頁解析一次轉址。
 *
 * `remember` 決定要不要把結果寫進 `storage.local`。**隱私書籤一律傳 false** ——
 * 那張表會把網址明文留在磁碟上（見 `storage/redirect-map.ts`）。
 *
 * 解析過的書籤（不論有沒有轉址）都會記下來，所以同一個書籤只會被問一次。
 */
export async function resolveBookmarkForPage(
  pageUrl: string,
  tabId: number,
  remember = true,
): Promise<PageMatch | null> {
  const direct = await matchBookmark(pageUrl);
  if (direct !== null) {
    return direct;
  }

  const known = await loadRedirects();
  const candidates = [...(await index()).exact]
    .filter((bookmarkUrl) => !known.has(bookmarkUrl) && isPlausibleRedirectSource(bookmarkUrl, pageUrl))
    .slice(0, RESOLVE_LIMIT);

  for (const bookmarkUrl of candidates) {
    const finalUrl = await resolveFinalUrlViaTab(tabId, bookmarkUrl);
    if (finalUrl === null) {
      continue;
    }
    if (remember) {
      await rememberRedirect(bookmarkUrl, finalUrl);
    }
    if (schemelessKey(finalUrl) === schemelessKey(pageUrl)) {
      return { bookmarkUrl, via: 'redirect' };
    }
  }
  return null;
}

async function build(): Promise<BookmarkIndex> {
  const exact = new Set<string>();
  const schemeless = new Map<string, string>();
  const tree = await browser.bookmarks.getTree();
  const root = tree[0];
  if (root !== undefined) {
    collect(root, exact);
  }
  for (const url of exact) {
    // 同一個頁面同時存了 http 與 https 兩筆時，先看到的那筆代表它 ——
    // 兩筆的鍵不同，但既然只差協定，配上哪一筆都比配不上好
    const key = schemelessKey(url);
    if (!schemeless.has(key)) {
      schemeless.set(key, url);
    }
  }
  return { exact, schemeless };
}

function collect(node: browser.bookmarks.BookmarkTreeNode, into: Set<string>): void {
  if (node.url !== undefined) {
    into.add(normalizeUrl(node.url));
  }
  for (const child of node.children ?? []) {
    collect(child, into);
  }
}
