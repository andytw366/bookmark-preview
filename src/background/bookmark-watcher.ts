import { broadcast } from '@/shared/messages';
import { invalidateBookmarkIndex } from './bookmark-index';
import { pruneOrphanThumbs } from './maintenance';
import { isSyncFolderEvent, isSyncFolderNode } from './sync-folder-guard';

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

/**
 * 隱私空間的同步資料夾（與它底下的書籤）的事件不重整。
 *
 * 每次推送都會逐筆 `update`／`create`／`remove` 那幾筆 `data:` 書籤，書籤同步從別台帶過來時也是；
 * 那些東西畫面上本來就看不到，照常重整的話側邊欄每次同步都閃一下、預覽牆整個重載。
 *
 * 各事件給的資訊不同：`onCreated` 給整個節點、`onRemoved` 給 `removeInfo.parentId`、
 * `onMoved` 給新舊兩個 parentId、`onChanged` 只給 id（要讀一次才知道父是誰）。
 */
export function startBookmarkWatcher(): void {
  browser.bookmarks.onCreated.addListener((_id, node) => {
    if (!isSyncFolderNode(node)) {
      scheduleInvalidation();
    }
  });
  browser.bookmarks.onRemoved.addListener((id, info) => {
    if (!isSyncFolderNode({ id, parentId: info.parentId })) {
      scheduleInvalidation();
    }
  });
  browser.bookmarks.onChanged.addListener((id) => {
    void isSyncFolderEvent(id).then((inside) => {
      if (!inside) {
        scheduleInvalidation();
      }
    });
  });
  browser.bookmarks.onMoved.addListener((id, info) => {
    // 搬進或搬出資料夾都會改變畫面上看得到的東西，只有在資料夾裡面換位置（或搬資料夾本身）才跳過
    const hidden = (parentId: string): boolean => isSyncFolderNode({ id, parentId });
    if (!(hidden(info.parentId) && hidden(info.oldParentId))) {
      scheduleInvalidation();
    }
  });
}
