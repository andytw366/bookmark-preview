/**
 * 拖拽放開時，落點代表什麼動作。
 *
 * | 落在卡片的 | 資料夾卡片 | 書籤卡片 |
 * |---|---|---|
 * | 前緣（約 30%） | 插到前面 | 插到前面 |
 * | 中央 | 移進這個資料夾 | 合併（跳選單） |
 * | 後緣（約 30%） | 插到後面 | 插到後面 |
 *
 * 網格看左右、清單（第 4 期的側邊欄，只有一欄）看上下。寫成純函式是因為「差幾個像素
 * 就變成另一個動作」用眼睛看不出對錯，而錯了的表現是「放開之後東西跑到奇怪的地方」。
 */

export type DropTarget = 'folder' | 'bookmark';

export type DropIntent =
  | { kind: 'before' }
  | { kind: 'after' }
  | { kind: 'into' }
  | { kind: 'merge' };

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 前後緣各佔多少 */
export const EDGE = 0.3;

export function dropIntent(
  box: Box,
  x: number,
  y: number,
  target: DropTarget,
  axis: 'horizontal' | 'vertical' = 'horizontal',
): DropIntent {
  const span = axis === 'horizontal' ? box.width : box.height;
  const offset = axis === 'horizontal' ? x - box.left : y - box.top;
  // 量不到大小（還沒排版）時當成插到前面：最不會出事的那個動作
  const ratio = span > 0 ? offset / span : 0;
  if (ratio < EDGE) {
    return { kind: 'before' };
  }
  if (ratio > 1 - EDGE) {
    return { kind: 'after' };
  }
  return target === 'folder' ? { kind: 'into' } : { kind: 'merge' };
}

/**
 * 「插到後面」換算成「插到下一個的前面」，後端只需要一種錨點。
 *
 * `order` 是畫面上的順序；回傳 null 代表放到最後。
 */
export function anchorFor(
  order: readonly string[],
  targetId: string,
  intent: { kind: 'before' } | { kind: 'after' },
): string | null {
  const at = order.indexOf(targetId);
  if (at === -1) {
    return null;
  }
  if (intent.kind === 'before') {
    return targetId;
  }
  return order[at + 1] ?? null;
}

/**
 * 這次放開會不會什麼都沒變（拖回原位）。沒變就不要送出請求 —— 隱私空間每送一次就是
 * 一次重新加密加一次同步。
 */
export function isNoop(order: readonly string[], moving: readonly string[], beforeId: string | null): boolean {
  if (moving.length !== 1) {
    return false;
  }
  const id = moving[0];
  const at = order.indexOf(id ?? '');
  if (at === -1) {
    return false;
  }
  return beforeId === id || beforeId === (order[at + 1] ?? null);
}
