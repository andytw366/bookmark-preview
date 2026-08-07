import { useCallback, useEffect, useState } from 'react';
import { request, subscribe } from '@/shared/messages';
import type { BookmarkFolder } from '@/shared/types';

interface BookmarksState {
  /** null 代表尚未載入完成 */
  roots: BookmarkFolder[] | null;
  error: string | null;
  reload: () => void;
}

export function useBookmarks(): BookmarksState {
  const [roots, setRoots] = useState<BookmarkFolder[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setRoots(await request('bookmarks/roots', undefined));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
    // 背景頁在書籤變動時廣播，側邊欄據此重新載入
    return subscribe('bookmarks/invalidated', () => {
      void load();
    });
  }, [load]);

  return {
    roots,
    error,
    reload: () => {
      void load();
    },
  };
}
