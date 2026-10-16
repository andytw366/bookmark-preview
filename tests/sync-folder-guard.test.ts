import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 隱私空間的同步資料夾在自己的介面裡要「不存在」（NEXT.md 方案 4 的 B 期）。
 *
 * 漏掉一處的症狀很難看出是這裡的問題：側邊欄多一個空資料夾、「其他書籤」筆數不對、
 * 每次同步側邊欄閃一下 —— 所以用假的 `browser.bookmarks` 把幾個入口釘住。
 */

const SYNC_FOLDER = 'syncFolder01';

vi.mock('@/storage/bookmark-store', () => ({
  isSyncFolderIdSync: (id: string) => id === SYNC_FOLDER,
}));
vi.mock('@/shared/messages', () => ({ broadcast: vi.fn() }));
vi.mock('@/background/maintenance', () => ({ pruneOrphanThumbs: vi.fn(async () => undefined) }));

type Node = browser.bookmarks.BookmarkTreeNode;

const TREE: Node = {
  id: 'root________',
  title: '',
  children: [
    {
      id: 'unfiled_____',
      parentId: 'root________',
      title: 'Other Bookmarks',
      type: 'folder',
      children: [
        { id: 'b1', parentId: 'unfiled_____', title: 'Example', url: 'https://example.com/', type: 'bookmark' },
        {
          id: SYNC_FOLDER,
          parentId: 'unfiled_____',
          title: 'Bookmark Preview: vault sync data (do not edit)',
          type: 'folder',
          children: [
            // 正常是 data:；這裡故意放一筆 https，確認擋的是「在資料夾裡」而不是靠 data: 被濾掉
            { id: 'c0', parentId: SYNC_FOLDER, title: '', url: 'https://hidden.example/', type: 'bookmark' },
            { id: 'c1', parentId: SYNC_FOLDER, title: '', url: 'data:,abc234', type: 'bookmark' },
          ],
        },
      ],
    },
  ],
} as Node;

function find(node: Node, id: string): Node | undefined {
  if (node.id === id) {
    return node;
  }
  for (const child of node.children ?? []) {
    const hit = find(child, id);
    if (hit !== undefined) {
      return hit;
    }
  }
  return undefined;
}

type Listener = (...args: unknown[]) => void;
const listeners: Record<string, Listener[]> = {};

function event(name: string): { addListener: (fn: Listener) => void } {
  listeners[name] = [];
  return { addListener: (fn) => listeners[name]?.push(fn) };
}

function fire(name: string, ...args: unknown[]): void {
  for (const fn of listeners[name] ?? []) {
    fn(...args);
  }
}

beforeEach(() => {
  vi.stubGlobal('browser', {
    bookmarks: {
      getTree: async () => [TREE],
      get: async (id: string) => {
        const node = find(TREE, id);
        if (node === undefined) {
          throw new Error('not found');
        }
        return [node];
      },
      onCreated: event('onCreated'),
      onRemoved: event('onRemoved'),
      onChanged: event('onChanged'),
      onMoved: event('onMoved'),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('bookmark-tree', () => {
  it('collectRoots 不含同步資料夾，「其他書籤」只剩真正的書籤', async () => {
    const { collectRoots } = await import('@/background/bookmark-tree');
    const roots = await collectRoots();
    const unfiled = roots.find((root) => root.id === 'unfiled_____');
    expect(unfiled?.children.map((child) => child.id)).toEqual(['b1']);
  });

  it('「移動到…」的選單不列同步資料夾', async () => {
    const { collectFolderChoices } = await import('@/background/bookmark-tree');
    const ids = (await collectFolderChoices()).map((choice) => choice.id);
    expect(ids).toContain('unfiled_____');
    expect(ids).not.toContain(SYNC_FOLDER);
  });
});

describe('bookmark-index', () => {
  it('已加入書籤的索引不收同步資料夾裡的網址', async () => {
    const { bookmarkedUrls, invalidateBookmarkIndex } = await import('@/background/bookmark-index');
    invalidateBookmarkIndex();
    const urls = [...(await bookmarkedUrls())];
    expect(urls.some((url) => url.includes('example.com'))).toBe(true);
    expect(urls.some((url) => url.includes('hidden.example') || url.startsWith('data:'))).toBe(false);
  });
});

describe('sync-folder-guard', () => {
  it('資料夾本身與它底下的書籤都算；其他不算', async () => {
    const { isSyncFolderEvent, isSyncFolderNode } = await import('@/background/sync-folder-guard');
    expect(isSyncFolderNode({ id: SYNC_FOLDER, parentId: 'unfiled_____' })).toBe(true);
    expect(isSyncFolderNode({ id: 'c1', parentId: SYNC_FOLDER })).toBe(true);
    expect(isSyncFolderNode({ id: 'b1', parentId: 'unfiled_____' })).toBe(false);
    // onChanged 沒給 parentId：要讀一次才知道
    expect(await isSyncFolderEvent('c1')).toBe(true);
    expect(await isSyncFolderEvent('b1')).toBe(false);
    expect(await isSyncFolderEvent('gone')).toBe(false);
  });

  it('寫入路徑碰到同步資料夾就丟錯', async () => {
    const { assertNotSyncFolder } = await import('@/background/sync-folder-guard');
    await expect(assertNotSyncFolder('b1', SYNC_FOLDER)).rejects.toThrow(/sync_folder_protected/);
    await expect(assertNotSyncFolder('c0')).rejects.toThrow(/sync_folder_protected/);
    await expect(assertNotSyncFolder('b1', 'unfiled_____')).resolves.toBeUndefined();
  });
});

describe('bookmark-watcher', () => {
  async function setup(): Promise<ReturnType<typeof vi.fn>> {
    vi.useFakeTimers();
    vi.resetModules();
    const { broadcast } = await import('@/shared/messages');
    const spy = vi.mocked(broadcast);
    spy.mockClear();
    const { startBookmarkWatcher } = await import('@/background/bookmark-watcher');
    startBookmarkWatcher();
    return spy;
  }

  async function settle(): Promise<void> {
    // onChanged 的判斷要等一次 bookmarks.get
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);
  }

  it('同步資料夾裡的增刪改、資料夾內換位置都不重整', async () => {
    const spy = await setup();
    fire('onCreated', 'c2', { id: 'c2', parentId: SYNC_FOLDER, title: '', url: 'data:,x' });
    fire('onCreated', SYNC_FOLDER, { id: SYNC_FOLDER, parentId: 'unfiled_____', title: 'x' });
    fire('onRemoved', 'c1', { parentId: SYNC_FOLDER, index: 0, node: { id: 'c1', title: '' } });
    fire('onRemoved', SYNC_FOLDER, { parentId: 'unfiled_____', index: 1, node: { id: SYNC_FOLDER, title: '' } });
    fire('onChanged', 'c1', { title: '', url: 'data:,y' });
    fire('onMoved', 'c1', { parentId: SYNC_FOLDER, oldParentId: SYNC_FOLDER, index: 1, oldIndex: 0 });
    await settle();
    expect(spy).not.toHaveBeenCalled();
  });

  it('一般書籤的事件照常重整；從同步資料夾搬出來也要重整（畫面上多了東西）', async () => {
    const spy = await setup();
    fire('onChanged', 'b1', { title: 'renamed' });
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockClear();
    fire('onMoved', 'c0', { parentId: 'unfiled_____', oldParentId: SYNC_FOLDER, index: 0, oldIndex: 0 });
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
