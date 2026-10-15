import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { packSync, unpackSync } from '@/shared/sync-pack';
import { ROOT_KEY, layoutTag, sanitizeLayout, type VaultLayout } from '@/shared/vault-layout';
import { contentTag, sanitizeVaultPayload } from '@/shared/vault-merge';
import type { PrivateBookmark, VaultPayload } from '@/shared/types';

/**
 * 同步用的精簡編碼。
 *
 * 唯一不能錯的事：解回來的內容指紋要與原本一模一樣。差一點（少一個欄位、時間差一毫秒、
 * 空的區段不見）兩台裝置就會認定「雲端跟我不一樣」而輪流互相覆蓋。
 */

let seed = 7;
function random(): number {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
}
function uuid(): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

const T0 = 1_760_000_000_000;

function sample(count: number): { payload: VaultPayload; layout: VaultLayout } {
  const folders = Array.from({ length: 6 }, (_, index) => ({
    id: uuid(),
    name: `資料夾 ${String(index)}`,
    parentId: null,
    updatedAt: T0 + Math.floor(random() * 1e9),
  }));
  const bookmarks: PrivateBookmark[] = Array.from({ length: count }, (_, index) => {
    const createdAt = T0 + Math.floor(random() * 1e10);
    const record: PrivateBookmark = {
      id: uuid(),
      url: `https://site${String(index % 30)}.example.com/${uuid().slice(0, 10)}`,
      title: `標題 ${uuid().slice(0, 12)}`,
      folderId: index % 4 === 0 ? null : (folders[index % folders.length]?.id ?? null),
      createdAt,
      updatedAt: createdAt + (index % 3 === 0 ? 0 : Math.floor(random() * 1e8)),
    };
    if (index % 11 === 0) {
      record.preview = index % 2 === 0 ? 'icon' : 'page';
    }
    if (index % 17 === 0) {
      record.deleted = true;
    }
    return record;
  });
  const groups = Array.from({ length: 5 }, () => uuid());
  const layout: VaultLayout = {
    version: 1,
    sections: {
      order: {
        [ROOT_KEY]: { updatedAt: T0 + 5, ids: bookmarks.filter((r) => r.folderId === null).map((r) => r.id) },
        ...Object.fromEntries(
          folders.map((f) => [f.id, { updatedAt: T0 + 9, ids: bookmarks.filter((r) => r.folderId === f.id).map((r) => r.id) }]),
        ),
      },
      groups: Object.fromEntries(
        groups.map((g, index) => [
          g,
          {
            updatedAt: T0 + index,
            folderId: index === 0 ? null : (folders[0]?.id ?? null),
            name: `群組 ${String(index)}`,
            color: index,
            ...(index === 1 ? { pinned: true } : {}),
            ...(index === 2 ? { deleted: true } : {}),
          },
        ]),
      ),
      groupOf: Object.fromEntries(
        bookmarks.slice(0, Math.floor(count / 2)).map((r, index) => [
          r.id,
          { updatedAt: r.createdAt + 3, groupId: index % 7 === 0 ? null : (groups[index % groups.length] ?? null) },
        ]),
      ),
      grid: { [ROOT_KEY]: { updatedAt: T0 + 1, columns: 4 } },
    },
  };
  return { payload: { version: 1, bookmarks, folders }, layout };
}

function roundTrip(payload: VaultPayload, layout: VaultLayout): { payload: VaultPayload; layout: VaultLayout } {
  const unpacked = unpackSync(JSON.parse(JSON.stringify(packSync(payload, layout))));
  return { payload: sanitizeVaultPayload(unpacked.payload), layout: sanitizeLayout(unpacked.layout) };
}

describe('同步的精簡編碼', () => {
  it('解回來的內容指紋與原本相同', async () => {
    const { payload, layout } = sample(300);
    const back = roundTrip(payload, layout);
    expect(await contentTag(back.payload)).toBe(await contentTag(payload));
    expect(await layoutTag(back.layout)).toBe(await layoutTag(layout));
  });

  it('空的隱私空間與空的區段都保留', async () => {
    const payload: VaultPayload = { version: 1, bookmarks: [], folders: [] };
    const layout: VaultLayout = { version: 1, sections: { order: {}, future: {} } };
    const back = roundTrip(payload, layout);
    expect(await contentTag(back.payload)).toBe(await contentTag(payload));
    expect(await layoutTag(back.layout)).toBe(await layoutTag(layout));
  });

  it('不認得的區段、多出來的欄位、不是 UUID 的 id 都原樣保留', async () => {
    const { payload, layout } = sample(20);
    const first = payload.bookmarks[0];
    if (first === undefined) {
      throw new Error('no sample');
    }
    first.id = 'legacy-id';
    layout.sections.future = { x: { updatedAt: 1, anything: { nested: [1, 2] } } };
    layout.sections.order = { ...layout.sections.order, odd: { updatedAt: 2, ids: ['a'], extra: true } };
    layout.sections.groups = { ...layout.sections.groups, g: { updatedAt: 3, folderId: null, name: 'n', color: 1, pinned: false } };
    const back = roundTrip(payload, layout);
    expect(await contentTag(back.payload)).toBe(await contentTag(payload));
    expect(await layoutTag(back.layout)).toBe(await layoutTag(layout));
    expect(back.layout.sections.future).toEqual(layout.sections.future);
  });

  it('退路的原樣格式也解得開', () => {
    const { payload, layout } = sample(3);
    expect(unpackSync({ v: 0, payload, layout })).toEqual({ payload, layout });
  });

  it('看不懂的版本與壞掉的 id 表會丟錯', () => {
    expect(() => unpackSync({ v: 9 })).toThrow();
    const { payload, layout } = sample(3);
    const packed = packSync(payload, layout);
    packed.ids[0] = 'zz';
    expect(() => unpackSync(packed)).toThrow();
  });

  it('壓縮後比舊格式（書籤與版面分開、原樣 JSON）小很多', () => {
    const { payload, layout } = sample(400);
    const gz = (value: unknown): number => gzipSync(JSON.stringify(value)).length;
    const before = gz(payload) + gz(layout);
    const after = gz(packSync(payload, layout));
    expect(after).toBeLessThan(before * 0.7);
  });
});
