/**
 * 虛擬滾動的視窗計算：純粹算「該渲染哪幾列、上下要墊多高」。
 *
 * 抽成純函式的理由與 `list-nav.ts` 相同 —— 這裡全是差一格的算術，錯了的表現是
 * 「捲到一半空一塊」或「捲不到底」，用眼睛看不出來、也很難在實機上重現。
 *
 * **單位是「列」而不是「項目」**：側邊欄一列一個項目，全頁瀏覽一列 N 個。
 * 把欄數收斂在呼叫端之後，兩個畫面就能共用同一份計算。
 *
 * 列高由呼叫端提供（量到的用量到的，沒量到的用估計值），而不是假設固定高度 ——
 * 大卡模式下封面圖採用自己的長寬比，每一列本來就不一樣高。
 */
export interface VirtualWindow {
  /** 要渲染的第一列（含） */
  firstRow: number;
  /** 要渲染的最後一列（不含） */
  endRow: number;
  /** 上方要墊的高度，代表被略過的那些列 */
  padTop: number;
  /** 下方要墊的高度 */
  padBottom: number;
}

export interface WindowParams {
  rowCount: number;
  /** 第 row 列的高度（含列與列之間的間距） */
  heightOf: (row: number) => number;
  /** 已經捲過內容頂端多少（負值代表內容還在視窗下方） */
  scrollTop: number;
  /** 可視高度 */
  viewport: number;
  /** 上下各多渲染幾列，讓快速捲動時不會先看到空白 */
  overscan: number;
}

/**
 * 算出目前該渲染的列範圍。
 *
 * 刻意不建任何陣列：清單可以到幾萬列，而這個函式每次捲動都會跑一遍。
 * 幾萬次加法對每秒 60 次的捲動事件是可忽略的，一次幾萬個元素的配置不是。
 */
export function windowFor({
  rowCount,
  heightOf,
  scrollTop,
  viewport,
  overscan,
}: WindowParams): VirtualWindow {
  if (rowCount <= 0) {
    return { firstRow: 0, endRow: 0, padTop: 0, padBottom: 0 };
  }
  const top = Math.max(0, scrollTop);
  const bottom = top + Math.max(0, viewport);

  // 往下走到第一列的底邊超過視窗上緣為止。留最後一列不走，
  // 捲過頭時（內容變短、或彈性捲動）才不會整個範圍落到清單外面。
  let row = 0;
  let offset = 0;
  while (row < rowCount - 1) {
    const height = Math.max(0, heightOf(row));
    if (offset + height > top) {
      break;
    }
    offset += height;
    row += 1;
  }

  // 從這裡繼續往下，直到蓋滿視窗
  let endRow = row;
  let filled = offset;
  while (endRow < rowCount && filled < bottom) {
    filled += Math.max(0, heightOf(endRow));
    endRow += 1;
  }
  /*
   * 至少要渲染一列。
   *
   * 第一次繪製時容器還沒量到高度（viewport 為 0），照上面的迴圈會一列都不渲染 ——
   * 而沒有渲染就量不到列高、也量不到容器，畫面會卡在空白。渲染一列就足以讓
   * 量測啟動，下一次計算就正常了。
   */
  endRow = Math.max(endRow, row + 1);

  // overscan：往回退的同時要把 padTop 一起扣掉，兩者必須一致，
  // 否則墊高與實際渲染的列對不上，畫面會整批位移
  let firstRow = row;
  let padTop = offset;
  for (let n = 0; n < overscan && firstRow > 0; n += 1) {
    firstRow -= 1;
    padTop -= Math.max(0, heightOf(firstRow));
  }
  endRow = Math.min(rowCount, endRow + overscan);

  let padBottom = 0;
  for (let rest = endRow; rest < rowCount; rest += 1) {
    padBottom += Math.max(0, heightOf(rest));
  }

  return { firstRow, endRow, padTop: Math.max(0, padTop), padBottom };
}

/**
 * 網格的欄數，從容器寬度算出來。
 *
 * 對應 CSS 的 `repeat(auto-fill, minmax(min, 1fr))`：每一欄至少 `min` 寬，
 * 欄與欄之間有 `gap`。**不能沿用 `list-nav.ts` 的 `columnsOf()`** —— 那個是從
 * 已渲染的元素量出來的，而這裡要在決定「渲染哪幾列」之前就知道欄數。
 */
export function columnsForWidth(width: number, min: number, gap: number): number {
  if (width <= 0 || min <= 0) {
    return 1;
  }
  return Math.max(1, Math.floor((width + gap) / (min + gap)));
}
