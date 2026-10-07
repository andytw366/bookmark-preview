import { useEffect, useState } from 'react';
import { request, subscribe, type StoredGroup } from '@/shared/messages';

/**
 * 一個原生書籤資料夾的群組。資料夾換了、或背景頁廣播這個資料夾的群組變了就重讀。
 *
 * 書籤被別處刪掉或搬走時背景頁也會清理群組並廣播，所以這裡不必自己對書籤樹做什麼。
 */
export function useBookmarkGroups(folderId: string | null): StoredGroup[] {
  const [groups, setGroups] = useState<StoredGroup[]>([]);

  useEffect(() => {
    if (folderId === null) {
      setGroups([]);
      return;
    }
    let alive = true;
    const load = (): void => {
      void request('groups/list', { folderId }).then(
        (next) => {
          if (alive) {
            setGroups(next);
          }
        },
        () => undefined,
      );
    };
    load();
    const off = subscribe('groups/changed', (event) => {
      if (event.folderId === folderId) {
        load();
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [folderId]);

  return groups;
}
