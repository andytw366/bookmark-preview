import type { FolderChoice } from '@/shared/messages';
import type { BookmarkFolder, BookmarkNode } from '@/shared/types';
import { isPreviewableUrl } from '@/shared/url';
import { t } from '@/shared/i18n';

/**
 * 讀取 Firefox 書籤樹，轉成側邊欄使用的統一型別。
 *
 * 回傳的是頂層根資料夾（書籤工具列／書籤選單／其他書籤／行動書籤），
 * 並過濾掉沒有任何連結的根 —— 「行動書籤」對多數人是空的，
 * 列出來只是噪音。
 */
export async function collectRoots(): Promise<BookmarkFolder[]> {
  const tree = await browser.bookmarks.getTree();
  const root = tree[0];
  if (root === undefined) {
    return [];
  }
  return (root.children ?? [])
    .map(toNode)
    .filter((node): node is BookmarkFolder => node !== null && node.kind === 'folder')
    .filter((folder) => countLinks(folder) > 0);
}

function toNode(raw: browser.bookmarks.BookmarkTreeNode): BookmarkNode | null {
  if (raw.type === 'separator') {
    return null;
  }

  const base = {
    id: raw.id,
    parentId: raw.parentId ?? null,
    title: raw.title,
    dateAdded: raw.dateAdded ?? null,
    source: 'native' as const,
  };

  // Firefox 會給 type，但舊資料偶有缺漏，因此以 url 是否存在作為後備判斷
  const isFolder = raw.type === 'folder' || raw.url === undefined;
  if (isFolder) {
    return {
      ...base,
      kind: 'folder',
      children: (raw.children ?? []).map(toNode).filter((node): node is BookmarkNode => node !== null),
    };
  }

  if (raw.url === undefined || !isPreviewableUrl(raw.url)) {
    return null;
  }
  return { ...base, kind: 'link', url: raw.url };
}

/**
 * 扁平化的資料夾清單，供右鍵「移動到…」使用。
 *
 * 側邊欄很窄，放不下縮排的樹狀選擇器，所以回傳帶 depth 的扁平清單，
 * 由 UI 用縮排字元呈現層級。
 */
export async function collectFolderChoices(): Promise<FolderChoice[]> {
  const tree = await browser.bookmarks.getTree();
  const root = tree[0];
  const choices: FolderChoice[] = [];
  if (root === undefined) {
    return choices;
  }
  const walk = (node: browser.bookmarks.BookmarkTreeNode, depth: number): void => {
    for (const child of node.children ?? []) {
      const isFolder = child.type === 'folder' || child.url === undefined;
      if (!isFolder) {
        continue;
      }
      choices.push({ id: child.id, title: child.title || t('folder_untitled'), depth });
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return choices;
}

function countLinks(folder: BookmarkFolder): number {
  return folder.children.reduce(
    (total, child) => total + (child.kind === 'link' ? 1 : countLinks(child)),
    0,
  );
}
