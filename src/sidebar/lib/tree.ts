import type { BookmarkFolder, BookmarkLink, BookmarkNode } from '@/shared/types';

export interface TreeIndex {
  byId: Map<string, BookmarkNode>;
  parentOf: Map<string, string | null>;
}

export function buildIndex(roots: BookmarkNode[]): TreeIndex {
  const byId = new Map<string, BookmarkNode>();
  const parentOf = new Map<string, string | null>();

  const walk = (nodes: BookmarkNode[], parentId: string | null): void => {
    for (const node of nodes) {
      byId.set(node.id, node);
      parentOf.set(node.id, parentId);
      if (node.kind === 'folder') {
        walk(node.children, node.id);
      }
    }
  };

  walk(roots, null);
  return { byId, parentOf };
}

/** 從根到指定資料夾的路徑，用於麵包屑。 */
export function pathTo(index: TreeIndex, folderId: string): BookmarkFolder[] {
  const path: BookmarkFolder[] = [];
  let cursor: string | null = folderId;

  while (cursor !== null) {
    const node = index.byId.get(cursor);
    if (node === undefined) {
      break;
    }
    if (node.kind === 'folder') {
      path.unshift(node);
    }
    cursor = index.parentOf.get(cursor) ?? null;
  }

  return path;
}

/**
 * 全樹搜尋連結。搜尋時忽略目前所在的資料夾，比對標題與網址。
 *
 * 上限原本是 300，理由是「沒有上限會一次渲染數千列而卡頓」。**清單改成虛擬
 * 滾動之後那個理由消失了** —— 渲染量只跟視窗大小有關，與結果筆數無關
 * （實測 3000 筆從約 220 毫秒降到 8 毫秒）。
 *
 * 仍然留一個上限，但它現在的用途不同：搜尋走的是整棵樹，命中數是使用者輸入
 * 決定的，一個字元可能命中全部書籤。上限只是不讓結果陣列無界成長，
 * 順便保住「已達顯示上限」那句提示。五千筆遠超過任何人會捲完的量。
 */
const SEARCH_LIMIT = 5000;

export interface SearchOutcome {
  links: BookmarkLink[];
  truncated: boolean;
}

export function searchLinks(roots: BookmarkNode[], query: string): SearchOutcome {
  const needle = query.toLowerCase();
  const links: BookmarkLink[] = [];
  let truncated = false;

  const walk = (nodes: BookmarkNode[]): void => {
    for (const node of nodes) {
      if (links.length >= SEARCH_LIMIT) {
        truncated = true;
        return;
      }
      if (node.kind === 'folder') {
        walk(node.children);
        continue;
      }
      if (node.title.toLowerCase().includes(needle) || node.url.toLowerCase().includes(needle)) {
        links.push(node);
      }
    }
  };

  walk(roots);
  return { links, truncated };
}

/*
 * 算過的子樹記下來。
 *
 * 資料夾列上的「N 個書籤」會遞迴整棵子樹，而它在**每一次重繪**都重算一遍 ——
 * 一個裝了幾千筆的資料夾，光是捲動就會反覆走完整棵樹。
 *
 * 用 WeakMap 以 children 陣列本身當鍵，而不是自己維護一份索引：
 * 書籤樹每次重讀都是整棵重建（`bookmark-tree.ts` 全程 `map`，沒有原地修改），
 * 所以陣列的識別本身就是「這份資料有沒有變」的正確判準，不會有失效的問題，
 * 也不必把一個計數表從 App 一路傳到每一列。
 */
const counted = new WeakMap<readonly BookmarkNode[], number>();

export function countLinks(nodes: BookmarkNode[]): number {
  const cached = counted.get(nodes);
  if (cached !== undefined) {
    return cached;
  }
  const total = nodes.reduce(
    (sum, node) => sum + (node.kind === 'link' ? 1 : countLinks(node.children)),
    0,
  );
  counted.set(nodes, total);
  return total;
}
