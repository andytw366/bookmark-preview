import { describe, expect, it } from 'vitest';
import {
  applyOp,
  buildBoard,
  insertItems,
  labels,
  layoutGrid,
  membersInOrder,
  orderIndexAt,
  type Board,
  type GridOp,
} from '@/shared/board';

/**
 * 版面操作。順序用字串表示：一個字元一張卡片，大寫是資料夾（不能進群組）。
 * 群組用 `{ a: 'G' }` 表示 a 在群組 G。
 */
const board = (cells: string, groups: Record<string, string> = {}, columns = 4): Board =>
  buildBoard({
    stored: { columns, cells: cells.split('') },
    fixed: true,
    children: cells.split(''),
    autoColumns: columns,
    groups: [...new Set(Object.values(groups))].map((id, color) => ({ id, name: id, color })),
    groupOf: (id) => groups[id] ?? null,
  });

let counter = 0;
const ctx = {
  isLink: (id: string) => id === id.toLowerCase(),
  newId: () => `n${String((counter += 1))}`,
};
const run = (b: Board, op: GridOp) => applyOp(b, op, ctx);
const order = (b: Board) => b.grid.cells.join('');
const groupOf = (b: Board, id: string) => b.memberOf.get(id) ?? null;

describe('拖拽放開', () => {
  it('放在群組旁邊（對準的不是成員）不加入', () => {
    const next = run(board('abcx', { b: 'G', c: 'G' }), { kind: 'place', ids: ['x'], at: 0, aimed: 'a' });
    expect(order(next)).toBe('xabc');
    expect(groupOf(next, 'x')).toBeNull();
  });

  it('對準成員（放進框裡）就加入，插在那裡', () => {
    const next = run(board('abcx', { b: 'G', c: 'G' }), { kind: 'place', ids: ['x'], at: 2, aimed: 'c' });
    expect(order(next)).toBe('abxc');
    expect(groupOf(next, 'x')).toBe('G');
  });

  it('插在最後一個成員後面、游標還在成員上：加入', () => {
    const next = run(board('bcax', { b: 'G', c: 'G' }), { kind: 'place', ids: ['x'], at: 2, aimed: 'c' });
    expect(order(next)).toBe('bcxa');
    expect(groupOf(next, 'x')).toBe('G');
  });

  it('成員拖到框外 = 離開，群組還是連續的一段', () => {
    const next = run(board('bcda', { b: 'G', c: 'G', d: 'G' }), { kind: 'place', ids: ['c'], at: 4, aimed: null });
    expect(order(next)).toBe('bdac');
    expect(groupOf(next, 'c')).toBeNull();
  });

  it('散卡片不能插進別人的群組中間：推到頭或尾（近的那邊）', () => {
    // 對準的是群組外的卡片，但落點在 G 中間 —— 用不在群組的 aimed 模擬鍵盤以外的情況
    const b = board('xbcde', { b: 'G', c: 'G', d: 'G', e: 'G' });
    const before = run(b, { kind: 'place', ids: ['x'], at: 2, aimed: null });
    expect(order(before)).toBe('xbcde');
    const after = run(b, { kind: 'place', ids: ['x'], at: 4, aimed: null });
    expect(order(after)).toBe('bcdex');
  });

  it('資料夾對準成員也不加入，被擠到那一段後面', () => {
    const next = run(board('bcF', { b: 'G', c: 'G' }), { kind: 'place', ids: ['F'], at: 1, aimed: 'c' });
    expect(order(next)).toBe('bcF');
    expect(groupOf(next, 'F')).toBeNull();
  });

  it('拖拽不會讓還沒定下來的資料夾定下來', () => {
    const loose = buildBoard({ stored: null, fixed: false, children: ['a', 'b'], autoColumns: 3, groups: [], groupOf: () => null });
    const next = run(loose, { kind: 'place', ids: ['a'], at: 2, aimed: null });
    expect(next.fixed).toBe(false);
    expect(order(next)).toBe('ba');
  });
});

