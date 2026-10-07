/**
 * 群組外框的幾何：把成員卡片的矩形合成一個多邊形，畫成一條圓角路徑。
 *
 * 為什麼不再讓每一格各畫自己那一塊框（第 3 期改版的做法）：L 形、階梯形、兩組相鄰時，
 * 每格的框要靠「伸長、切角」拼起來，組合一多就有接不上或疊歪的轉角（2026-10-07 使用者實際看到）。
 * 這裡改成先算出整個群組的外緣，再畫一條線 —— 任何形狀的轉角都由同一套幾何決定。
 *
 * 純函式，座標是像素；量測在畫面那邊（`GroupOutlines`）。
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Point = [number, number];

export interface MemberCell {
  /** 在畫面格子裡的索引（列 × 欄數 + 欄） */
  index: number;
  rect: Rect;
}

/**
 * 一個群組要填滿的矩形：每張卡片往外擴 `pad`，相鄰（同列左右、同欄上下）的卡片之間把間距補起來，
 * 2×2 都是成員時連中間那個十字交會的空格也補起來。
 */
export function groupRects(cells: readonly MemberCell[], columns: number, pad: number): Rect[] {
  const byIndex = new Map(cells.map((cell) => [cell.index, cell.rect]));
  const out: Rect[] = [];
  for (const { index, rect } of cells) {
    out.push({ x: rect.x - pad, y: rect.y - pad, w: rect.w + 2 * pad, h: rect.h + 2 * pad });
    const right = index % columns < columns - 1 ? byIndex.get(index + 1) : undefined;
    const down = byIndex.get(index + columns);
    if (right !== undefined) {
      out.push({ x: rect.x + rect.w, y: rect.y - pad, w: right.x - (rect.x + rect.w), h: rect.h + 2 * pad });
    }
    if (down !== undefined) {
      out.push({ x: rect.x - pad, y: rect.y + rect.h, w: rect.w + 2 * pad, h: down.y - (rect.y + rect.h) });
    }
    if (right !== undefined && down !== undefined && byIndex.has(index + columns + 1)) {
      out.push({ x: rect.x + rect.w, y: rect.y + rect.h, w: right.x - (rect.x + rect.w), h: down.y - (rect.y + rect.h) });
    }
  }
  return out.filter((rect) => rect.w > 0 && rect.h > 0);
}

/**
 * 一組矩形聯集的外緣，每一圈是一串頂點（順時針，螢幕座標 y 朝下），共線的點已經合併。
 *
 * 做法：用所有矩形的邊切出一張不等距的網格，標出哪些小格被蓋到，收集「一邊有蓋、一邊沒蓋」
 * 的邊，再一段一段接成圈。
 */
export function unionOutline(rects: readonly Rect[]): Point[][] {
  if (rects.length === 0) {
    return [];
  }
  const xs = [...new Set(rects.flatMap((rect) => [rect.x, rect.x + rect.w]))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap((rect) => [rect.y, rect.y + rect.h]))].sort((a, b) => a - b);
  const filled = (i: number, j: number): boolean => {
    if (i < 0 || j < 0 || i >= xs.length - 1 || j >= ys.length - 1) {
      return false;
    }
    const cx = ((xs[i] ?? 0) + (xs[i + 1] ?? 0)) / 2;
    const cy = ((ys[j] ?? 0) + (ys[j + 1] ?? 0)) / 2;
    return rects.some((rect) => cx > rect.x && cx < rect.x + rect.w && cy > rect.y && cy < rect.y + rect.h);
  };

  // 有向邊（格點索引），內部在行進方向的右手邊 —— 順時針
  const key = (i: number, j: number): string => `${String(i)},${String(j)}`;
  const outgoing = new Map<string, [number, number][]>();
  const add = (from: [number, number], to: [number, number]): void => {
    const list = outgoing.get(key(...from)) ?? [];
    list.push(to);
    outgoing.set(key(...from), list);
  };
  for (let i = 0; i < xs.length - 1; i += 1) {
    for (let j = 0; j < ys.length - 1; j += 1) {
      if (!filled(i, j)) {
        continue;
      }
      if (!filled(i, j - 1)) {
        add([i, j], [i + 1, j]);
      }
      if (!filled(i + 1, j)) {
        add([i + 1, j], [i + 1, j + 1]);
      }
      if (!filled(i, j + 1)) {
        add([i + 1, j + 1], [i, j + 1]);
      }
      if (!filled(i - 1, j)) {
        add([i, j + 1], [i, j]);
      }
    }
  }

  const loops: Point[][] = [];
  for (const [start, targets] of outgoing) {
    while (targets.length > 0) {
      const [si, sj] = start.split(',').map(Number) as [number, number];
      const loop: [number, number][] = [[si, sj]];
      let current: [number, number] = targets.shift() ?? [si, sj];
      let guard = 0;
      while (key(...current) !== start && guard < 100_000) {
        loop.push(current);
        const next = outgoing.get(key(...current));
        const step = next?.shift();
        if (step === undefined) {
          break;
        }
        current = step;
        guard += 1;
      }
      loops.push(simplify(loop.map(([i, j]) => [xs[i] ?? 0, ys[j] ?? 0])));
    }
  }
  return loops.filter((loop) => loop.length >= 4);
}

/** 拿掉在一直線上的中間點 */
function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  const n = points.length;
  for (let k = 0; k < n; k += 1) {
    const prev = points[(k - 1 + n) % n] ?? [0, 0];
    const here = points[k] ?? [0, 0];
    const next = points[(k + 1) % n] ?? [0, 0];
    const collinear = (prev[0] === here[0] && here[0] === next[0]) || (prev[1] === here[1] && here[1] === next[1]);
    if (!collinear) {
      out.push(here);
    }
  }
  return out;
}

/** 多邊形 → SVG 路徑，每個轉角（凸角、凹角都一樣）用半徑最多 `radius` 的弧線圓起來 */
export function roundedPath(loop: readonly Point[], radius: number): string {
  const n = loop.length;
  if (n < 3) {
    return '';
  }
  const parts: string[] = [];
  for (let k = 0; k < n; k += 1) {
    const prev = loop[(k - 1 + n) % n] ?? [0, 0];
    const here = loop[k] ?? [0, 0];
    const next = loop[(k + 1) % n] ?? [0, 0];
    const lenPrev = Math.hypot(prev[0] - here[0], prev[1] - here[1]);
    const lenNext = Math.hypot(next[0] - here[0], next[1] - here[1]);
    const r = Math.min(radius, lenPrev / 2, lenNext / 2);
    const from: Point = [here[0] + ((prev[0] - here[0]) / lenPrev) * r, here[1] + ((prev[1] - here[1]) / lenPrev) * r];
    const to: Point = [here[0] + ((next[0] - here[0]) / lenNext) * r, here[1] + ((next[1] - here[1]) / lenNext) * r];
    parts.push(`${k === 0 ? 'M' : 'L'}${fmt(from)}Q${fmt(here)} ${fmt(to)}`);
  }
  return `${parts.join('')}Z`;
}

function fmt([x, y]: Point): string {
  return `${String(Math.round(x * 10) / 10)},${String(Math.round(y * 10) / 10)}`;
}
