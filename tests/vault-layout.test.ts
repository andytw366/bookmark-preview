import { describe, expect, it } from 'vitest';
import {
  ROOT_KEY,
  emptyLayout,
  folderOrder,
  layoutTag,
  mergeLayouts,
  moveIds,
  orderChildren,
  sanitizeLayout,
  withFolderOrder,
  type VaultLayout,
} from '@/shared/vault-layout';
import { anchorFor, dropIntent, isNoop } from '@/sidebar/lib/drop-intent';

/**
 * 隱私空間的版面文件與拖拽落點。
 *
 * 版面會跟著同步在不同版本的裝置之間來回，最怕的是「某一版看不懂就丟掉」——
 * 那會讓兩邊的指紋永遠對不上而互相覆蓋。所以向前相容那幾條寫成測試釘住。
 */
const layoutWith = (sections: VaultLayout['sections']): VaultLayout => ({ version: 1, sections });

describe('版面的合併', () => {
  it('逐項目較新者勝，兩邊各自的項目都留下', () => {
    const a = layoutWith({ order: { F: { ids: ['1', '2'], updatedAt: 10 }, G: { ids: ['x'], updatedAt: 5 } } });
    const b = layoutWith({ order: { F: { ids: ['2', '1'], updatedAt: 20 }, H: { ids: ['y'], updatedAt: 1 } } });
    const merged = mergeLayouts(a, b);
    expect(folderOrder(merged, 'F')).toEqual(['2', '1']);
    expect(folderOrder(merged, 'G')).toEqual(['x']);
    expect(folderOrder(merged, 'H')).toEqual(['y']);
  });

  it('同時間戳時兩個方向合出同一個結果（否則兩台裝置會互相覆蓋）', async () => {
    const a = layoutWith({ order: { F: { ids: ['1', '2'], updatedAt: 10 } } });
    const b = layoutWith({ order: { F: { ids: ['2', '1'], updatedAt: 10 } } });
    expect(await layoutTag(mergeLayouts(a, b))).toBe(await layoutTag(mergeLayouts(b, a)));
  });

  it('不認得的區段原封不動保留並照同一條規則合併 —— 新版的資料不會被這一版剝掉', () => {
    const future = layoutWith({ groups: { g1: { name: '秘密', color: 3, updatedAt: 50 } } });
    const older = layoutWith({ groups: { g1: { name: '舊名', color: 1, updatedAt: 40 } } });
    const merged = mergeLayouts(older, future);
    expect(merged.sections.groups?.g1).toEqual({ name: '秘密', color: 3, updatedAt: 50 });
    expect(sanitizeLayout(JSON.parse(JSON.stringify(future)))).toEqual(future);
  });

  it('形狀不對的項目丟掉，其他留下', () => {
    const dirty = {
      sections: {
        order: { F: { ids: ['1'], updatedAt: 1 }, bad: { ids: 'nope', updatedAt: 1 }, noTime: { ids: [] } },
        junk: 'x',
      },
    };
    const clean = sanitizeLayout(dirty);
    expect(Object.keys(clean.sections.order ?? {})).toEqual(['F']);
    expect(clean.sections.junk).toBeUndefined();
    expect(sanitizeLayout(null)).toEqual(emptyLayout());
  });

  it('合併不改到輸入', () => {
    const a = layoutWith({ order: { F: { ids: ['1'], updatedAt: 1 } } });
    const snapshot = JSON.stringify(a);
    mergeLayouts(a, layoutWith({ order: { F: { ids: ['2'], updatedAt: 9 } } }));
    expect(JSON.stringify(a)).toBe(snapshot);
  });

  it('指紋與鍵的順序無關', async () => {
    const a = { version: 1, sections: { order: { F: { updatedAt: 1, ids: ['1'] } } } } as VaultLayout;
    const b = { sections: { order: { F: { ids: ['1'], updatedAt: 1 } } }, version: 1 } as VaultLayout;
    expect(await layoutTag(a)).toBe(await layoutTag(b));
  });
});