describe('鍵盤', () => {
  it('一次挪一格：與那一格換位', () => {
    expect(order(run(board('abcd'), { kind: 'nudge', id: 'b', direction: 'left' }))).toBe('bacd');
    expect(order(run(board('abcdef'), { kind: 'nudge', id: 'b', direction: 'down' }))).toBe('acdefb');
  });

  it('挪出群組的尾巴 = 離開；挪進群組 = 加入', () => {
    const b = board('bcx', { b: 'G', c: 'G' });
    const out = run(b, { kind: 'nudge', id: 'c', direction: 'right' });
    expect(order(out)).toBe('bxc');
    expect(groupOf(out, 'c')).toBeNull();
    const into = run(b, { kind: 'nudge', id: 'x', direction: 'left' });
    expect(groupOf(into, 'x')).toBe('G');
  });

  it('標籤上整組挪：跨過一張、或跨過整個相鄰群組', () => {
    const b = board('abcde', { b: 'G', c: 'G', d: 'H', e: 'H' });
    expect(order(run(b, { kind: 'nudge-group', groupId: 'G', direction: 'left' }))).toBe('bcade');
    expect(order(run(b, { kind: 'nudge-group', groupId: 'G', direction: 'right' }))).toBe('adebc');
  });
});

describe('移動群組', () => {
  it('整段搬，其他卡片讓位', () => {
    const b = board('abcde', { d: 'G', e: 'G' });
    expect(order(run(b, { kind: 'move-group', groupId: 'G', at: 1 }))).toBe('adebc');
  });

  it('落在別的群組中間就推到頭或尾', () => {
    const b = board('abcdx', { a: 'H', b: 'H', c: 'H', x: 'G' });
    expect(order(run(b, { kind: 'move-group', groupId: 'G', at: 1 }))).toBe('xabcd');
  });
});

describe('建立群組', () => {
  it('合併選單：被拖的接在目標後面', () => {
    const next = run(board('abcx'), { kind: 'merge-group', targetId: 'a', ids: ['x'] });
    expect(order(next)).toBe('axbc');
    expect(groupOf(next, 'a')).toBe(groupOf(next, 'x'));
  });

  it('框成群組：聚到第一張的位置', () => {
    const next = run(board('axbyc'), { kind: 'frame', ids: ['c', 'a', 'b'] });
    expect(order(next)).toBe('abcxy');
    expect(new Set(['a', 'b', 'c'].map((id) => groupOf(next, id))).size).toBe(1);
  });

  it('資料夾不能進群組', () => {
    expect(() => run(board('aF'), { kind: 'merge-group', targetId: 'a', ids: ['F'] })).toThrow('group_links_only');
  });
});

describe('tag', () => {
  it('同名（不分大小寫）就加入，接在那一段最後', () => {
    const b = buildBoard({
      stored: { columns: 4, cells: ['a', 'b', 'c', 'x'] },
      fixed: true,
      children: ['a', 'b', 'c', 'x'],
      autoColumns: 4,
      groups: [{ id: 'G', name: 'Read', color: 0 }],
      groupOf: (id) => (id === 'a' || id === 'b' ? 'G' : null),
    });
    const next = run(b, { kind: 'tag', ids: ['x'], name: ' read ' });
    expect(order(next)).toBe('abxc');
    expect(groupOf(next, 'x')).toBe('G');
  });

  it('移出群組：在中間的被擠到那一段後面', () => {
    const next = run(board('abcd', { a: 'G', b: 'G', c: 'G' }), { kind: 'untag', ids: ['b'] });
    expect(order(next)).toBe('acbd');
    expect(membersInOrder(next, 'G')).toEqual(['a', 'c']);
  });
});

