import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fromBase32, toBase32 } from '@/crypto/base32';
import type { Bytes } from '@/crypto/bytes';
import {
  BOOKMARK_CHUNK_BYTES,
  BOOKMARK_CHUNK_LIMIT,
  fromBookmarkChunks,
  initSyncFolderCache,
  isSyncFolderIdSync,
  SYNC_FOLDER_LOCAL_KEY,
  toBookmarkChunks,
} from '@/storage/bookmark-store';
import type { VaultMeta } from '@/shared/types';
import { isPackMeta, PACK_META_KEY, readPackEnvelope, writePackEnvelope } from '@/storage/pack-sync';

/**
 * 隱私空間改用書籤同步（NEXT.md 方案 4 的 A 期）：編碼、切塊、meta 版本，以及在假的
 * `browser.bookmarks` 上走一次「寫進書籤 → 讀回來」。
 */

function bytes(length: number, seed = 1): Bytes {
  const out = new Uint8Array(length);
  let x = seed;
  for (let index = 0; index < length; index += 1) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[index] = x >>> 24;
  }
  return out;
}

describe('base32', () => {
  it('各種長度往返一致，只用 a-z2-7、不補 =', () => {
    for (let length = 0; length <= 40; length += 1) {
      const input = bytes(length, length + 7);
      const text = toBase32(input);
      expect(text).toMatch(/^[a-z2-7]*$/);
      expect(text.length).toBe(Math.ceil((length * 8) / 5));
      expect(fromBase32(text)).toEqual(input);
    }
  });

  it('與 RFC 4648 的測試向量一致（小寫、去掉補位）', () => {
    const vectors: [string, string][] = [
      ['f', 'my'],
      ['fo', 'mzxq'],
      ['foo', 'mzxw6'],
      ['foob', 'mzxw6yq'],
      ['fooba', 'mzxw6ytb'],
      ['foobar', 'mzxw6ytboi'],
    ];
    for (const [plain, encoded] of vectors) {
      expect(toBase32(new TextEncoder().encode(plain))).toBe(encoded);
      expect(new TextDecoder().decode(fromBase32(encoded))).toBe(plain);
    }
  });

  it('字母表外的字元與不可能的長度丟錯', () => {
    expect(() => fromBase32('MZXQ')).toThrow();
    expect(() => fromBase32('mzxq=')).toThrow();
    expect(() => fromBase32('mz-q')).toThrow();
    expect(() => fromBase32('m')).toThrow();
    expect(() => fromBase32('mzx')).toThrow();
  });
});

describe('書籤的切塊與接回', () => {
  const data = bytes(BOOKMARK_CHUNK_BYTES * 2 + 1234, 42);

  it('每塊的網址 ≤ 60,006 字元，接回一致', () => {
    const urls = toBookmarkChunks(data);
    expect(urls).toHaveLength(3);
    for (const url of urls) {
      expect(url.startsWith('data:,')).toBe(true);
      expect(url.length).toBeLessThanOrEqual(60_006);
      expect(url.slice(6)).toMatch(/^[a-z2-7]+$/);
    }
    expect(urls[0]?.length).toBe(60_006);
    expect(fromBookmarkChunks(urls, 3)).toEqual(data);
  });

  it('亂序也接得回來（順序靠塊號，不靠書籤位置）', () => {
    const urls = toBookmarkChunks(data);
    expect(fromBookmarkChunks([urls[2], urls[0], urls[1]] as string[], 3)).toEqual(data);
  });

  it('缺一塊、多一塊、塊號重複、不是我們的格式：都回 null', () => {
    const urls = toBookmarkChunks(data);
    expect(fromBookmarkChunks(urls.slice(0, 2), 3)).toBeNull();
    expect(fromBookmarkChunks([...urls, urls[0] as string], 3)).toBeNull();
    expect(fromBookmarkChunks([urls[0], urls[0], urls[1]] as string[], 3)).toBeNull();
    // 塊數對、但其中一塊是上一代的（塊號超出這一代的範圍）
    expect(fromBookmarkChunks(toBookmarkChunks(data), 2)).toBeNull();
    expect(fromBookmarkChunks([urls[0], urls[1], 'https://example.com/'] as string[], 3)).toBeNull();
    expect(fromBookmarkChunks([urls[0], urls[1], 'data:,ABC'] as string[], 3)).toBeNull();
  });

  it('超過 256 塊就拒絕', () => {
    expect(() => toBookmarkChunks(new Uint8Array(BOOKMARK_CHUNK_BYTES * BOOKMARK_CHUNK_LIMIT))).not.toThrow();
    expect(() => toBookmarkChunks(new Uint8Array(BOOKMARK_CHUNK_BYTES * BOOKMARK_CHUNK_LIMIT + 1))).toThrow();
  });
});

