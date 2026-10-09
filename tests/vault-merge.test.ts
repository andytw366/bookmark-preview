import { describe, expect, it } from 'vitest';
import {
  contentTag,
  countAlive,
  hex,
  mergeVaults,
  pruneTombstones,
  sanitizeVaultPayload,
  textDigest,
  TOMBSTONE_TTL_MS,
} from '@/shared/vault-merge';
import type { PrivateBookmark, PrivateFolder, VaultPayload } from '@/shared/types';

/**
 * 合併是 M4 最容易靜默弄丟資料的地方，所以每條規則都各自釘一個測試。
 * 時間一律用固定值（不用 Date.now()），否則墓碑過期那幾個測試會隨執行時間飄。
 */
const NOW = 1_800_000_000_000;

function bookmark(overrides: Partial<PrivateBookmark> & { id: string }): PrivateBookmark {
  return {
    url: `https://example.com/${overrides.id}`,
    title: overrides.id,
    folderId: null,
    createdAt: NOW - 1_000,
    updatedAt: NOW - 1_000,
    ...overrides,
  };
}

function folder(overrides: Partial<PrivateFolder> & { id: string }): PrivateFolder {
  return { name: overrides.id, parentId: null, updatedAt: NOW - 1_000, ...overrides };
}

function payload(
  bookmarks: PrivateBookmark[] = [],
  folders: PrivateFolder[] = [],
): VaultPayload {
  return { version: 1, bookmarks, folders };
}

