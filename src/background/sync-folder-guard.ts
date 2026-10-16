import { isSyncFolderIdSync } from '@/storage/bookmark-store';
import { t } from '@/shared/i18n';

/**
 * 「隱私空間的同步資料」那個書籤資料夾，在自己的介面裡一律當作不存在。
 *
 * 那個資料夾裡是一筆筆 `data:,` + 密文、標題空白的書籤（見 `storage/bookmark-store.ts`），
 * 對使用者沒有意義，被拖動、改名、移入隱私空間都會破壞同步資料。
 *
 * 判斷只用 `isSyncFolderIdSync`（同步的快取版）：過濾發生在書籤事件與樹的走訪裡，
 * 每一筆都 await 一次 storage 太慢，事件處理也要能同步決定。
 *
 * 要擋的是**資料夾本身與它底下的書籤**。資料夾是我們建的、只有一層，所以「父是它」就涵蓋
 * 底下全部；樹的走訪則是遇到資料夾就整棵剪掉，連使用者自己塞進去的子資料夾也一起藏。
 */
export function isSyncFolderNode(node: { id: string; parentId?: string | undefined }): boolean {
  return isSyncFolderIdSync(node.id) || (node.parentId !== undefined && isSyncFolderIdSync(node.parentId));
}

/**
 * 事件版：`onChanged` 只給 id 沒給 parentId，要讀一次書籤才知道它在不在資料夾裡。
 * 其他事件把手上有的 parentId 傳進來就不必讀。讀不到（已被刪掉）當作不是 —— 寧可多重整一次。
 */
export async function isSyncFolderEvent(id: string, parentId?: string): Promise<boolean> {
  if (isSyncFolderIdSync(id) || (parentId !== undefined && isSyncFolderIdSync(parentId))) {
    return true;
  }
  if (parentId !== undefined) {
    return false;
  }
  try {
    const [node] = await browser.bookmarks.get(id);
    return node?.parentId !== undefined && isSyncFolderIdSync(node.parentId);
  } catch {
    return false;
  }
}

/**
 * 寫入路徑的保護：目標或來源是同步資料夾（或它底下的書籤）就丟錯，而不是默默做掉。
 * 介面上看不到它，走到這裡多半是使用者在 Firefox 的書籤管理員把它搬進了別的資料夾，所以照實說。
 */
export async function assertNotSyncFolder(...ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    if (await isSyncFolderEvent(id)) {
      throw new Error(t('sync_folder_protected'));
    }
  }
}