describe('其他', () => {
  it('有群組也能恢復自動排列', () => {
    expect(run(board('ab', { a: 'G' }), { kind: 'auto' }).fixed).toBe(false);
    expect(run(board('ab'), { kind: 'columns', columns: 2 }).grid.columns).toBe(2);
  });

  it('被別處弄散的群組照樣聚成一段（在第一個成員的位置）', () => {
    expect(order(board('axbyc', { a: 'G', c: 'G' }))).toBe('acxby');
  });

  it('沒有成員的群組消失；標籤在第一個成員那格', () => {
    const b = board('xab', { a: 'G', b: 'G' });
    expect(labels(b, layoutGrid(b)).get(1)?.id).toBe('G');
    expect(run(b, { kind: 'dissolve', groupId: 'G' }).groups).toEqual([]);
  });

  it('改名不能與同資料夾的群組撞名', () => {
    expect(() => run(board('ab', { a: 'G', b: 'H' }), { kind: 'group-update', groupId: 'G', name: 'h' })).toThrow(
      'group_name_taken',
    );
  });

  it('整組搬進來接在最後；攤平時放在原本那一格', () => {
    const b = board('pqab');
    expect(order(insertItems(b, ['a', 'b'], { id: 'G', name: '', color: 0 }))).toBe('pqab');
    const flat = insertItems(b, ['a', 'b'], { id: 'G', name: '', color: 0 }, 1);
    expect(order(flat)).toBe('pabq');
    expect(groupOf(flat, 'a')).toBe('G');
  });
});

/** 畫面的擺法畫成一列一行的字串，`.` 是空格 */
const shown = (b: Board): string[] => {
  const grid = layoutGrid(b);
  const rows: string[] = [];
  for (let i = 0; i < grid.cells.length; i += grid.columns) {
    rows.push(Array.from({ length: grid.columns }, (_, c) => grid.cells[i + c] || '.').join(''));
  }
  return rows.map((row, index) => (index === rows.length - 1 ? row.replace(/\.+$/, '') : row));
};

describe('畫面的擺法：群組永遠是上下接著的一整塊', () => {
  it('沒有群組就是照順序排滿', () => {
    expect(shown(board('abcdef', {}, 4))).toEqual(['abcd', 'ef']);
  });

  it('放得下就在同一列', () => {
    expect(shown(board('abGHcd', { G: 'g', H: 'g' }, 4))).toEqual(['abGH', 'cd']);
  });

  it('列尾放不下：剩下的接在正下方，後面的卡片填進左邊空出來的格子', () => {
    // 順序 a b c G H I d e，4 欄：G 在第 3 欄，H I 接在下一列、從第 3 欄往左延伸到對齊列尾
    expect(shown(board('abcGHIde', { G: 'g', H: 'g', I: 'g' }, 4))).toEqual(['abcG', 'deHI']);
  });

  it('下一截盡量從同一欄開始', () => {
    expect(shown(board('abGHIJcdef', { G: 'g', H: 'g', I: 'g', J: 'g' }, 4))).toEqual(['abGH', 'cdIJ', 'ef']);
  });

  it('比一整列還長：一列一列往下疊', () => {
    expect(shown(board('aGHIJKL', { G: 'g', H: 'g', I: 'g', J: 'g', K: 'g', L: 'g' }, 3))).toEqual([
      'aGH',
      'IJK',
      'L',
    ]);
  });

  it('框線：擺出來的群組是一整塊', async () => {
    const { components } = await import('./helpers/components');
    const b = board('abcGHIde', { G: 'g', H: 'g', I: 'g' }, 4);
    expect(components(layoutGrid(b), new Set(['G', 'H', 'I']))).toBe(1);
  });

  it('畫面上的落點換成順序上的位置', () => {
    const b = board('abcGHIde', { G: 'g', H: 'g', I: 'g' }, 4);
    const grid = layoutGrid(b);
    // 對準 d（畫面第 4 格）插在前面 = 順序上 d 的位置
    expect(orderIndexAt(b, grid, 4, 'd', false)).toBe(6);
    expect(orderIndexAt(b, grid, 4, 'd', true)).toBe(7);
    // 最後面的空位
    expect(orderIndexAt(b, grid, grid.cells.length, null, false)).toBe(8);
  });

  it('鍵盤往下：插到畫面上正下方那張的後面', () => {
    const b = board('abcdef', {}, 4);
    expect(order(run(b, { kind: 'nudge', id: 'b', direction: 'down' }))).toBe('acdefb');
  });
});