describe('mergeVaults', () => {
  it('兩邊各自新增 → 取聯集', () => {
    const local = payload([bookmark({ id: 'a' })]);
    const remote = payload([bookmark({ id: 'b' })]);
    const { payload: merged, report } = mergeVaults(local, remote, NOW);

    expect(merged.bookmarks.map((item) => item.id).sort()).toEqual(['a', 'b']);
    expect(report.bookmarks).toEqual({ added: 1, updated: 0 });
  });

  it('兩邊各自修改同一筆 → updatedAt 較大者勝', () => {
    const local = payload([bookmark({ id: 'a', title: '本機改的', updatedAt: NOW - 500 })]);
    const remote = payload([bookmark({ id: 'a', title: '遠端改的', updatedAt: NOW - 100 })]);

    expect(mergeVaults(local, remote, NOW).payload.bookmarks[0]?.title).toBe('遠端改的');
    // 反方向也要一致 —— 誰是「本機」不該影響結果
    expect(mergeVaults(remote, local, NOW).payload.bookmarks[0]?.title).toBe('遠端改的');
  });

  it('updatedAt 相同時保留本機那份（不無謂地覆寫）', () => {
    const local = payload([bookmark({ id: 'a', title: '本機', updatedAt: NOW })]);
    const remote = payload([bookmark({ id: 'a', title: '遠端', updatedAt: NOW })]);

    const { payload: merged, report } = mergeVaults(local, remote, NOW);
    expect(merged.bookmarks[0]?.title).toBe('本機');
    expect(report.bookmarks.updated).toBe(0);
  });

  it('一邊刪、一邊改 → 墓碑優先，即使編輯比較新', () => {
    const deleted = payload([
      bookmark({ id: 'a', deleted: true, updatedAt: NOW - 5_000 }),
    ]);
    const edited = payload([bookmark({ id: 'a', title: '救回來', updatedAt: NOW - 10 })]);

    // 兩個方向都必須是刪除獲勝，否則「以為刪了卻復活」會隨裝置順序時好時壞
    expect(mergeVaults(deleted, edited, NOW).payload.bookmarks[0]?.deleted).toBe(true);
    expect(mergeVaults(edited, deleted, NOW).payload.bookmarks[0]?.deleted).toBe(true);
  });

  it('兩邊都刪 → 保留較新的那個墓碑', () => {
    const local = payload([bookmark({ id: 'a', deleted: true, updatedAt: NOW - 5_000 })]);
    const remote = payload([bookmark({ id: 'a', deleted: true, updatedAt: NOW - 10 })]);

    expect(mergeVaults(local, remote, NOW).payload.bookmarks[0]?.updatedAt).toBe(NOW - 10);
  });

  it('合併不改動傳進來的兩份資料', () => {
    const local = payload([bookmark({ id: 'a', title: '原本' })]);
    const remote = payload([bookmark({ id: 'a', title: '新的', updatedAt: NOW })]);
    mergeVaults(local, remote, NOW);

    expect(local.bookmarks[0]?.title).toBe('原本');
    expect(remote.bookmarks[0]?.title).toBe('新的');
  });

  it('合併是幂等的：同樣的兩份再合併一次結果不變', () => {
    const local = payload(
      [bookmark({ id: 'a' }), bookmark({ id: 'b', deleted: true })],
      [folder({ id: 'f1' })],
    );
    const remote = payload([bookmark({ id: 'c', folderId: 'f2' })], [folder({ id: 'f2' })]);

    const once = mergeVaults(local, remote, NOW).payload;
    const twice = mergeVaults(once, remote, NOW);
    expect(twice.payload).toEqual(once);
    expect(twice.report.bookmarks).toEqual({ added: 0, updated: 0 });
  });

  it('資料夾在對方那邊被刪掉 → 裡面的書籤移到最上層而不是消失', () => {
    const local = payload([bookmark({ id: 'a', folderId: 'f1' })], [folder({ id: 'f1' })]);
    const remote = payload([], [folder({ id: 'f1', deleted: true, updatedAt: NOW })]);

    const { payload: merged, report } = mergeVaults(local, remote, NOW);
    expect(merged.bookmarks[0]?.folderId).toBeNull();
    expect(report.reattached).toBe(1);
  });

  it('父資料夾在對方那邊被刪掉 → 子資料夾移到最上層', () => {
    const local = payload([], [folder({ id: 'parent' }), folder({ id: 'child', parentId: 'parent' })]);
    const remote = payload([], [folder({ id: 'parent', deleted: true, updatedAt: NOW })]);

    const merged = mergeVaults(local, remote, NOW).payload;
    expect(merged.folders.find((item) => item.id === 'child')?.parentId).toBeNull();
  });

  it('folderId 指向根本不存在的資料夾 → 移到最上層', () => {
    const local = payload([bookmark({ id: 'a' })]);
    const remote = payload([bookmark({ id: 'b', folderId: 'ghost', updatedAt: NOW })]);

    const merged = mergeVaults(local, remote, NOW).payload;
    expect(merged.bookmarks.find((item) => item.id === 'b')?.folderId).toBeNull();
  });

  it('兩邊互相搬動造成的環狀 parentId 會被打斷', () => {
    // A 把 B 搬進自己底下、B 把 A 搬進自己底下 —— 各自合法，合起來成環
    const local = payload([], [folder({ id: 'A' }), folder({ id: 'B', parentId: 'A' })]);
    const remote = payload([], [folder({ id: 'A', parentId: 'B', updatedAt: NOW }), folder({ id: 'B' })]);

    const { payload: merged, report } = mergeVaults(local, remote, NOW);
    const roots = merged.folders.filter((item) => item.parentId === null);
    // 至少有一個回到最上層，整棵樹因此走得出去
    expect(roots.length).toBeGreaterThanOrEqual(1);
    expect(report.reattached).toBeGreaterThanOrEqual(1);
    for (const item of merged.folders) {
      let cursor = item.parentId;
      let depth = 0;
      while (cursor !== null && depth < 64) {
        expect(cursor).not.toBe(item.id);
        cursor = merged.folders.find((f) => f.id === cursor)?.parentId ?? null;
        depth += 1;
      }
      expect(depth).toBeLessThan(64);
    }
  });

  it('過期的墓碑在合併時被清掉，還沒過期的留著', () => {
    const local = payload([
      bookmark({ id: 'old', deleted: true, updatedAt: NOW - TOMBSTONE_TTL_MS - 1 }),
      bookmark({ id: 'fresh', deleted: true, updatedAt: NOW - 1_000 }),
    ]);

    const merged = mergeVaults(local, payload(), NOW).payload;
    expect(merged.bookmarks.map((item) => item.id)).toEqual(['fresh']);
  });
});

describe('pruneTombstones', () => {
  it('只清墓碑，不動活著的記錄', () => {
    const target = payload(
      [
        bookmark({ id: 'alive', updatedAt: 0 }),
        bookmark({ id: 'dead', deleted: true, updatedAt: 0 }),
      ],
      [folder({ id: 'dead-folder', deleted: true, updatedAt: 0 })],
    );
    pruneTombstones(target, NOW);

    expect(target.bookmarks.map((item) => item.id)).toEqual(['alive']);
    expect(target.folders).toEqual([]);
  });
});

