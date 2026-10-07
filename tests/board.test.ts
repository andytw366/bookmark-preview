import { describe, expect, it } from 'vitest';
import { applyOp, buildBoard, labels, membersInOrder, type Board, type GridOp } from '@/shared/board';
import type { Grid } from '@/shared/grid';

/**
 * 版面操作（相鄰就加入、斷開只留標籤那塊、擠動不改別人的群組…）。
 * 格子用字串畫：一個字元一張卡片，`.` 是空格；大寫字母是資料夾（不能進群組）。
 */
const g = (...rows: string[]): Grid => ({
  columns: rows[0]?.length ?? 1,
  cells: rows.join('').split('').map((c) => (c === '.' ? '' : c)),
});

const draw = (board: Board): string[] => {
  const out: string[] = [];
  const { columns, cells } = board.grid;
  for (let i = 0; i < cells.length; i += columns) {
    out.push(Array.from({ length: columns }, (_, c) => cells[i + c] || '.').join(''));
  }
  const last = out.length - 1;
  if (last >= 0) {
    out[last] = (out[last] ?? '').replace(/\.+$/, '');
  }
  return out;
};

const board = (grid: Grid, groups: Record<string, string> = {}): Board =>
  buildBoard({
    stored: grid,
    children: grid.cells.filter((id) => id !== ''),
    autoColumns: grid.columns,
    groups: [...new Set(Object.values(groups))].map((id, color) => ({ id, name: id, color })),
    groupOf: (id) => groups[id] ?? null,
  });

let counter = 0;
const ctx = {
  isLink: (id: string) => id === id.toLowerCase(),
  newId: () => `n${String((counter += 1))}`,
};
const run = (b: Board, op: GridOp) => applyOp(b, op, ctx);
const groupOf = (b: Board, id: string) => b.memberOf.get(id) ?? null;

describe('拖拽放開', () => {
  it('放在群組旁邊 = 加入', () => {
    const next = run(board(g('ab.x'), { a: 'G', b: 'G' }), { kind: 'place', ids: ['x'], at: 2, aimed: null });
    expect(draw(next)).toEqual(['abx']);
    expect(groupOf(next, 'x')).toBe('G');
  });

  it('拖到不相鄰的地方 = 離開', () => {
    const next = run(board(g('abc.', '....', 'z'), { a: 'G', b: 'G', c: 'G' }), {
      kind: 'place',
      ids: ['c'],
      at: 9,
      aimed: null,
    });
    expect(groupOf(next, 'c')).toBeNull();
    expect(groupOf(next, 'a')).toBe('G');
  });

  it('被拖的卡片原本的群組斷成兩塊：沒有標籤的那塊離開', () => {
    // G = a b c 一列，拖走中間的 b → a 與 c 不相連，c 那塊沒有標籤
    const next = run(board(g('abc.', '....', 'z'), { a: 'G', b: 'G', c: 'G' }), {
      kind: 'place',
      ids: ['b'],
      at: 9,
      aimed: null,
    });
    expect(groupOf(next, 'a')).toBe('G');
    expect(groupOf(next, 'c')).toBeNull();
  });

  it('擠動不改別人的群組，即使被擠成兩塊', () => {
    // H = d e；把 x 插在 d 前面：d e 都往後擠一格 → 擠到下一列也還是 H
    const before = board(g('xcde', 'f...'), { d: 'H', e: 'H' });
    const next = run(before, { kind: 'place', ids: ['x'], at: 2, aimed: 'd' });
    expect(draw(next)).toEqual(['.cxd', 'ef']);
    expect(groupOf(next, 'd')).toBe('H');
    const pushed = run(board(g('abcd', 'e...'), { c: 'H', d: 'H' }), { kind: 'place', ids: ['e'], at: 0, aimed: 'a' });
    expect(draw(pushed)).toEqual(['eabc', 'd']);
    expect(groupOf(pushed, 'd')).toBe('H');
    expect(groupOf(pushed, 'c')).toBe('H');
  });

  it('兩個群組都碰得到時，加入對準的那張卡片的群組', () => {
    const before = board(g('a.b'), { a: 'G', b: 'H' });
    expect(groupOf(run(before, { kind: 'place', ids: ['x'], at: 1, aimed: 'b' }), 'x')).toBeNull();
    const withX = board(g('a.bx'), { a: 'G', b: 'H' });
    expect(groupOf(run(withX, { kind: 'place', ids: ['x'], at: 1, aimed: 'b' }), 'x')).toBe('H');
    expect(groupOf(run(withX, { kind: 'place', ids: ['x'], at: 1, aimed: null }), 'x')).toBe('G');
  });

  it('資料夾不會加入群組', () => {
    const next = run(board(g('ab.F'), { a: 'G', b: 'G' }), { kind: 'place', ids: ['F'], at: 2, aimed: null });
    expect(groupOf(next, 'F')).toBeNull();
  });

  it('還沒定下來的資料夾，第一次拖拽就用當下的欄數定下來', () => {
    const loose = buildBoard({ stored: null, children: ['a', 'b', 'c'], autoColumns: 2, groups: [], groupOf: () => null });
    expect(loose.fixed).toBe(false);
    const next = run(loose, { kind: 'place', ids: ['a'], at: 3, aimed: null });
    expect(next.fixed).toBe(true);
    expect(draw(next)).toEqual(['.b', 'ca']);
  });
});

