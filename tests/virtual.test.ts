import { describe, expect, it } from 'vitest';
import { columnsForWidth, windowFor } from '@/sidebar/lib/virtual';

/**
 * 虛擬滾動的視窗計算。
 *
 * 這裡全是差一格的算術，而錯了的表現（捲到一半空一塊、捲不到底、整批位移）
 * 在實機上很難重現也很難歸因 —— 每個邊界都寫成測試比較划算。
 *
 * 最重要的性質是**總高度守恆**：padTop + 渲染出來的列 + padBottom 必須等於
 * 全部列的高度總和。只要這條成立，捲軸長度與內容位置就不會漂掉。
 */

/** 固定 100px 的列高，用於大部分案例 */
const flat = (): number => 100;

describe('虛擬滾動的視窗', () => {
  describe('固定列高', () => {
    const win = (scrollTop: number, viewport = 500, overscan = 0) =>
      windowFor({ rowCount: 100, heightOf: flat, scrollTop, viewport, overscan });

    it('捲到最上面時從第 0 列開始，上方不墊高', () => {
      const w = win(0);
      expect(w.firstRow).toBe(0);
      expect(w.padTop).toBe(0);
    });

    it('只渲染蓋得住視窗的那幾列', () => {
      // 500px 的視窗、100px 的列 → 5 列
      expect(win(0).endRow).toBe(5);
    });

    it('捲下去之後起點與墊高一起前進', () => {
      const w = win(1000);
      expect(w.firstRow).toBe(10);
      expect(w.padTop).toBe(1000);
      expect(w.endRow).toBe(15);
    });

    it('捲到一半的列也要算進來（否則上緣會露出空白）', () => {
      const w = win(1050);
      expect(w.firstRow).toBe(10);
      expect(w.padTop).toBe(1000);
    });

    it('overscan 往上退時墊高要跟著扣，兩者不一致畫面會整批位移', () => {
      const w = win(1000, 500, 3);
      expect(w.firstRow).toBe(7);
      expect(w.padTop).toBe(700);
      expect(w.endRow).toBe(18);
    });

    it('overscan 在清單頂端不會退成負的', () => {
      const w = win(0, 500, 5);
      expect(w.firstRow).toBe(0);
      expect(w.padTop).toBe(0);
    });

    it('捲到底時 padBottom 歸零、endRow 收在最後一列', () => {
      const w = win(100 * 100 - 500);
      expect(w.endRow).toBe(100);
      expect(w.padBottom).toBe(0);
    });

    it('捲過頭也不會算出清單外面的列', () => {
      const w = win(999_999);
      expect(w.firstRow).toBeLessThan(100);
      expect(w.endRow).toBe(100);
    });

    it('scrollTop 為負（內容還在視窗下方）時視為 0', () => {
      expect(win(-300).firstRow).toBe(0);
      expect(win(-300).padTop).toBe(0);
    });
  });

  describe('不等高的列（大卡模式的封面圖各有長寬比）', () => {
    // 第 n 列高 = 50 + n * 10：0→50, 1→60, 2→70 …
    const ladder = (row: number): number => 50 + row * 10;
    const total = (count: number): number => {
      let sum = 0;
      for (let row = 0; row < count; row += 1) {
        sum += ladder(row);
      }
      return sum;
    };

    it('墊高用的是實際列高，不是「列數 × 平均」', () => {
      // 前 3 列 = 50 + 60 + 70 = 180
      const w = windowFor({
        rowCount: 40,
        heightOf: ladder,
        scrollTop: 180,
        viewport: 200,
        overscan: 0,
      });
      expect(w.firstRow).toBe(3);
      expect(w.padTop).toBe(180);
    });

    it('總高度守恆：padTop + 渲染的列 + padBottom = 全部', () => {
      for (const scrollTop of [0, 137, 900, 3000]) {
        const w = windowFor({
          rowCount: 40,
          heightOf: ladder,
          scrollTop,
          viewport: 300,
          overscan: 2,
        });
        let rendered = 0;
        for (let row = w.firstRow; row < w.endRow; row += 1) {
          rendered += ladder(row);
        }
        expect(w.padTop + rendered + w.padBottom).toBe(total(40));
      }
    });
  });

  describe('邊界', () => {
    it('空清單不渲染任何列，也不墊高', () => {
      expect(windowFor({ rowCount: 0, heightOf: flat, scrollTop: 0, viewport: 500, overscan: 3 }))
        .toEqual({ firstRow: 0, endRow: 0, padTop: 0, padBottom: 0 });
    });

    it('視窗高度還沒量到（0）時至少渲染一列，否則畫面會是空的', () => {
      const w = windowFor({ rowCount: 10, heightOf: flat, scrollTop: 0, viewport: 0, overscan: 0 });
      expect(w.endRow).toBeGreaterThan(w.firstRow);
    });

    it('列高量到 0（元素還沒排版）時不會無窮迴圈', () => {
      const w = windowFor({
        rowCount: 5,
        heightOf: () => 0,
        scrollTop: 0,
        viewport: 500,
        overscan: 0,
      });
      expect(w.endRow).toBe(5);
    });
  });
});

describe('網格欄數', () => {
  it('依 auto-fill 的規則算：每欄至少 min 寬，欄間有 gap', () => {
    // 200px 的欄 + 16px 間距：1030px 放得下 (1030+16)/(200+16) = 4.8 → 4 欄
    expect(columnsForWidth(1030, 200, 16)).toBe(4);
    expect(columnsForWidth(1030, 140, 16)).toBe(6);
    expect(columnsForWidth(1030, 280, 16)).toBe(3);
  });

  it('剛好放得下整數欄時不會少算一欄', () => {
    // 3 欄 = 200*3 + 16*2 = 632
    expect(columnsForWidth(632, 200, 16)).toBe(3);
  });

  it('再窄也至少一欄 —— 回傳 0 會讓列數變成除以零', () => {
    expect(columnsForWidth(50, 200, 16)).toBe(1);
    expect(columnsForWidth(0, 200, 16)).toBe(1);
  });
});
