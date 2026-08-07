/**
 * 清單／網格的方向鍵巡覽：純粹的索引計算。
 *
 * 抽成純函式有兩個理由。一是側邊欄（單欄清單）與全頁瀏覽（多欄網格）要用
 * 同一套規則，差別只在欄數；二是這種「差一格」的邏輯用眼睛看不出對錯，
 * 而它一旦錯了的表現是「按了跳到奇怪的地方」——留到實機才發現太慢。
 *
 * 欄數由呼叫端從實際版面量出來（同一列的元素 offsetTop 相同），不是從設定推算：
 * 網格的欄數會隨視窗寬度變動，設定裡的欄寬只是 `minmax` 的下限。
 */
export type NavMove =
  /** 把焦點移到第 index 個項目 */
  | { kind: 'focus'; index: number }
  /** 進入目前這個項目（資料夾） */
  | { kind: 'enter' }
  /** 回到上一層 */
  | { kind: 'leave' };

/**
 * 依按鍵算出要做什麼。回傳 `null` 代表這個按鍵不歸清單管，呼叫端不要攔它。
 *
 * `at` 是目前聚焦的項目索引，焦點不在任何項目上時傳 -1。
 *
 * 單欄與多欄對左右鍵的解讀刻意不同：多欄時左右是版面上的相鄰格子，
 * 單欄時左右沒有格子可去，就拿來做樹狀的「進資料夾／回上一層」。
 */
export function navMove(key: string, at: number, count: number, columns: number): NavMove | null {
  if (count <= 0) {
    return null;
  }
  const last = count - 1;
  const step = Math.max(1, columns);
  const clamp = (index: number): NavMove => ({
    kind: 'focus',
    index: Math.max(0, Math.min(index, last)),
  });

  // 焦點還不在清單裡（例如剛從容器本身收到按鍵）：上下鍵先進到清單的一端
  if (at < 0) {
    switch (key) {
      case 'ArrowDown':
      case 'Home':
        return { kind: 'focus', index: 0 };
      case 'ArrowUp':
      case 'End':
        return { kind: 'focus', index: last };
      default:
        return null;
    }
  }

  switch (key) {
    /*
     * 上下鍵在網格裡跨一整列，但「沒有下一列」與「下一列比較短」要分開處理。
     *
     * 一律夾限的話，站在最後一列按下鍵會橫向跳到那一列的最後一格 —— 使用者
     * 沒有要換列，焦點卻自己往旁邊挪了。只有真的存在下一列時才夾限（那一列
     * 不滿，落在它的最後一格是對的）；已經在最後一列就原地不動。
     */
    case 'ArrowDown':
      return Math.floor(at / step) === Math.floor(last / step)
        ? { kind: 'focus', index: at }
        : clamp(at + step);
    case 'ArrowUp':
      return { kind: 'focus', index: at < step ? at : at - step };
    case 'ArrowRight':
      return columns > 1 ? clamp(at + 1) : { kind: 'enter' };
    case 'ArrowLeft':
      return columns > 1 ? clamp(at - 1) : { kind: 'leave' };
    case 'Home':
      return { kind: 'focus', index: 0 };
    case 'End':
      return { kind: 'focus', index: last };
    case 'Backspace':
      return { kind: 'leave' };
    default:
      return null;
  }
}

/**
 * 從版面量出欄數：第一個換行的位置就是一列的長度。
 *
 * 量出來而不是從設定推算，網格才會在視窗縮放後仍然算對（設定裡的欄寬只是
 * `minmax` 的下限）；單欄清單自然量出 1，於是上下鍵就是逐列移動。
 *
 * **一定要用 `getBoundingClientRect()`，不能用 `offsetTop`。** `offsetTop` 是
 * 相對於 `offsetParent` 的，而每一列都包在自己的 `.row-wrap` 裡、那個外框是
 * `position: relative` —— 於是每一列都量到 0，整份清單看起來像同一列，
 * 上下鍵完全不動。實機第一次按方向鍵就踩到這個。
 */
export function columnsOf(items: readonly HTMLElement[]): number {
  const first = items[0];
  if (first === undefined) {
    return 1;
  }
  const top = first.getBoundingClientRect().top;
  // 容許 1px：同一列的元素高度不同時，實際 top 可能差在小數點下
  const wrapAt = items.findIndex((item) => Math.abs(item.getBoundingClientRect().top - top) > 1);
  return wrapAt === -1 ? items.length : wrapAt;
}
