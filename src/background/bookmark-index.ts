import { normalizeUrl } from '@/shared/url';

/**
 * 已加入書籤的網址集合（正規化後）。
 *
 * 用集合而非每次呼叫 bookmarks.search({url})，有兩個理由：
 * 1. search 只做完全比對，`https://example.com` 與 `https://example.com/`
 *    會被當成不同網址而永遠比不中。
 * 2. 每次頁面載入完成都查一次資料庫是不必要的開銷。
 *
 * 事件頁可能被卸載，快取消失後下次呼叫會自動重建。
 */
let cache: Promise<Set<string>> | null = null;

export function invalidateBookmarkIndex(): void {
  cache = null;
}

export function bookmarkedUrls(): Promise<Set<string>> {
  cache ??= build();
  return cache;
}

export async function isBookmarked(url: string): Promise<boolean> {
  return (await bookmarkedUrls()).has(normalizeUrl(url));
}

async function build(): Promise<Set<string>> {
  const urls = new Set<string>();
  const tree = await browser.bookmarks.getTree();
  const root = tree[0];
  if (root !== undefined) {
    collect(root, urls);
  }
  return urls;
}

function collect(node: browser.bookmarks.BookmarkTreeNode, into: Set<string>): void {
  if (node.url !== undefined) {
    into.add(normalizeUrl(node.url));
  }
  for (const child of node.children ?? []) {
    collect(child, into);
  }
}