const VAULT: VaultMeta = {
  version: 2,
  metaUpdatedAt: 1,
  createdAt: 1,
  salt: 'c2FsdA==',
  iterations: 600000,
  passwordWrap: { iv: 'aXY=', ct: 'Y3Q=' },
  recoveryWrap: { iv: 'aXY=', ct: 'Y3Q=' },
  recoveryCodeSealed: { iv: 'aXY=', ct: 'Y3Q=' },
};

function meta(extra: Record<string, unknown>): Record<string, unknown> {
  return { vault: VAULT, chunks: 1, digest: 'd', tag: 't', layoutTag: 'l', updatedAt: 1, deviceId: 'dev', ...extra };
}

describe('meta 的版本', () => {
  it('2 與 3 都認；3 一定要 store bookmarks 與資料夾 id，2 不能帶 store', () => {
    expect(isPackMeta(meta({ version: 1 }))).toBe(true);
    expect(isPackMeta(meta({ version: 2 }))).toBe(true);
    expect(isPackMeta(meta({ version: 3, store: 'bookmarks', folderId: 'f1' }))).toBe(true);
    expect(isPackMeta(meta({ version: 3 }))).toBe(false);
    expect(isPackMeta(meta({ version: 3, store: 'bookmarks' }))).toBe(false);
    expect(isPackMeta(meta({ version: 2, store: 'bookmarks', folderId: 'f1' }))).toBe(false);
    expect(isPackMeta(meta({ version: 4, store: 'bookmarks', folderId: 'f1' }))).toBe(false);
  });
});

// ── 假的 browser：storage.sync / local 與 bookmarks ────────────────────

type Node = { id: string; parentId?: string; title: string; url?: string };

let sync: Record<string, unknown>;
let local: Record<string, unknown>;
let nodes: Map<string, Node>;
let nextId: number;

function area(target: () => Record<string, unknown>) {
  return {
    get: async (keys: string | string[] | null) => {
      const data = target();
      if (keys === null) {
        return structuredClone(data);
      }
      const list = typeof keys === 'string' ? [keys] : keys;
      return Object.fromEntries(list.filter((key) => key in data).map((key) => [key, structuredClone(data[key])]));
    },
    set: async (items: Record<string, unknown>) => {
      Object.assign(target(), structuredClone(items));
    },
    remove: async (keys: string | string[]) => {
      for (const key of typeof keys === 'string' ? [keys] : keys) {
        delete target()[key];
      }
    },
  };
}

function children(parentId: string): Node[] {
  return [...nodes.values()].filter((node) => node.parentId === parentId).map((node) => ({ ...node }));
}

beforeEach(() => {
  sync = {};
  local = {};
  nodes = new Map([['unfiled_____', { id: 'unfiled_____', parentId: 'root________', title: 'Other Bookmarks' }]]);
  nextId = 1;
  const listeners = { addListener: () => undefined, removeListener: () => undefined };
  vi.stubGlobal('browser', {
    storage: { sync: area(() => sync), local: area(() => local), onChanged: listeners },
    bookmarks: {
      get: async (id: string) => {
        const node = nodes.get(id);
        if (node === undefined) {
          throw new Error('not found');
        }
        return [{ ...node }];
      },
      getChildren: async (id: string) => children(id),
      create: async (info: { parentId: string; title: string; url?: string }) => {
        const node: Node = { id: `n${String(nextId++)}`, ...info };
        nodes.set(node.id, node);
        return { ...node };
      },
      update: async (id: string, changes: { title?: string; url?: string }) => {
        const node = nodes.get(id) as Node;
        Object.assign(node, changes);
        return { ...node };
      },
      remove: async (id: string) => {
        nodes.delete(id);
      },
      removeTree: async (id: string) => {
        for (const child of children(id)) {
          nodes.delete(child.id);
        }
        nodes.delete(id);
      },
      onCreated: listeners,
      onRemoved: listeners,
      onChanged: listeners,
      onMoved: listeners,
    },
  });
});

const IDENTITY = { vault: VAULT, tag: 't', layoutTag: 'l', deviceId: 'dev' };