describe('鍵盤', () => {
  it('一次挪一格：目標有卡片就互換', () => {
    expect(draw(run(board(g('ab')), { kind: 'nudge', id: 'b', direction: 'left' }))).toEqual(['ba']);
    expect(draw(run(board(g('a.')), { kind: 'nudge', id: 'a', direction: 'down' }))).toEqual(['..', 'a']);
  });

  it('出界不動', () => {
    expect(draw(run(board(g('ab')), { kind: 'nudge', id: 'a', direction: 'up' }))).toEqual(['ab']);
  });

  it('標籤整組挪一格，目標要全空', () => {
    const before = board(g('ab..'), { a: 'G', b: 'G' });
    expect(draw(run(before, { kind: 'nudge-group', groupId: 'G', direction: 'right' }))).toEqual(['.ab']);
    expect(() => run(board(g('abc'), { a: 'G', b: 'G' }), { kind: 'nudge-group', groupId: 'G', direction: 'right' })).toThrow(
      'grid_shape_blocked',
    );
  });
});

describe('建立群組', () => {
  it('合併選單：被拖的放到目標右邊一格', () => {
    const next = run(board(g('ab.', 'x')), { kind: 'merge-group', targetId: 'a', ids: ['x'] });
    expect(draw(next)).toEqual(['axb']);
    expect(groupOf(next, 'a')).toBe(groupOf(next, 'x'));
    expect(groupOf(next, 'a')).not.toBeNull();
  });

  it('目標在列尾就放在它下面', () => {
    expect(draw(run(board(g('.a', 'x')), { kind: 'merge-group', targetId: 'a', ids: ['x'] }))).toEqual(['.a', '.x']);
  });

  it('框成群組：不相連就拒絕', () => {
    expect(() => run(board(g('a.b')), { kind: 'frame', ids: ['a', 'b'] })).toThrow('grid_frame_disconnected');
    const next = run(board(g('ab', '.c')), { kind: 'frame', ids: ['a', 'b', 'c'] });
    expect(new Set(['a', 'b', 'c'].map((id) => groupOf(next, id))).size).toBe(1);
  });

  it('資料夾不能進群組', () => {
    expect(() => run(board(g('aF')), { kind: 'merge-group', targetId: 'a', ids: ['F'] })).toThrow('group_links_only');
  });
});

describe('設定 tag', () => {
  it('同名（不分大小寫）就加入，搬到群組旁邊的空格', () => {
    const before = buildBoard({
      stored: g('a...', '..', 'x'),
      children: ['a', 'x'],
      autoColumns: 4,
      groups: [{ id: 'G', name: 'Read', color: 0 }],
      groupOf: (id) => (id === 'a' ? 'G' : null),
    });
    const next = run(before, { kind: 'tag', ids: ['x'], name: ' read ' });
    expect(groupOf(next, 'x')).toBe('G');
    expect(draw(next)).toEqual(['ax']);
  });

  it('沒有同名的就建一個，位置不動', () => {
    const next = run(board(g('a.x')), { kind: 'tag', ids: ['x'], name: 'new' });
    expect(next.groups.map((group) => group.name)).toEqual(['new']);
    expect(draw(next)).toEqual(['a.x']);
  });
});

describe('其他', () => {
  it('有群組時不能恢復自動排列', () => {
    expect(() => run(board(g('ab'), { a: 'G' }), { kind: 'auto' })).toThrow('grid_auto_has_groups');
    expect(run(board(g('a.b')), { kind: 'auto' }).fixed).toBe(false);
  });

  it('沒有成員的群組消失；標籤在第一個成員那格', () => {
    const before = board(g('.ab'), { a: 'G', b: 'G' });
    expect(labels(before).get(1)?.id).toBe('G');
    expect(membersInOrder(before, 'G')).toEqual(['a', 'b']);
    expect(run(before, { kind: 'dissolve', groupId: 'G' }).groups).toEqual([]);
  });

  it('改名不能與同資料夾的群組撞名', () => {
    const before = board(g('ab'), { a: 'G', b: 'H' });
    expect(() => run(before, { kind: 'group-update', groupId: 'G', name: 'h' })).toThrow('group_name_taken');
  });
});

describe('拖標籤的落點', () => {
  it('目標格子與放不放得下', async () => {
    const { shapeTarget } = await import('@/shared/board');
    const before = board(g('ab..', 'c...'), { a: 'G', b: 'G' });
    expect(shapeTarget(before, 'G', 1)).toEqual({ cells: [1, 2], ok: true });
    expect(shapeTarget(before, 'G', 4)).toEqual({ cells: [4, 5], ok: false });
    expect(shapeTarget(before, 'G', 3).ok).toBe(false);
  });
});
