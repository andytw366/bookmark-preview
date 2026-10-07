import { useEffect, useState } from 'react';
import { request, subscribe, type BookmarkGrid } from '@/shared/messages';

/**
 * 一個原生書籤資料夾的固定格子與群組：null = 還沒定下來（自動換行），undefined = 還在讀。
 * 資料夾換了、或背景頁廣播這個資料夾的格子變了（本機操作、別處刪書籤、另一台裝置同步過來）就重讀。
 *
 * 「還在讀」要與「沒有格子」分開：進資料夾的那一瞬間若先當成自動換行畫出來，
 * 下一幀換成固定格子，整個畫面會跳一下；那段時間裡的拖拽落點也會算在錯的格子上。
 */
export function useBookmarkGrid(folderId: string | null): BookmarkGrid | null | undefined {
  const [state, setState] = useState<{ folderId: string; grid: BookmarkGrid | null } | null>(null);

  useEffect(() => {
    if (folderId === null) {
      return;
    }
    let alive = true;
    const load = (): void => {
      void request('grid/get', { folderId }).then(
        (next) => {
          if (alive) {
            setState({ folderId, grid: next });
          }
        },
        () => {
          if (alive) {
            setState({ folderId, grid: null });
          }
        },
      );
    };
    load();
    const off = subscribe('grid/changed', (event) => {
      if (event.folderId === folderId) {
        load();
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [folderId]);

  if (folderId === null) {
    return null;
  }
  return state?.folderId === folderId ? state.grid : undefined;
}