describe('書籤當存放位置', () => {
  it('寫進書籤 → meta 是 version 3，讀回來的就是寫進去的；vaultPackC* 被刪掉', async () => {
    sync.vaultPackC0 = 'old';
    const data = bytes(BOOKMARK_CHUNK_BYTES + 10, 3);
    await writePackEnvelope(IDENTITY, { store: 'bookmarks', bytes: data });

    const written = sync[PACK_META_KEY] as { version: number; store: string; folderId: string; chunks: number };
    expect(written).toMatchObject({ version: 3, store: 'bookmarks', chunks: 2 });
    expect(sync.vaultPackC0).toBeUndefined();
    expect(local[SYNC_FOLDER_LOCAL_KEY]).toBe(written.folderId);
    const blocks = children(written.folderId);
    expect(blocks).toHaveLength(2);
    expect(blocks.every((node) => node.title === '')).toBe(true);
    expect(nodes.get(written.folderId)?.parentId).toBe('unfiled_____');

    const read = await readPackEnvelope();
    expect(read.kind).toBe('ok');
    expect(read.kind === 'ok' && fromBase32(read.blob)).toEqual(data);
  });

  it('再寫一次沿用同一個資料夾與既有的書籤（update），多的刪掉', async () => {
    await writePackEnvelope(IDENTITY, { store: 'bookmarks', bytes: bytes(BOOKMARK_CHUNK_BYTES * 2 + 1, 4) });
    const folderId = (sync[PACK_META_KEY] as { folderId: string }).folderId;
    const before = children(folderId).map((node) => node.id);
    await writePackEnvelope(IDENTITY, { store: 'bookmarks', bytes: bytes(100, 5) });
    expect((sync[PACK_META_KEY] as { folderId: string }).folderId).toBe(folderId);
    expect(children(folderId).map((node) => node.id)).toEqual(before.slice(0, 1));
    expect((await readPackEnvelope()).kind).toBe('ok');
  });

  it('少一塊或內容被改 → partial（傳輸中），不是 ok', async () => {
    await writePackEnvelope(IDENTITY, { store: 'bookmarks', bytes: bytes(BOOKMARK_CHUNK_BYTES * 2, 6) });
    const folderId = (sync[PACK_META_KEY] as { folderId: string }).folderId;
    const [first, second] = children(folderId) as [Node, Node];

    (nodes.get(second.id) as Node).url = first.url as string;
    expect((await readPackEnvelope()).kind).toBe('partial');

    nodes.delete(second.id);
    expect((await readPackEnvelope()).kind).toBe('partial');
  });

  it('meta 的資料夾 id 對不上時，用標題在「其他書籤」底下找', async () => {
    await writePackEnvelope(IDENTITY, { store: 'bookmarks', bytes: bytes(500, 7) });
    // 例如另一台裝置：資料夾到了但 id 不同、本機也沒記住
    const stored = sync[PACK_META_KEY] as { folderId: string };
    const folder = nodes.get(stored.folderId) as Node;
    folder.title = 'Bookmark Preview: vault sync data (do not edit)';
    stored.folderId = 'elsewhere';
    delete local[SYNC_FOLDER_LOCAL_KEY];
    expect((await readPackEnvelope()).kind).toBe('ok');
  });

  it('看到比 3 新的 meta → partial 並標 newer', async () => {
    sync[PACK_META_KEY] = meta({ version: 4, store: 'bookmarks', folderId: 'f' });
    expect(await readPackEnvelope()).toEqual({ kind: 'partial', meta: null, newer: true });
  });

  it('寫回 storage.sync 時 meta 是 version 2、不帶 store', async () => {
    await writePackEnvelope(IDENTITY, { store: 'sync', chunks: ['abc'] });
    const written = sync[PACK_META_KEY] as Record<string, unknown>;
    expect(written.version).toBe(2);
    expect('store' in written).toBe(false);
    expect((await readPackEnvelope()).kind).toBe('ok');
  });

  it('快取：本機記住的、meta 帶的、「其他書籤」底下同名的資料夾都算', async () => {
    nodes.set('titled', { id: 'titled', parentId: 'unfiled_____', title: '書籤預覽：隱私空間的同步資料（請勿修改）' });
    nodes.set('nested', { id: 'nested', parentId: 'menu________', title: '書籤預覽：隱私空間的同步資料（請勿修改）' });
    local[SYNC_FOLDER_LOCAL_KEY] = 'mine';
    sync[PACK_META_KEY] = meta({ version: 3, store: 'bookmarks', folderId: 'theirs' });
    await initSyncFolderCache();
    expect(isSyncFolderIdSync('mine')).toBe(true);
    expect(isSyncFolderIdSync('theirs')).toBe(true);
    expect(isSyncFolderIdSync('titled')).toBe(true);
    expect(isSyncFolderIdSync('nested')).toBe(false);
    expect(isSyncFolderIdSync('unfiled_____')).toBe(false);
  });
});
