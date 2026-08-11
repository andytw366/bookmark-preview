import { broadcast } from '@/shared/messages';
import { invalidateBookmarkIndex } from './bookmark-index';
import { pruneOrphanThumbs } from './maintenance';

/**
 * 監聽書籤變動並通知側邊欄重新載入。
 *
 * 去抖動的理由：拖曳搬移一批書籤或匯入書籤檔時，Firefox 會連續丟出
 * 大量事件，每次都重建整棵樹會讓側邊欄閃爍。
 */
const DEBOUNCE_MS = 200;

let timer: ReturnType<typeof setTimeout> | undefined;

function scheduleInvalidation(): void {
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  timer = setTimeout(() => {
    timer = undefined;
    invalidateBookmarkIndex();
    broadcast('bookmarks/invalidated', undefined);
    // 書籤被刪除時順手清掉它的縮圖，避免快取無限膨脹
    void pruneOrphanThumbs().catch((cause: unknown) => {
      console.warn('[bookmark-preview] failed to sweep orphaned thumbnails', cause);
    });
  }, DEBOUNCE_MS);
}

export function startBookmarkWatcher(): void {
  browser.bookmarks.onCreated.addListener(scheduleInvalidation);
  browser.bookmarks.onRemoved.addListener(scheduleInvalidation);
  browser.bookmarks.onChanged.addListener(scheduleInvalidation);
  browser.bookmarks.onMoved.addListener(scheduleInvalidation);
}
