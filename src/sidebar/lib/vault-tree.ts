import type { PrivateFolder } from '@/shared/types';
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
