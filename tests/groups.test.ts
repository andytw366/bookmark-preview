import { describe, expect, it } from 'vitest';
import {
  arrange,
  gridModel,
  nextColor,
  rowContaining,
  rowNav,
  sameName,
  type GroupInfo,
} from '@/shared/groups';

/**
 * 群組的畫面模型。
 *
 * 列模型錯了的表現是「卡片跑到別的群組的框裡」或「上下鍵跳到奇怪的地方」，
 * 用眼睛很難一眼看出是哪一格算錯，所以邊界都寫成測試。
 */
const items = (...ids: string[]) => ids.map((id) => ({ id }));
const group = (id: string, extra: Partial<GroupInfo> = {}): GroupInfo => ({
  id,
  name: id,
  color: 0,
  collapsed: false,
  ...extra,
});

describe('名稱', () => {
  it('去頭尾空白、不分大小寫', () => {
    expect(sameName('  Reading ', 'reading')).toBe(true);
    expect(sameName('a', 'b')).toBe(false);
  });

  it('新群組挑用得最少的顏色', () => {
    expect(nextColor([])).toBe(0);
    expect(nextColor([group('a', { color: 0 }), group('b', { color: 1 })])).toBe(2);
  });
});

describe('arrange', () => {
  const memberOf = (map: Record<string, string>) => (id: string) => map[id] ?? null;

  it('群組出現在第一個成員的位置，成員聚在一起（即使原本不相鄰）', () => {
    const parts = arrange(items('a', 'b', 'c', 'd'), [group('g')], memberOf({ b: 'g', d: 'g' }));
    expect(parts.map((part) => (part.kind === 'item' ? part.item.id : `[${part.items.map((i) => i.id).join(',')}]`))).toEqual([
      'a',
      '[b,d]',
      'c',
    ]);
  });

  it('指向不存在群組的成員當成散的', () => {
    const parts = arrange(items('a'), [], memberOf({ a: 'gone' }));
    expect(parts).toEqual([{ kind: 'item', item: { id: 'a' } }]);
  });
});

describe('gridModel', () => {
  const memberOf = (map: Record<string, string>) => (id: string) => map[id] ?? null;
  const shape = (model: ReturnType<typeof gridModel<{ id: string }>>) =>
    model.rows.map((row) =>
      model.cells
        .slice(row.start, row.start + row.count)
        .map((cell) => (cell.kind === 'header' ? `#${cell.group.id}` : cell.item.id))
        .join(' '),
    );

  it('沒有群組時就是每 N 個一列', () => {
    const model = gridModel(arrange(items('a', 'b', 'c', 'd', 'e'), [], () => null), 2);
    expect(shape(model)).toEqual(['a b', 'c d', 'e']);
  });

  it('標題自己一列，群組的卡片不跨到下一段', () => {
    const model = gridModel(
      arrange(items('a', 'b', 'c', 'd', 'e', 'f'), [group('g')], memberOf({ b: 'g', c: 'g', d: 'g' })),
      2,
    );
    expect(shape(model)).toEqual(['a', '#g', 'b c', 'd', 'e f']);
  });

  it('收合的群組只剩標題列', () => {
    const model = gridModel(
      arrange(items('a', 'b', 'c'), [group('g', { collapsed: true })], memberOf({ a: 'g', b: 'g' })),
      3,
    );
    expect(shape(model)).toEqual(['#g', 'c']);
    expect(model.cells[0]).toMatchObject({ kind: 'header', count: 2 });
  });

  it('rowOfCell 與 rowContaining 一致', () => {
    const model = gridModel(
      arrange(items('a', 'b', 'c', 'd'), [group('g')], memberOf({ c: 'g', d: 'g' })),
      3,
    );
    model.rowOfCell.forEach((row, index) => {
      expect(rowContaining(model.rows, index)).toBe(row);
    });
  });
});

describe('rowNav', () => {
  // 列：[0 1 2] [3] [4 5] [6 7 8]
  const rows = [
    { start: 0, count: 3 },
    { start: 3, count: 1 },
    { start: 4, count: 2 },
    { start: 6, count: 3 },
  ];

  it('上下鍵換列，短的那一列落在最後一格，標題列只有一格', () => {
    expect(rowNav('ArrowDown', 2, rows)).toBe(3);
    expect(rowNav('ArrowDown', 3, rows)).toBe(4);
    expect(rowNav('ArrowDown', 5, rows)).toBe(7);
    expect(rowNav('ArrowUp', 8, rows)).toBe(5);
    expect(rowNav('ArrowUp', 4, rows)).toBe(3);
  });

  it('最上／最下一列原地不動', () => {
    expect(rowNav('ArrowUp', 1, rows)).toBe(1);
    expect(rowNav('ArrowDown', 7, rows)).toBe(7);
  });

  it('左右鍵照攤平順序走，跨得過標題列', () => {
    expect(rowNav('ArrowRight', 2, rows)).toBe(3);
    expect(rowNav('ArrowLeft', 4, rows)).toBe(3);
    expect(rowNav('ArrowRight', 8, rows)).toBe(8);
  });

  it('焦點不在網格裡時，上下鍵進到兩端', () => {
    expect(rowNav('ArrowDown', -1, rows)).toBe(0);
    expect(rowNav('End', -1, rows)).toBe(8);
    expect(rowNav('ArrowLeft', -1, rows)).toBeNull();
  });
});
