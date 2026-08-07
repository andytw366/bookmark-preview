import type { PrivateBookmark, PrivateFolder } from './types';
import { isPreviewableUrl } from './url';

/**
 * 整個資料夾進出隱私空間的**轉換規則**。
 *
 * 放在 shared 而不是背景頁，因為這裡是純函式：整棵子樹要怎麼對應成
 * `PrivateFolder` / `PrivateBookmark`（以及反過來）是這個功能最容易寫錯的地方，
 * 而寫錯的代價是整個子樹的書籤消失。純函式才能把每一條規則用測試釘住，
 * 不必先架一個假的 `browser.bookmarks`。
 *
 * IO（真的去建立／刪除書籤、加解密縮圖、落地）留在 `background/vault.ts`，
 * 這裡只計畫、不動手。
 */

/** 只取轉換需要的欄位，測試才不必造一整棵 Firefox 書籤節點。 */
export interface NativeNode {
  id: string;
  title: string;
  type?: string | undefined;
  url?: string | undefined;
  children?: NativeNode[] | undefined;
}

export interface PlannedFolder {
  id: string;
  name: string;
  parentId: string | null;
}

export interface PlannedBookmark {
  /** 原生書籤 id —— 移入之後要用它把縮圖搬過去 */
  nativeId: string;
  url: string;
  title: string;
  folderId: string;
}

export interface ImportPlan {
  folders: PlannedFolder[];
  bookmarks: PlannedBookmark[];
  /** 略過的項目數（`place:` 智慧書籤、分隔線這類進了隱私空間也沒意義的東西） */
  skipped: number;
}

/** 巢狀深度上限。真實書籤不會這麼深，這是防資料損毀造成的無窮遞迴。 */
const MAX_DEPTH = 20;

/**
 * 把一棵原生書籤子樹算成隱私空間的記錄。
 *
 * 規則：
 * - **根節點自己也會變成一個資料夾**（放在 `parentId` 底下），不是把內容攤平。
 * - **空的子資料夾照建** —— 不然使用者的分類結構會在移入之後被壓平。
 * - `place:` 智慧書籤與分隔線略過（`isPreviewableUrl` 判定），計入 `skipped`。
 * - 回傳的 `folders` 保證**父在子之前**，呼叫端可以照順序建立。
 */
export function planFolderImport(
  root: NativeNode,
  parentId: string | null,
  newId: () => string,
): ImportPlan {
  const plan: ImportPlan = { folders: [], bookmarks: [], skipped: 0 };

  const walk = (node: NativeNode, targetParent: string | null, depth: number): void => {
    const folderId = newId();
    plan.folders.push({ id: folderId, name: node.title, parentId: targetParent });
    if (depth >= MAX_DEPTH) {
      return;
    }
    for (const child of node.children ?? []) {
      if (child.type === 'separator') {
        plan.skipped += 1;
        continue;
      }
      if (child.url === undefined) {
        walk(child, folderId, depth + 1);
        continue;
      }
      if (!isPreviewableUrl(child.url)) {
        plan.skipped += 1;
        continue;
      }
      plan.bookmarks.push({
        nativeId: child.id,
        url: child.url,
        title: child.title,
        folderId,
      });
    }
  };

  walk(root, parentId, 0);
  return plan;
}

export interface ExportPlan {
  /** 要建立的原生資料夾，**父在子之前**（`parentId` 指向隱私空間裡的 id） */
  folders: { id: string; name: string; parentId: string | null }[];
  /** 要還原成原生書籤的隱私書籤 */
  bookmarks: PrivateBookmark[];
}

/**
 * 把隱私空間裡的一棵子樹算成「要建立哪些原生資料夾與書籤」。
 *
 * 與 `planFolderImport` 對稱：根資料夾自己也會被建出來，空的子資料夾照建，
 * 順序保證父在子之前（原生資料夾必須先有父才建得了子）。
 *
 * 已刪除（墓碑）的記錄一律不算 —— 它們只是還沒被清掉的刪除標記。
 */
export function planFolderExport(
  folders: readonly PrivateFolder[],
  bookmarks: readonly PrivateBookmark[],
  rootId: string,
): ExportPlan {
  const alive = folders.filter((folder) => folder.deleted !== true);
  const root = alive.find((folder) => folder.id === rootId);
  if (root === undefined) {
    return { folders: [], bookmarks: [] };
  }

  const plan: ExportPlan = { folders: [], bookmarks: [] };
  const walk = (folder: PrivateFolder, depth: number): void => {
    plan.folders.push({ id: folder.id, name: folder.name, parentId: folder.parentId });
    plan.bookmarks.push(
      ...bookmarks.filter((item) => item.deleted !== true && item.folderId === folder.id),
    );
    if (depth >= MAX_DEPTH) {
      return;
    }
    for (const child of alive.filter((item) => item.parentId === folder.id)) {
      walk(child, depth + 1);
    }
  };

  walk(root, 0);
  return plan;
}
