import { describe, expect, it } from 'vitest';
import {
  appendShape,
  components,
  decodeCells,
  fromOrder,
  insertPush,
  navCell,
  normalize,
  outlineEdges,
  placeAuto,
  readingOrder,
  restoreGhosts,
  setColumns,
  shiftShape,
  type Grid,
} from '@/shared/grid';

/**
 * 固定格子。畫格子用字串：一列一行，`.` 是空格，其餘一個字元一張卡片。
 * 錯了的表現是「卡片跑到別的地方」，用圖比對比用索引好讀。
 */
const g = (...rows: string[]): Grid => ({
  columns: rows[0]?.length ?? 1,
  cells: rows.join('').split('').map((c) => (c === '.' ? '' : c)),
});

const draw = (grid: Grid): string[] => {
  const out: string[] = [];
  for (let i = 0; i < grid.cells.length; i += grid.columns) {
    out.push(
      Array.from({ length: grid.columns }, (_, c) => grid.cells[i + c] || '.').join(''),
    );
  }
  // 最後一列結尾的空格不畫（格子本來就不存結尾的空格）
  const last = out.length - 1;
  if (last >= 0) {
    out[last] = (out[last] ?? '').replace(/\.+$/, '');
  }
  return out;
};

describe('insertPush', () => {
  it('放到空格就是放進那一格', () => {
    expect(draw(insertPush(g('ab..', 'c...'), ['x'], 2))).toEqual(['abx.', 'c']);
  });

  it('目標有卡片：往後擠到第一個空格就停，空格後面的不動', () => {
    expect(draw(insertPush(g('abc.', 'de..'), ['x'], 1))).toEqual(['axbc', 'de']);
  });

  it('擠到列尾會換到下一列', () => {
    expect(draw(insertPush(g('abcd', 'e.f.'), ['x'], 2))).toEqual(['abxc', 'def']);
  });

  it('擠到最後一列之後會長出新的一列', () => {
    expect(draw(insertPush(g('abcd'), ['x'], 0))).toEqual(['xabc', 'd']);
  });

  it('同一個資料夾裡拖動：被擠的剛好補進拖走的那一格', () => {
    expect(draw(insertPush(g('abcd'), ['d'], 1))).toEqual(['adbc']);
  });

  it('多張一起：照順序一張接一張', () => {
    expect(draw(insertPush(g('abc.'), ['x', 'y'], 1))).toEqual(['axyb', 'c']);
  });

  it('放到格子外面（最後一列之後的空格）', () => {
    expect(draw(insertPush(g('ab'), ['a'], 5))).toEqual(['.b', '..', '.a']);
  });
});

describe('placeAuto / normalize / restoreGhosts', () => {
  it('沒有位置的放進最後一張之後', () => {
    expect(draw(placeAuto(g('a..', '.b.'), ['a', 'b', 'c', 'd']))).toEqual(['a..', '.bc', 'd']);
  });

  it('不在這裡的 id 當空格，重複的只留第一格', () => {
    expect(draw(normalize(g('axa', 'b..'), new Set(['a', 'b'])))).toEqual(['a..', 'b']);
  });

  it('本機還沒有的 id 放回原位（沒被佔走的話）', () => {
    const stored = g('axy', 'b..');
    const live = new Set(['a', 'b', 'c']);
    const next = insertPush(normalize(stored, live), ['c'], 2);
    expect(draw(restoreGhosts(stored, next, live))).toEqual(['axc', 'b']);
  });
});

describe('連通塊與框線', () => {
  it('4 連通：斜對角不算相連', () => {
    const grid = g('ab.', '.cd');
    expect(components(grid, new Set(['a', 'b', 'c', 'd']))).toEqual([[0, 1, 4, 5]]);
    expect(components(grid, new Set(['a', 'c']))).toEqual([[0], [4]]);
  });

  it('列尾與下一列開頭不相連', () => {
    expect(components(g('..a', 'b..'), new Set(['a', 'b']))).toHaveLength(2);
  });

  it('鄰格不是同一組就畫那一邊', () => {
    const grid = g('aab', '.ab');
    const groupOf = (id: string) => (id === 'b' ? 'B' : 'A');
    const edges = outlineEdges(grid, groupOf);
    expect(edges.get(0)).toEqual({ top: true, right: false, bottom: true, left: true });
    expect(edges.get(1)).toEqual({ top: true, right: true, bottom: false, left: false });
    expect(edges.get(4)).toEqual({ top: false, right: true, bottom: true, left: true });
    expect(edges.has(3)).toBe(false);
  });
});

