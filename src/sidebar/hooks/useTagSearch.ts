import { useEffect, useState } from 'react';
import { request, subscribe } from '@/shared/messages';
import { tagQuery } from '@/shared/groups';
import type { TreeIndex } from '../lib/tree';

/**
 * 書籤搜尋的 `#名稱`：問背景頁哪些書籤在名稱相符的群組裡（群組資料存在背景頁那邊）。
 *
 * 回傳 null = 不是 tag 搜尋、或還在問。成員要真的還在群組的那個資料夾裡才算 ——
 * 書籤被搬走之後背景頁的清理是非同步的，那一瞬間讀到的資料可能慢一步。
 * 群組變了（`grid/changed`）就重問，搜尋結果跟著更新。
 */
export function useTagSearch(query: string, index: TreeIndex): ReadonlySet<string> | null {
  const name = tagQuery(query);
  const [found, setFound] = useState<{ name: string; members: { folderId: string; id: string }[] } | null>(null);

  useEffect(() => {
    if (name === null) {
      return;
    }
    let alive = true;
    const load = (): void => {
      void request('groups/find', { name }).then(
        (members) => {
          if (alive) {
            setFound({ name, members });
          }
        },
        () => {
          if (alive) {
            setFound({ name, members: [] });
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
  return new Set(
    found.members.filter((member) => index.parentOf.get(member.id) === member.folderId).map((member) => member.id),
  );
}
