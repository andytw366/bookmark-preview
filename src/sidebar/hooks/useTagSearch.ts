import { useEffect, useState } from 'react';
import { request, subscribe, type StoredGroup } from '@/shared/messages';
import { tagQuery, type TagHit } from '@/shared/groups';
import type { TreeIndex } from '../lib/tree';

/**
 * 書籤搜尋的 `#名稱`：問背景頁哪些群組名稱相符（群組資料存在背景頁那邊）。
 *
 * 回傳 null = 不是 tag 搜尋、或還在問。成員要真的還在群組的那個資料夾裡才算 ——
 * 書籤被搬走之後背景頁的清理是非同步的，那一瞬間讀到的資料可能慢一步。
 * 群組變了（`grid/changed`）就重問，搜尋結果跟著更新。
 */
export function useTagSearch(query: string, index: TreeIndex): TagHit[] | null {
  const name = tagQuery(query);
  const [found, setFound] = useState<{ name: string; groups: { folderId: string; group: StoredGroup }[] } | null>(null);

  useEffect(() => {
    if (name === null) {
      return;
    }
    let alive = true;
    const load = (): void => {
      void request('groups/find', { name }).then(
        (groups) => {
          if (alive) {
            setFound({ name, groups });
          }
        },
        () => {
          if (alive) {
            setFound({ name, groups: [] });
          }
        },
      );
    };
    load();
    const off = subscribe('grid/changed', load);
    return () => {
      alive = false;
      off();
    };
  }, [name]);

  if (name === null || found?.name !== name) {
    return null;
  }
  return found.groups.map(({ folderId, group: { members, ...group } }) => ({
    folderId,
    group,
    members: members.filter((id) => index.parentOf.get(id) === folderId),
  }));
}
