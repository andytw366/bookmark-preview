import { describe, expect, it } from 'vitest';
import { nextColor, sameName, type GroupInfo } from '@/shared/groups';

/** 群組的名稱與顏色。格子與相鄰規則在 `grid.test.ts` / `board.test.ts` */
const group = (id: string, extra: Partial<GroupInfo> = {}): GroupInfo => ({
  id,
  name: id,
  color: 0,
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
