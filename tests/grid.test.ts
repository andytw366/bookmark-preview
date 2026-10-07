import { describe, expect, it } from 'vitest';
import {
  decodeCells,
  fromOrder,
  insertAt,
  navCell,
  normalize,
  outlineEdges,
  placeAuto,
  setColumns,
  stepCell,
  unmoved,
  type Grid,
} from '@/shared/grid';

/**
 * 緊密排列的格子。格子用字串表示：一個字元一張卡片，`columns` 決定換行。
 */
const g = (cells: string, columns = 4): Grid => ({ columns, cells: cells.split('') });
const s = (grid: Grid): string => grid.cells.join('');

describe('insertAt', () => {
  it('插入，後面的讓位', () => {
    expect(s(insertAt(g('abcd'), ['x'], 1))).toBe('axbcd');
  });

  it('同一個資料夾裡往後拖：拿走的地方由後面的補上', () => {
    expect(s(insertAt(g('abcd'), ['a'], 3))).toBe('bcad');
  });

  it('往前拖', () => {
    expect(s(insertAt(g('abcd'), ['d'], 1))).toBe('adbc');
  });

  it('多張一起照順序；超過就接在最後', () => {
    expect(s(insertAt(g('abcd'), ['d', 'a'], 99))).toBe('bcda');
  });
});

describe('normalize / placeAuto', () => {
  it('不在這裡的拿掉、重複的只留第一個、舊格式的空格拿掉', () => {
    expect(s(normalize({ columns: 4, cells: ['a', '', 'x', 'b', 'a'] }, new Set(['a', 'b'])))).toBe('ab');
  });

  it('沒有位置的接在最後', () => {
    expect(s(placeAuto(g('ba'), ['a', 'b', 'c']))).toBe('bac');
  });
});

describe('框線', () => {
  it('階梯形：鄰格不是同一組就畫那一邊', () => {
    // 3 欄：a G H / I J b
    const grid = g('aGHIJb', 3);
    const groupOf = (id: string) => ('GHIJ'.includes(id) ? 'g' : null);
    const edges = outlineEdges(grid, groupOf);
    expect(edges.get(1)).toEqual({ top: true, right: false, bottom: false, left: true });
    expect(edges.get(2)).toEqual({ top: true, right: true, bottom: true, left: false });
    expect(edges.get(3)).toEqual({ top: true, right: false, bottom: true, left: true });
    expect(edges.get(4)).toEqual({ top: false, right: true, bottom: true, left: false });
    expect(edges.has(0)).toBe(false);
  });
});

describe('方向與巡覽', () => {
  const grid = g('abcdef', 4);
  it('stepCell 不出界、不跨到最後一張之後', () => {
    expect(stepCell(grid, 3, 'right')).toBeNull();
    expect(stepCell(grid, 1, 'down')).toBe(5);
    expect(stepCell(grid, 2, 'down')).toBeNull();
    expect(stepCell(grid, 0, 'up')).toBeNull();
  });

  it('方向鍵：下一列比較短就落在最後一張；到底不動', () => {
    expect(navCell(grid, 3, 'ArrowDown')).toBe(5);
    expect(navCell(grid, 5, 'ArrowDown')).toBe(5);
    expect(navCell(grid, 5, 'ArrowUp')).toBe(1);
    expect(navCell(grid, 3, 'ArrowRight')).toBe(4);
    expect(navCell(grid, -1, 'End')).toBe(5);
  });
});

describe('其餘', () => {
  it('改欄數只改換行', () => {
    expect(setColumns(g('abc'), 2)).toEqual({ columns: 2, cells: ['a', 'b', 'c'] });
    expect(fromOrder(['a'], 0).columns).toBe(1);
  });

  it('解碼只收字串陣列，空字串拿掉', () => {
    expect(decodeCells(['a', '', 'b'])).toEqual(['a', 'b']);
    expect(decodeCells(['a', 1])).toBeNull();
  });

  it('原生順序只搬順序真的變了的那幾筆', () => {
    expect([...unmoved(['a', 'b', 'c', 'd'], ['d', 'a', 'b', 'c'])].sort()).toEqual(['a', 'b', 'c']);
    expect(unmoved(['a', 'b'], ['x', 'b', 'a']).size).toBe(1);
  });
});
