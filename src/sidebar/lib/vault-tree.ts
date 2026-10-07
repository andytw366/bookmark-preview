import { tagMatches, tagQuery, type TagHit } from '@/shared/groups';
import type { PrivateBookmark, PrivateFolder } from '@/shared/types';
import {
  vaultChildren,
  vaultGroupEntry,
  vaultGroupOf,
  type VaultChild,
  type VaultLayout,
} from '@/shared/vault-layout';
import type { CrumbPath } from '../components/Breadcrumb';

/**
 * 從資料夾往上走到根，組出麵包屑要的路徑。
 *
 * 隱私空間的資料夾是自己一套（`PrivateFolder`，靠 `parentId` 串起來），
 * 不能用一般書籤的 `pathTo` —— 那個吃的是已經建好的樹索引。
 */
export function vaultPathTo(folders: PrivateFolder[], folderId: string | null): CrumbPath[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const path: CrumbPath[] = [];
  let cursor = folderId;
  // 有上限是為了防資料損毀造成的環狀 parentId 讓 UI 卡死
  for (let depth = 0; cursor !== null && depth < 32; depth += 1) {
    const folder = byId.get(cursor);
    if (folder === undefined) {
      break;
    }
    path.unshift({ id: folder.id, title: folder.name });
    cursor = folder.parentId;
  }
  return path;
}

/**
 * 隱私空間的搜尋，規則與書籤那邊（`searchTree`）一樣：一般的字找資料夾名稱與書籤的標題、網址，
 * 資料夾在前；`#名稱` 找名稱相符的群組成員（跨資料夾）。
 *
 * 全在記憶體裡做（解開的資料本來就在畫面這邊），搜尋字不送去任何地方。
 * 結果照資料夾由上往下走（每個資料夾照它的版面順序），同一個群組的成員因此排在一起。
 */
export function searchVault<F extends PrivateFolder, B extends PrivateBookmark>(
  folders: readonly F[],
  bookmarks: readonly B[],
  layout: VaultLayout,
  query: string,
): VaultChild<F, B>[] {
  const tag = tagQuery(query);
  const needle = query.trim().toLowerCase();
  const groupOf = vaultGroupOf(layout);
  /** 記錄所在的群組合不合：群組還在、在同一個資料夾、名稱相符 */
  const tagged = (record: B): boolean => {
    const groupId = groupOf(record.id);
    const entry = groupId === null ? null : vaultGroupEntry(layout, groupId);
    return entry !== null && tag !== null && entry.folderId === record.folderId && tagMatches(entry.name, tag);
  };
  const hits: VaultChild<F, B>[] = [];
  const folderHits: VaultChild<F, B>[] = [];
  const seen = new Set<string | null>();
  const walk = (folderId: string | null, depth: number): void => {
    // 環狀 parentId（資料損毀）不要讓它無窮遞迴
    if (seen.has(folderId) || depth > 32) {
      return;
    }
    seen.add(folderId);
    for (const child of vaultChildren(folders, bookmarks, folderId, layout)) {
      if (child.kind === 'folder') {
        if (tag === null && child.folder.name.toLowerCase().includes(needle)) {
          folderHits.push(child);
        }
        walk(child.folder.id, depth + 1);
      } else if (
        tag !== null
          ? tagged(child.record)
          : child.record.title.toLowerCase().includes(needle) || child.record.url.toLowerCase().includes(needle)
      ) {
        hits.push(child);
      }
    }
  };
  walk(null, 0);
  return [...folderHits, ...hits];
}

/** `#名稱` 搜尋找到的群組（搜尋結果裡照樣畫出來）。不是 tag 搜尋回空陣列 */
export function vaultTagHits(bookmarks: readonly PrivateBookmark[], layout: VaultLayout, query: string): TagHit[] {
  const tag = tagQuery(query);
  if (tag === null) {
    return [];
  }
  const groupOf = vaultGroupOf(layout);
  return Object.keys(layout.sections.groups ?? {}).flatMap((id) => {
    const entry = vaultGroupEntry(layout, id);
    if (entry === null || !tagMatches(entry.name, tag)) {
      return [];
    }
    return [
      {
        folderId: entry.folderId,
        group: { id, name: entry.name, color: entry.color, ...(entry.pinned === true ? { pinned: true } : {}) },
        members: bookmarks
          .filter((record) => record.folderId === entry.folderId && groupOf(record.id) === id)
          .map((record) => record.id),
      },
    ];
  });
}