describe('sanitizeVaultPayload', () => {
  it('丟掉形狀不對的記錄，留下好的', () => {
    const result = sanitizeVaultPayload({
      version: 1,
      bookmarks: [
        { id: 'ok', url: 'https://example.com/', title: '好的', folderId: null, createdAt: 1, updatedAt: 2 },
        { id: 'no-url', title: '缺網址', updatedAt: 2 },
        { id: 'bad-time', url: 'https://example.com/', updatedAt: null },
        'not an object',
      ],
      folders: [{ id: 'f', name: '資料夾', parentId: null, updatedAt: 3 }, { name: '缺 id' }],
    });

    expect(result.bookmarks.map((item) => item.id)).toEqual(['ok']);
    expect(result.folders.map((item) => item.id)).toEqual(['f']);
  });

  it('完全不是預期形狀時回傳空的 payload 而不丟錯', () => {
    expect(sanitizeVaultPayload(null)).toEqual({ version: 1, bookmarks: [], folders: [] });
    expect(sanitizeVaultPayload('garbage')).toEqual({ version: 1, bookmarks: [], folders: [] });
  });

  it('缺少的欄位補成安全的預設值', () => {
    const result = sanitizeVaultPayload({
      bookmarks: [{ id: 'a', url: 'https://example.com/', updatedAt: 5 }],
      folders: [{ id: 'f', updatedAt: 5 }],
    });

    expect(result.bookmarks[0]?.title).toBe('');
    // createdAt 缺了就沿用 updatedAt，不能留 undefined（排序會壞掉）
    expect(result.bookmarks[0]?.createdAt).toBe(5);
    expect(result.folders[0]?.name).not.toBe('');
  });

  it('空字串的 folderId 視為「在最上層」而不是指向 id 為空字串的資料夾', () => {
    const result = sanitizeVaultPayload({
      bookmarks: [{ id: 'a', url: 'https://example.com/', updatedAt: 1, folderId: '' }],
    });
    expect(result.bookmarks[0]?.folderId).toBeNull();
  });

  it('墓碑旗標保留下來（不然刪除會在匯入時復活）', () => {
    const result = sanitizeVaultPayload({
      bookmarks: [{ id: 'a', url: 'https://example.com/', updatedAt: 1, deleted: true }],
    });
    expect(result.bookmarks[0]?.deleted).toBe(true);
  });
});

describe('contentTag', () => {
  it('同樣的內容得到同樣的指紋', async () => {
    const a = payload([bookmark({ id: 'a' })], [folder({ id: 'f' })]);
    const b = payload([bookmark({ id: 'a' })], [folder({ id: 'f' })]);
    expect(await contentTag(a)).toBe(await contentTag(b));
  });

  it('陣列順序不影響指紋', async () => {
    // 合併是用 Map 收斂的，兩台裝置的順序不會一致；順序若影響指紋，
    // 兩邊會永遠認定「對方跟我不一樣」而無止盡地互相覆蓋
    const a = payload([bookmark({ id: 'a' }), bookmark({ id: 'b' })]);
    const b = payload([bookmark({ id: 'b' }), bookmark({ id: 'a' })]);
    expect(await contentTag(a)).toBe(await contentTag(b));
  });

  it('任何欄位變了指紋就變', async () => {
    const base = payload([bookmark({ id: 'a', title: '原本' })]);
    const renamed = payload([bookmark({ id: 'a', title: '改過' })]);
    const retimed = payload([bookmark({ id: 'a', title: '原本', updatedAt: NOW })]);
    const tombstoned = payload([bookmark({ id: 'a', title: '原本', deleted: true })]);

    const tag = await contentTag(base);
    expect(await contentTag(renamed)).not.toBe(tag);
    expect(await contentTag(retimed)).not.toBe(tag);
    expect(await contentTag(tombstoned)).not.toBe(tag);
  });

  it('合併後的兩邊指紋一致（同步才會收斂）', async () => {
    const local = payload([bookmark({ id: 'a' })], [folder({ id: 'f1' })]);
    const remote = payload([bookmark({ id: 'b', updatedAt: NOW })], [folder({ id: 'f2' })]);

    const onA = mergeVaults(local, remote, NOW).payload;
    const onB = mergeVaults(remote, local, NOW).payload;
    expect(await contentTag(onA)).toBe(await contentTag(onB));
  });

  it('內容相同的合併回報「什麼都沒變」—— 這是不重新加密的判斷依據', () => {
    // 每次加密都換 IV，所以無條件 persist 會讓密文永遠與遠端不同，
    // 同步因此永遠認為要上傳，變成兩秒一輪的無盡迴圈
    const same = payload([bookmark({ id: 'a' })], [folder({ id: 'f' })]);
    const { report, payload: merged } = mergeVaults(same, payload([bookmark({ id: 'a' })], [folder({ id: 'f' })]), NOW);

    expect(report).toEqual({
      bookmarks: { added: 0, updated: 0 },
      folders: { added: 0, updated: 0 },
      reattached: 0,
    });
    expect(merged.bookmarks.length + merged.folders.length).toBe(2);
  });
});

