/**
 * 緊密排列的格子：書籤與隱私空間共用的純函式。
 *
 * 卡片永遠由左到右、由上到下排滿，**不留空格**（2026-10-07 使用者看過「固定格子＋空格」之後改的）。
 * 所以格子本身就是一個順序；欄數只決定在哪裡換行：
 *
 * - 還沒定下來的資料夾欄數跟著視窗寬度；
 * - 使用者按過欄數的 − / + 之後固定，視窗太窄就橫向捲動。
 *
 * 群組是閱讀順序上連續的一段（`board.ts`），換行換在哪裡都拆不散它，
 * 只是框起來的形狀（階梯形）不同。
 *
 * 錯了的表現是「放開之後卡片跑到別的地方」「框線畫錯」「方向鍵跳到奇怪的地方」，
 * 所以全部是純函式、全部有測試（`tests/grid.test.ts`）。
 */

export interface Grid {
  columns: number;
  /** 照閱讀順序的 id */
  cells: string[];
}

/** 欄數的範圍。上限只是防呆：再多就算加了橫向捲動也沒法用 */
export const MIN_COLUMNS = 1;
export const MAX_COLUMNS = 24;

export function clampColumns(columns: number): number {
  return Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, Math.round(columns) || MIN_COLUMNS));
}

export function rowOf(grid: Grid, index: number): number {
  return Math.floor(index / grid.columns);
}

export function colOf(grid: Grid, index: number): number {
  return index % grid.columns;
}

/** 有卡片的列數 */
export function rowCount(grid: Grid): number {
  return Math.ceil(grid.cells.length / grid.columns);
}

export function fromOrder(ids: readonly string[], columns: number): Grid {
  return { columns: clampColumns(columns), cells: [...ids] };
}

export function indexOfId(grid: Grid, id: string): number {
  return grid.cells.indexOf(id);
}

/** 由左到右、由上到下讀出來的順序（原生書籤的順序、隱私空間的 `order` 都是這個） */
export function readingOrder(grid: Grid): string[] {
  return [...grid.cells];
}

/**
 * 只留下 `live` 裡的 id，每個 id 只留第一次出現的那一個，空字串（舊格式的空格）拿掉。
 *
 * 不在 `live` 裡的：書籤可能只是還沒同步過來，隱私記錄可能還沒傳到 ——
 * 畫面上不顯示就好，不從資料裡刪掉（那是寫入時的事）。
 */