describe('改欄數', () => {
  it('變寬：位置不變', () => {
    expect(draw(setColumns(g('ab', 'c.'), 3))).toEqual(['ab.', 'c']);
  });

  it('變窄：切掉的那幾欄放到同一列最後一格之後的空格，不擠別人', () => {
    expect(draw(setColumns(g('abc', 'd..', 'ef.'), 2))).toEqual(['ab', 'dc', 'ef']);
  });
});

describe('整組平移', () => {
  it('目標全空才放得下', () => {
    const grid = g('aa..', '.a..');
    expect(draw(shiftShape(grid, new Set(['a']), 0, 1) ?? g('-'))).toEqual(['.aa.', '..a']);
    expect(shiftShape(g('aab.'), new Set(['a']), 0, 1)).toBeNull();
  });

  it('出左右邊界或最上面就不行', () => {
    expect(shiftShape(g('..aa'), new Set(['a']), 0, 1)).toBeNull();
    expect(shiftShape(g('aa..'), new Set(['a']), -1, 0)).toBeNull();
  });

  it('接到另一個格子的最後一列之後，形狀不變', () => {
    expect(draw(appendShape(g('xy.'), g('.aa', '..a'), new Set(['a'])))).toEqual(['xy.', '.aa', '..a']);
    // 已經被自動排在目的地最後面的成員不算進「最後一列」
    expect(draw(appendShape(g('xya', 'a'), g('.aa', '..a'), new Set(['a'])))).toEqual(['xy.', '.aa', '..a']);
  });
});

describe('方向鍵', () => {
  const grid = g('a.b.', '....', '..c.', 'd');
  it('左右照閱讀順序跳過空格', () => {
    expect(navCell(grid, 0, 'ArrowRight')).toBe(2);
    expect(navCell(grid, 2, 'ArrowRight')).toBe(10);
    expect(navCell(grid, 10, 'ArrowLeft')).toBe(2);
  });

  it('上下跳過整列空的，挑欄位最近的', () => {
    expect(navCell(grid, 2, 'ArrowDown')).toBe(10);
    expect(navCell(grid, 10, 'ArrowDown')).toBe(12);
    expect(navCell(grid, 10, 'ArrowUp')).toBe(2);
  });

  it('到底了原地不動', () => {
    expect(navCell(grid, 12, 'ArrowDown')).toBe(12);
    expect(navCell(grid, 0, 'ArrowUp')).toBe(0);
  });

  it('焦點不在格子裡', () => {
    expect(navCell(grid, -1, 'ArrowDown')).toBe(0);
    expect(navCell(grid, -1, 'End')).toBe(12);
  });
});

describe('其餘', () => {
  it('閱讀順序', () => {
    expect(readingOrder(g('.b', 'a.'))).toEqual(['b', 'a']);
  });

  it('解碼只收字串陣列，結尾空格拿掉', () => {
    expect(decodeCells(['a', '', ''])).toEqual(['a']);
    expect(decodeCells(['a', 1])).toBeNull();
    expect(fromOrder(['a'], 0).columns).toBe(1);
  });
});

describe('原生順序', () => {
  it('只搬順序真的變了的那幾筆', async () => {
    const { unmoved } = await import('@/shared/grid');
    expect([...unmoved(['a', 'b', 'c', 'd'], ['d', 'a', 'b', 'c'])].sort()).toEqual(['a', 'b', 'c']);
    expect(unmoved(['a', 'b'], ['a', 'b']).size).toBe(2);
    expect(unmoved(['a', 'b'], ['x', 'b', 'a']).size).toBe(1);
  });
});
