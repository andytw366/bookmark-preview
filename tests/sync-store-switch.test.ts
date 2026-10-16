import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultMeta } from '@/shared/types';
import { PACK_META_KEY, writePackEnvelope } from '@/storage/pack-sync';

/**
 * `setSyncStore`：切換雲端那份的存放位置（NEXT.md 方案 4）。
 *
 * 2026-10-16 D 期實機抓到：`storage.sync` 已經超額時，「改用書籤同步」先跑的那次同步照雲端 meta
 * 推回 `storage.sync`，一定因為超額而失敗，於是切換永遠按不成 —— 而那正是最需要它的時刻。
 * 現在改去書籤時合併完直接推到書籤。這裡用假的 `browser` 與 mock 的 `vault` 走一次。
 */

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

/** 密文的大小決定塞不塞得進 storage.sync */
let snapshotBytes: Uint8Array;
const merged = vi.fn(async () => false);

vi.mock('@/background/vault', () => ({
  adoptRemoteMeta: async () => false,
  isUnlocked: () => true,
  mergeEncryptedBlob: async () => ({ bookmarks: { added: 0, updated: 0 }, folders: { added: 0, updated: 0 }, reattached: 0 }),
  mergeEncryptedLayout: async () => false,
  mergeEncryptedPack: (...args: unknown[]) => merged(...(args as [])),
  packedSnapshot: async () => ({ bytes: snapshotBytes, tag: 'tag-local', layoutTag: 'layout-local' }),
  RemoteBlobUnreadable: class extends Error {},
  setPersistHook: () => undefined,
  vaultState: async () => ({ status: 'unlocked', bookmarkCount: 0 }),
}));
vi.mock('@/shared/messages', () => ({ broadcast: () => undefined }));

let settings: Record<string, unknown>;
vi.mock('@/storage/settings', () => ({
  getSettings: async () => settings,
  patchSettings: async (patch: Record<string, unknown>) => {
    Object.assign(settings, patch);
    return settings;
  },
}));

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
    getBytesInUse: async () => JSON.stringify(target()).length,
  };
}

function children(parentId: string): Node[] {
  return [...nodes.values()].filter((node) => node.parentId === parentId).map((node) => ({ ...node }));
}

function random(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let at = 0; at < length; at += 65_536) {
    crypto.getRandomValues(out.subarray(at, Math.min(length, at + 65_536)));
  }
  return out;
}

beforeEach(async () => {
  vi.resetModules();
  sync = {};
  local = { vaultMeta: VAULT };
  settings = { vaultSyncEnabled: true, vaultSyncBookmarks: false, syncGrid: false };
  nodes = new Map([['unfiled_____', { id: 'unfiled_____', parentId: 'root________', title: 'Other Bookmarks' }]]);
  nextId = 1;
  merged.mockClear();
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
        Object.assign(nodes.get(id) as Node, changes);
        return { ...(nodes.get(id) as Node) };
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
  // 雲端已有一份放在 storage.sync 的（別台裝置寫的、內容指紋不同）
  await writePackEnvelope(
    { vault: VAULT, tag: 'tag-remote', layoutTag: 'layout-remote', deviceId: 'other' },
    { store: 'sync', chunks: ['abc'] },
  );
});

describe('setSyncStore', () => {
  it('storage.sync 已經塞不下時，改用書籤同步仍然成功：先合併雲端那份，再整份寫進書籤', async () => {
    snapshotBytes = random(130_000);
    const { setSyncStore, syncVault } = await import('@/background/vault-sync');

    // 對照組：一般的同步照雲端 meta 推回 storage.sync，超額失敗
    expect(await syncVault()).toBe('failed');

    await setSyncStore('bookmarks');
    expect(merged).toHaveBeenCalled();
    const written = sync[PACK_META_KEY] as { version: number; store: string; folderId: string; tag: string };
    expect(written).toMatchObject({ version: 3, store: 'bookmarks', tag: 'tag-local' });
    expect(Object.keys(sync).filter((key) => key.startsWith('vaultPackC'))).toEqual([]);
    expect(children(written.folderId).length).toBeGreaterThan(1);
    expect(settings.vaultSyncBookmarks).toBe(true);
  });

  it('改回 storage.sync 塞不下時拒絕，雲端那份留在書籤、資料夾不動', async () => {
    snapshotBytes = random(130_000);
    const { setSyncStore } = await import('@/background/vault-sync');
    await setSyncStore('bookmarks');
    const before = structuredClone(sync[PACK_META_KEY]) as { folderId: string };

    await expect(setSyncStore('sync')).rejects.toThrow(/sync_bookmarks_cannot_fit/);
    expect(sync[PACK_META_KEY]).toEqual(before);
    expect(nodes.has(before.folderId)).toBe(true);
  });

  it('塞得下時改回 storage.sync：version 2、資料夾刪掉', async () => {
    snapshotBytes = random(2_000);
    const { setSyncStore } = await import('@/background/vault-sync');
    await setSyncStore('bookmarks');
    const folderId = (sync[PACK_META_KEY] as { folderId: string }).folderId;

    await setSyncStore('sync');
    expect(sync[PACK_META_KEY]).toMatchObject({ version: 2 });
    expect('store' in (sync[PACK_META_KEY] as object)).toBe(false);
    expect(nodes.has(folderId)).toBe(false);
  });
});