describe('textDigest', () => {
  it('同一段文字得到同一個指紋，改一個字元就不同', async () => {
    const blob = 'x'.repeat(1_000);
    expect(await textDigest(blob)).toBe(await textDigest('x'.repeat(1_000)));
    expect(await textDigest(blob)).not.toBe(await textDigest(`${'x'.repeat(999)}y`));
  });

  it('長度相同但內容不同會被分辨出來（塊新舊混雜就是這種情況）', async () => {
    // 只比長度擋不住「新的 meta 配新舊混雜的塊」：兩代密文長度常常一樣
    const a = `${'a'.repeat(500)}${'b'.repeat(500)}`;
    const b = `${'b'.repeat(500)}${'a'.repeat(500)}`;
    expect(a.length).toBe(b.length);
    expect(await textDigest(a)).not.toBe(await textDigest(b));
  });
});

describe('countAlive', () => {
  it('只數活著的，墓碑不算', () => {
    const report = countAlive(
      payload(
        [bookmark({ id: 'a' }), bookmark({ id: 'b', deleted: true })],
        [folder({ id: 'f' })],
      ),
    );
    expect(report.bookmarks.added).toBe(1);
    expect(report.folders.added).toBe(1);
  });
});

/** 隱私書籤手動選的預覽方式（`PrivateBookmark.preview`） */
describe('preview 欄位', () => {
  const base = { id: 'a', url: 'https://x.example/', title: 'x', folderId: null, createdAt: 1, updatedAt: 2 };

  it('sanitize 留下 icon／page，其他值丟掉', () => {
    const result = sanitizeVaultPayload({
      bookmarks: [
        { ...base, preview: 'icon' },
        { ...base, id: 'b', preview: 'page' },
        { ...base, id: 'c', preview: 'manual' },
        { ...base, id: 'd', preview: 42 },
      ],
      folders: [],
    });
    expect(result.bookmarks.map((record) => record.preview)).toEqual(['icon', 'page', undefined, undefined]);
    expect('preview' in result.bookmarks[2]!).toBe(false);
  });

  it('改了選擇指紋就變；沒選過的指紋不受這個欄位影響', async () => {
    const plain = { version: 1 as const, bookmarks: [base], folders: [] };
    const icon = { ...plain, bookmarks: [{ ...base, preview: 'icon' as const }] };
    const page = { ...plain, bookmarks: [{ ...base, preview: 'page' as const }] };
    expect(await contentTag(icon)).not.toBe(await contentTag(plain));
    expect(await contentTag(icon)).not.toBe(await contentTag(page));
    // 沒選過的書籤，指紋要與加這個欄位之前那一版算法一樣 —— 不然升級後每台裝置都會認定
    // 「雲端跟我不一樣」而整份重寫。這裡照舊版的欄位清單自己算一次來比
    const old = JSON.stringify([
      1,
      [JSON.stringify([base.id, base.url, base.title, base.folderId, base.createdAt, base.updatedAt, false])],
      [],
    ]);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(old)));
    expect(await contentTag(plain)).toBe(hex(digest.subarray(0, 16)));
  });

  it('合併時跟著整筆走，較新的贏', () => {
    const mine = { version: 1 as const, bookmarks: [{ ...base, preview: 'icon' as const, updatedAt: 5 }], folders: [] };
    const theirs = { version: 1 as const, bookmarks: [{ ...base, preview: 'page' as const, updatedAt: 9 }], folders: [] };
    expect(mergeVaults(mine, theirs).payload.bookmarks[0]?.preview).toBe('page');
  });
});
