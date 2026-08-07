import { describe, expect, it } from 'vitest';
import { navMove } from '@/sidebar/lib/list-nav';

/**
 * 清單／網格方向鍵的索引計算。
 *
 * 這種「差一格」的邏輯用眼睛看不出對錯，而錯了的表現是「按了跳到奇怪的地方」——
 * 留到實機才發現太慢，所以邊界（第一列、最後一列、單欄與多欄的差異）都寫成測試。
 */
describe('方向鍵巡覽', () => {
  describe('單欄清單（側邊欄）', () => {
    const move = (key: string, at: number, count = 5) => navMove(key, at, count, 1);

    it('上下鍵逐列移動', () => {
      expect(move('ArrowDown', 0)).toEqual({ kind: 'focus', index: 1 });
      expect(move('ArrowUp', 3)).toEqual({ kind: 'focus', index: 2 });
    });

    it('在兩端停住而不是繞回去 —— 繞回去會讓人以為清單已經到底了又沒到底', () => {
      expect(move('ArrowUp', 0)).toEqual({ kind: 'focus', index: 0 });
      expect(move('ArrowDown', 4)).toEqual({ kind: 'focus', index: 4 });
    });

    it('Home / End 跳到頭尾', () => {
      expect(move('Home', 3)).toEqual({ kind: 'focus', index: 0 });
      expect(move('End', 1)).toEqual({ kind: 'focus', index: 4 });
    });

    it('單欄時左右鍵拿來進出資料夾（沒有相鄰的格子可去）', () => {
      expect(move('ArrowRight', 2)).toEqual({ kind: 'enter' });
      expect(move('ArrowLeft', 2)).toEqual({ kind: 'leave' });
    });

    it('Backspace 回上一層', () => {
      expect(move('Backspace', 2)).toEqual({ kind: 'leave' });
    });

    it('其他按鍵不歸清單管，回傳 null 讓它照常送出去', () => {
      expect(move('a', 2)).toBeNull();
      expect(move('Enter', 2)).toBeNull();
      expect(move('Escape', 2)).toBeNull();
    });
  });

  describe('多欄網格（全頁瀏覽）', () => {
    // 4 欄 10 格：最後一列只有兩格，是最容易算錯的形狀
    const move = (key: string, at: number) => navMove(key, at, 10, 4);

    it('上下鍵跨一整列', () => {
      expect(move('ArrowDown', 1)).toEqual({ kind: 'focus', index: 5 });
      expect(move('ArrowUp', 6)).toEqual({ kind: 'focus', index: 2 });
    });

    it('左右鍵移動到相鄰的格子，而不是進出資料夾', () => {
      expect(move('ArrowRight', 1)).toEqual({ kind: 'focus', index: 2 });
      expect(move('ArrowLeft', 1)).toEqual({ kind: 'focus', index: 0 });
    });

    it('最後一列不滿時往下按會落在最後一格，不會掉出範圍', () => {
      expect(move('ArrowDown', 7)).toEqual({ kind: 'focus', index: 9 });
      expect(move('ArrowDown', 9)).toEqual({ kind: 'focus', index: 9 });
    });

    it('第一列往上按停在原處', () => {
      expect(move('ArrowUp', 2)).toEqual({ kind: 'focus', index: 2 });
    });

    it('網格靠 Backspace 回上一層 —— 左鍵已經被相鄰格子用掉了', () => {
      expect(move('Backspace', 5)).toEqual({ kind: 'leave' });
    });
  });

  describe('邊界', () => {
    it('空清單時什麼都不做（否則會 focus 到不存在的索引）', () => {
      expect(navMove('ArrowDown', -1, 0, 1)).toBeNull();
      expect(navMove('Home', 0, 0, 4)).toBeNull();
    });

    it('焦點還不在清單裡時，上下鍵先進到清單的一端', () => {
      expect(navMove('ArrowDown', -1, 5, 1)).toEqual({ kind: 'focus', index: 0 });
      expect(navMove('ArrowUp', -1, 5, 1)).toEqual({ kind: 'focus', index: 4 });
    });

    it('焦點還不在清單裡時，左右鍵不做事 —— 沒有「目前這一項」可以進出', () => {
      expect(navMove('ArrowRight', -1, 5, 1)).toBeNull();
      expect(navMove('Backspace', -1, 5, 1)).toBeNull();
    });

    it('欄數量成 0（清單還沒排版）時退回逐格移動，而不是原地不動', () => {
      expect(navMove('ArrowDown', 0, 5, 0)).toEqual({ kind: 'focus', index: 1 });
    });
  });
});