describe('排列', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

  it('沒排過的資料夾維持傳進來的預設順序', () => {
    expect(orderChildren(items, null).map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('記到的照記錄排，沒記到的接在後面，不存在的略過', () => {
    expect(orderChildren(items, ['c', 'gone', 'a']).map((i) => i.id)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('重複的 id 只出現一次', () => {
    expect(orderChildren(items, ['b', 'b']).map((i) => i.id)).toEqual(['b', 'a', 'c', 'd']);
  });

  it('寫入時只留下活著的 id', () => {
    const next = withFolderOrder(emptyLayout(), null, ['a', 'dead', 'b'], new Set(['a', 'b']), 7);
    expect(next.sections.order?.[ROOT_KEY]).toEqual({ ids: ['a', 'b'], updatedAt: 7 });
  });
});

describe('moveIds', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];

  it('往前、往後、放到最後', () => {
    expect(moveIds(order, ['d'], 'b')).toEqual(['a', 'd', 'b', 'c', 'e']);
    expect(moveIds(order, ['a'], 'd')).toEqual(['b', 'c', 'a', 'd', 'e']);
    expect(moveIds(order, ['b'], null)).toEqual(['a', 'c', 'd', 'e', 'b']);
  });

  it('一批保持原本的相對順序', () => {
    expect(moveIds(order, ['e', 'b'], 'a')).toEqual(['b', 'e', 'a', 'c', 'd']);
  });

  it('錨點自己在這一批裡時，往後找第一個不在批裡的', () => {
    expect(moveIds(order, ['b', 'c'], 'c')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(moveIds(order, ['d', 'e'], 'e')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('剛從別處搬進來的 id 也排得進去', () => {
    expect(moveIds(['a', 'b'], ['z'], 'b')).toEqual(['a', 'z', 'b']);
  });
});

describe('拖拽落點', () => {
  const box = { left: 100, top: 0, width: 200, height: 100 };

  it('左右緣插入、中央依卡片種類', () => {
    expect(dropIntent(box, 110, 50, 'bookmark')).toEqual({ kind: 'before' });
    expect(dropIntent(box, 290, 50, 'folder')).toEqual({ kind: 'after' });
    expect(dropIntent(box, 200, 50, 'folder')).toEqual({ kind: 'into' });
    expect(dropIntent(box, 200, 50, 'bookmark')).toEqual({ kind: 'merge' });
  });

  it('30% 邊界本身算中央', () => {
    expect(dropIntent(box, 160, 50, 'folder')).toEqual({ kind: 'into' });
    expect(dropIntent(box, 159, 50, 'folder')).toEqual({ kind: 'before' });
  });

  it('清單看上下', () => {
    expect(dropIntent(box, 200, 10, 'folder', 'vertical')).toEqual({ kind: 'before' });
    expect(dropIntent(box, 200, 95, 'folder', 'vertical')).toEqual({ kind: 'after' });
  });

  it('量不到大小時當成插到前面', () => {
    expect(dropIntent({ left: 0, top: 0, width: 0, height: 0 }, 5, 5, 'folder')).toEqual({ kind: 'before' });
  });

  it('插到後面換成下一張的前面，最後一張後面是 null', () => {
    expect(anchorFor(['a', 'b', 'c'], 'a', { kind: 'after' })).toBe('b');
    expect(anchorFor(['a', 'b', 'c'], 'c', { kind: 'after' })).toBeNull();
    expect(anchorFor(['a', 'b', 'c'], 'b', { kind: 'before' })).toBe('b');
  });

  it('拖回原位不算移動', () => {
    expect(isNoop(['a', 'b', 'c'], ['b'], 'b')).toBe(true);
    expect(isNoop(['a', 'b', 'c'], ['b'], 'c')).toBe(true);
    expect(isNoop(['a', 'b', 'c'], ['b'], 'a')).toBe(false);
    expect(isNoop(['a', 'b', 'c'], ['c'], null)).toBe(true);
  });
});