export function normalize(grid: Grid, live: ReadonlySet<string>): Grid {
  const seen = new Set<string>();
  const cells = grid.cells.filter((id) => {
    if (id === '' || !live.has(id) || seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
  return { columns: clampColumns(grid.columns), cells };
}

/** 還沒有位置的項目接在最後，照傳進來的順序（別處新增的書籤、舊版裝置加的、從別的資料夾搬進來的） */
export function placeAuto(grid: Grid, ids: readonly string[]): Grid {
  const present = new Set(grid.cells);
  const missing = [...new Set(ids)].filter((id) => id !== '' && !present.has(id));
  return missing.length === 0 ? grid : { columns: grid.columns, cells: [...grid.cells, ...missing] };
}

/** 拿掉 `ids` 之後，原本第 `at` 個位置變成第幾個（插入點跟著前面被拿走的往前挪） */
export function afterRemoval(grid: Grid, ids: ReadonlySet<string>, at: number): number {
  return at - grid.cells.slice(0, Math.max(0, at)).filter((id) => ids.has(id)).length;
}

/**
 * 把 `ids` 照傳進來的順序插在第 `at` 個位置（拿掉它們**之前**的索引；超過就接在最後）。
 * 後面的整串往後讓位，拿走的地方由後面的往前補 —— 不留空格。
 */
export function insertAt(grid: Grid, ids: readonly string[], at: number): Grid {
  const moving = new Set(ids);
  const pos = afterRemoval(grid, moving, at);
  const rest = grid.cells.filter((id) => !moving.has(id));
  const index = Math.min(Math.max(0, pos), rest.length);
  return { columns: grid.columns, cells: [...rest.slice(0, index), ...moving, ...rest.slice(index)] };
}

export type Direction = 'left' | 'right' | 'up' | 'down';

/** 往某個方向的那一格；出了左右邊界、最上面或最後一張之後就是 null */
export function stepCell(grid: Grid, index: number, direction: Direction): number | null {
  const col = colOf(grid, index);
  let next: number | null;
  switch (direction) {
    case 'left':
      next = col === 0 ? null : index - 1;
      break;
    case 'right':
      next = col === grid.columns - 1 ? null : index + 1;
      break;
    case 'up':
      next = index - grid.columns;
      break;
    case 'down':
      next = index + grid.columns;
      break;
  }
  return next === null || next < 0 || next >= grid.cells.length ? null : next;
}

export interface Edges {
  top: boolean;
  right: boolean;
  bottom: boolean;
  left: boolean;
}

/**
 * 每一格的上下左右哪幾邊要畫框：鄰格不是同一個群組（或沒有鄰格）就畫。
 * 回傳只含屬於群組的格子。群組是連續的一段，所以畫出來是一塊階梯形。
 */
export function outlineEdges(grid: Grid, groupOf: (id: string) => string | null): Map<number, Edges> {
  const groupAt = (index: number): string | null => {
    const id = grid.cells[index];
    return id === undefined ? null : groupOf(id);
  };
  const out = new Map<number, Edges>();
  grid.cells.forEach((id, index) => {
    const group = groupOf(id);
    if (group === null) {
      return;
    }
    const col = colOf(grid, index);
    out.set(index, {
      top: index - grid.columns < 0 || groupAt(index - grid.columns) !== group,
      right: col === grid.columns - 1 || groupAt(index + 1) !== group,
      bottom: groupAt(index + grid.columns) !== group,
      left: col === 0 || groupAt(index - 1) !== group,
    });
  });
  return out;
}

/** 改欄數：順序不變，只是換行的位置變了 */
export function setColumns(grid: Grid, columns: number): Grid {
  return { columns: clampColumns(columns), cells: grid.cells };
}

/**
 * 方向鍵：左右照順序前一張／後一張，上下是上一列／下一列的同一欄（下一列比較短就落在最後一張）。
 * 到底了原地不動（不要讓焦點自己往旁邊挪）。
 *
 * `from` 為 -1（焦點不在格子裡）時，下／右／Home 到第一張、上／左／End 到最後一張。
 * 回傳 null = 這個鍵不歸格子管，或格子是空的。
 */
export function navCell(grid: Grid, from: number, key: string): number | null {
  const last = grid.cells.length - 1;
  if (last < 0) {
    return null;
  }
  if (from < 0) {
    if (key === 'ArrowDown' || key === 'Home' || key === 'ArrowRight') {
      return 0;
    }
    if (key === 'ArrowUp' || key === 'End' || key === 'ArrowLeft') {
      return last;
    }
    return null;
  }
  switch (key) {
    case 'Home':
      return 0;
    case 'End':
      return last;
    case 'ArrowRight':
      return Math.min(from + 1, last);
    case 'ArrowLeft':
      return Math.max(from - 1, 0);
    case 'ArrowUp':
      return from - grid.columns >= 0 ? from - grid.columns : from;
    case 'ArrowDown':
      return rowOf(grid, from) < rowOf(grid, last) ? Math.min(from + grid.columns, last) : from;
    default:
      return null;
  }
}

/** 存起來的格子：只能是字串，空字串（舊格式的空格）拿掉 */
export function decodeCells(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((cell) => typeof cell === 'string')) {
    return null;
  }
  return (value as string[]).filter((cell) => cell !== '');
}

/**
 * 把 `current` 排成 `want` 時，哪些項目可以不動（最長遞增子序列）。
 *
 * 原生書籤要跟著格子的閱讀順序走（擴充套件不在時排列仍然合理），但每次只該搬
 * 順序真的變了的那幾筆 —— 一次 `bookmarks.move` 就是一次同步與一次 `onMoved`。
 * `want` 裡不在 `current` 的 id 忽略。
 */
export function unmoved(current: readonly string[], want: readonly string[]): Set<string> {
  const position = new Map(current.map((id, index) => [id, index]));
  const seq = want.filter((id) => position.has(id));
  const tails: number[] = [];
  const tailAt: number[] = [];
  const parent: number[] = [];
  seq.forEach((id, i) => {
    const value = position.get(id) ?? 0;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((tails[mid] ?? 0) < value) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    tails[low] = value;
    tailAt[low] = i;
    parent[i] = low > 0 ? (tailAt[low - 1] ?? -1) : -1;
  });
  const keep = new Set<string>();
  let at = tails.length > 0 ? (tailAt[tails.length - 1] ?? -1) : -1;
  while (at !== -1) {
    keep.add(seq[at] ?? '');
    at = parent[at] ?? -1;
  }
  return keep;
}
