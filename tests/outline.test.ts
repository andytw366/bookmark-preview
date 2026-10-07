import { describe, expect, it } from 'vitest';
import { groupRects, roundedPath, unionOutline, type MemberCell } from '@/shared/outline';

/** 卡片 100×100、間距 16：第 i 格在 (col*116, row*116) */
const cell = (index: number, columns = 4): MemberCell => ({
  index,
  rect: { x: (index % columns) * 116, y: Math.floor(index / columns) * 116, w: 100, h: 100 },
});
const outline = (indices: number[], columns = 4) =>
  unionOutline(groupRects(indices.map((index) => cell(index, columns)), columns, 4));

describe('群組外框', () => {
  it('一列兩張：一個矩形（4 個角），間距補起來、往外擴 4px', () => {
    expect(outline([0, 1])).toEqual([
      [
        [-4, -4],
        [220, -4],
        [220, 104],
        [-4, 104],
      ],
    ]);
  });

  it('L 形：一圈 6 個角，內角正好在兩條邊的交會處', () => {
    const [loop] = outline([2, 3, 6]);
    expect(loop).toHaveLength(6);
    // 內角：第 3 格（右上）的下緣與第 6 格（左下）的右緣交會
    expect(loop).toContainEqual([336, 104]);
  });

  it('2×2 一整塊：中間的十字空隙也補起來，只剩外圈 4 個角', () => {
    expect(outline([0, 1, 4, 5])[0]).toHaveLength(4);
  });

  it('階梯形（換行接在正下方）也是一圈', () => {
    expect(outline([2, 3, 5, 6])).toHaveLength(1);
  });

  it('不相連的兩塊：兩圈', () => {
    expect(outline([0, 2])).toHaveLength(2);
  });

  it('列尾與下一列開頭不算相鄰', () => {
    expect(outline([3, 4])).toHaveLength(2);
  });

  it('圓角路徑', () => {
    const path = roundedPath(
      [
        [0, 0],
        [100, 0],
        [100, 50],
        [0, 50],
      ],
      10,
    );
    expect(path.startsWith('M0,10Q0,0 10,0')).toBe(true);
    expect(path.endsWith('Z')).toBe(true);
  });
});
