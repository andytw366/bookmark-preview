/**
 * 固定格子（第 3 期改版）：書籤與隱私空間共用的純函式。
 *
 * 每個「定下來」的資料夾有固定欄數，每張卡片記住自己在第幾格（索引 = 列 × 欄數 + 欄），
 * 可以留空格 —— 像手機桌面。為什麼不用「順序 + 自動換行」：群組可以是不規則的形狀
 * （一定上下左右相連），換行的排法一改視窗寬度就會把形狀拆散（NEXT.md「為什麼要固定格子」）。
 *
 * 格子是 `cells` 陣列，`''` 是空格。結尾的空格不存（`trimEnd`）。
 *
 * 錯了的表現是「放開之後卡片跑到別的地方」「框線畫錯」「方向鍵跳到奇怪的地方」，
 * 用眼睛很難看出是哪一格算錯，所以全部是純函式、全部有測試（`tests/grid.test.ts`）。
 */

export const EMPTY = '';

export interface Grid {
  columns: number;
  /** 逐格的 id；`''` = 空格 */
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

/** 結尾的空格拿掉 */
export function trimEnd(cells: readonly string[]): string[] {
  let end = cells.length;
  while (end > 0 && cells[end - 1] === EMPTY) {
    end -= 1;
  }
  return cells.slice(0, end);
}

/** 有卡片的列數（最後一列之後還會多畫一整列空格，那不算在這裡） */
export function rowCount(grid: Grid): number {
  return Math.ceil(trimEnd(grid.cells).length / grid.columns);
}

/** 照順序排滿：還沒定下來的資料夾、以及第一次定下來的那一刻 */
export function fromOrder(ids: readonly string[], columns: number): Grid {
  return { columns: clampColumns(columns), cells: [...ids] };
}

export function indexOfId(grid: Grid, id: string): number {
  return grid.cells.indexOf(id);
}

/** 由左到右、由上到下讀出來的順序（原生書籤的順序、隱私空間的 `order` 都是這個） */
export function readingOrder(grid: Grid): string[] {
  return grid.cells.filter((id) => id !== EMPTY);
}

/**
 * 只留下 `live` 裡的 id，每個 id 只留第一次出現的那一格。
 *
 * 不在 `live` 裡的格子當空格：書籤可能只是還沒同步過來，隱私記錄可能還沒傳到 ——
 * 畫面上讓出那一格，但要不要從資料裡拿掉由呼叫端決定（見 `restoreGhosts`）。
 */
export function normalize(grid: Grid, live: ReadonlySet<string>): Grid {
  const seen = new Set<string>();
  const cells = grid.cells.map((id) => {
    if (id === EMPTY || !live.has(id) || seen.has(id)) {
      return EMPTY;
    }
    seen.add(id);
    return id;
  });
  return { columns: clampColumns(grid.columns), cells: trimEnd(cells) };
}

/**
 * 操作完之後把「本機不存在的 id」放回原位 —— 只放回仍然空著的格子。
 *
 * 書籤這邊用：格子裡指向本機還沒有的 GUID（Firefox 同步還沒把那筆書籤帶過來），
 * 不能因為這台裝置做了一次拖拽就把它的位置刪掉。被別的卡片佔走了就算了。
 */
export function restoreGhosts(stored: Grid, next: Grid, live: ReadonlySet<string>): Grid {
  if (stored.columns !== next.columns) {
    return next;
  }
  const placed = new Set(next.cells);
  const cells = [...next.cells];
  stored.cells.forEach((id, index) => {
    if (id === EMPTY || live.has(id) || placed.has(id)) {
      return;
    }
    while (cells.length <= index) {
      cells.push(EMPTY);
    }
    if (cells[index] === EMPTY) {
      cells[index] = id;
      placed.add(id);
    }
  });
  return { columns: next.columns, cells: trimEnd(cells) };
}

/**
 * 還沒有位置的項目放進最後一張卡片之後的空格，照傳進來的順序。
 * （別處新增的書籤、舊版裝置加的、從別的資料夾搬進來的。）
 */
export function placeAuto(grid: Grid, ids: readonly string[]): Grid {
  const present = new Set(grid.cells);
  const missing = ids.filter((id) => id !== EMPTY && !present.has(id));
  if (missing.length === 0) {
    return grid;
  }
  return { columns: grid.columns, cells: [...trimEnd(grid.cells), ...new Set(missing)] };
}

function without(cells: readonly string[], ids: ReadonlySet<string>): string[] {
  return cells.map((id) => (ids.has(id) ? EMPTY : id));
}

/**
 * 插入，後面的往後擠：從 `at` 開始依序放 `ids`。目標格有卡片時，從那一格到下一個空格
 * 之間的卡片照「由左到右、由上到下」各往後移一格；遇到第一個空格就停，空格後面的不動。
 *
 * `ids` 先從原本的位置拿掉（留下空格），所以在同一個資料夾裡拖動時，被擠的卡片會
 * 剛好補進拖走的那一格。`at` 是拿掉之前的索引 —— 拿掉不會讓任何格子位移。
 */
export function insertPush(grid: Grid, ids: readonly string[], at: number): Grid {
  const moving = [...new Set(ids)].filter((id) => id !== EMPTY);
  const cells = without(grid.cells, new Set(moving));
  let p = Math.max(0, at);
  for (const id of moving) {
    while (cells.length <= p) {
      cells.push(EMPTY);
    }
    if (cells[p] !== EMPTY) {
      let q = p;
      while (q < cells.length && cells[q] !== EMPTY) {
        q += 1;
      }
      if (q === cells.length) {
        cells.push(EMPTY);
      }
      for (let k = q; k > p; k -= 1) {
        cells[k] = cells[k - 1] ?? EMPTY;
      }
    }
    cells[p] = id;
    p += 1;
  }
  return { columns: grid.columns, cells: trimEnd(cells) };
}

/** 兩格互換（鍵盤一次挪一格、目標有卡片時用） */
export function swapCells(grid: Grid, a: number, b: number): Grid {
  const cells = [...grid.cells];
  while (cells.length <= Math.max(a, b)) {
    cells.push(EMPTY);
  }
  const first = cells[a] ?? EMPTY;
  cells[a] = cells[b] ?? EMPTY;
  cells[b] = first;
  return { columns: grid.columns, cells: trimEnd(cells) };
}

export type Direction = 'left' | 'right' | 'up' | 'down';

/** 往某個方向的那一格；出了左右邊界或最上面就是 null（往下永遠有格子） */
export function stepCell(grid: Grid, index: number, direction: Direction): number | null {
  const row = rowOf(grid, index);
  const col = colOf(grid, index);
  switch (direction) {
    case 'left':
      return col === 0 ? null : index - 1;
    case 'right':
      return col === grid.columns - 1 ? null : index + 1;
    case 'up':
      return row === 0 ? null : index - grid.columns;
    case 'down':
      return index + grid.columns;
  }
}

/** 上下左右相鄰的格子（不出界；往下不設限，因為最後一列之後也是格子） */
export function neighbors4(grid: Grid, index: number): number[] {
  return (['up', 'left', 'right', 'down'] as const)
    .map((direction) => stepCell(grid, index, direction))
    .filter((cell): cell is number => cell !== null);
}

/**
 * `members` 這幾個 id 所在格子的連通塊（4 連通），每塊照閱讀順序排好，
 * 塊與塊照「第一格」的閱讀順序排 —— 第一塊就是有名稱標籤的那一塊。
 */
export function components(grid: Grid, members: ReadonlySet<string>): number[][] {
  const cells = new Set<number>();
  grid.cells.forEach((id, index) => {
    if (id !== EMPTY && members.has(id)) {
      cells.add(index);
    }
  });
  const seen = new Set<number>();
  const out: number[][] = [];
  for (const start of [...cells].sort((a, b) => a - b)) {
    if (seen.has(start)) {
      continue;
    }
    const block: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const cell = stack.pop() ?? 0;
      block.push(cell);
      for (const next of neighbors4(grid, cell)) {
        if (cells.has(next) && !seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    out.push(block.sort((a, b) => a - b));
  }
  return out;
}

export interface Edges {
  top: boolean;
  right: boolean;
  bottom: boolean;
  left: boolean;
}

/**
 * 每一格的上下左右哪幾邊要畫框：鄰格不是同一個群組就畫。
 *
 * 回傳只含屬於群組的格子。群組被擠成好幾塊時每一塊都會有完整的框（同色）。
 */
export function outlineEdges(grid: Grid, groupOf: (id: string) => string | null): Map<number, Edges> {
  const groupAt = (index: number | null): string | null => {
    if (index === null) {
      return null;
    }
    const id = grid.cells[index];
    return id === undefined || id === EMPTY ? null : groupOf(id);
  };
  const out = new Map<number, Edges>();
  grid.cells.forEach((id, index) => {
    const group = id === EMPTY ? null : groupOf(id);
    if (group === null) {
      return;
    }
    out.set(index, {
      top: groupAt(stepCell(grid, index, 'up')) !== group,
      right: groupAt(stepCell(grid, index, 'right')) !== group,
      bottom: groupAt(stepCell(grid, index, 'down')) !== group,
      left: groupAt(stepCell(grid, index, 'left')) !== group,
    });
  });
  return out;
}

/**
 * 改欄數。
 *
 * 留在新欄數範圍內的卡片維持原本的列與欄；被切掉的那幾欄裡的卡片，照閱讀順序放進
 * 「它原本那一列的最後一格」之後的第一個空格 —— 不擠動別人，形狀能留的都留著。
 */
export function setColumns(grid: Grid, columns: number): Grid {
  const next = clampColumns(columns);
  if (next === grid.columns) {
    return grid;
  }
  const cells: string[] = [];
  const evicted: { id: string; row: number }[] = [];
  grid.cells.forEach((id, index) => {
    if (id === EMPTY) {
      return;
    }
    const row = rowOf(grid, index);
    const col = colOf(grid, index);
    if (col < next) {
      const at = row * next + col;
      while (cells.length <= at) {
        cells.push(EMPTY);
      }
      cells[at] = id;
    } else {
      evicted.push({ id, row });
    }
  });
  for (const { id, row } of evicted) {
    let at = row * next + next - 1;
    while (at < cells.length && cells[at] !== EMPTY) {
      at += 1;
    }
    while (cells.length <= at) {
      cells.push(EMPTY);
    }
    cells[at] = id;
  }
  return { columns: next, cells: trimEnd(cells) };
}

/**
 * 整個形狀平移（拖群組的標籤、或在標籤上按 Ctrl+Shift+方向鍵）。
 *
 * 目標格子要全空（或本來就是這個形狀自己的）才放得下，而且不能出左右邊界與最上面；
 * 放不下回 null —— 擠動沒辦法保持形狀，所以不擠。
 */
export function shiftShape(grid: Grid, members: ReadonlySet<string>, dRow: number, dCol: number): Grid | null {
  const moves: { from: number; to: number }[] = [];
  for (let index = 0; index < grid.cells.length; index += 1) {
    const id = grid.cells[index];
    if (id === undefined || id === EMPTY || !members.has(id)) {
      continue;
    }
    const row = rowOf(grid, index) + dRow;
    const col = colOf(grid, index) + dCol;
    if (row < 0 || col < 0 || col >= grid.columns) {
      return null;
    }
    moves.push({ from: index, to: row * grid.columns + col });
  }
  if (moves.length === 0) {
    return null;
  }
  const cells = without(grid.cells, members);
  for (const { to } of moves) {
    const there = cells[to];
    if (there !== undefined && there !== EMPTY) {
      return null;
    }
  }
  for (const { from, to } of moves) {
    while (cells.length <= to) {
      cells.push(EMPTY);
    }
    cells[to] = grid.cells[from] ?? EMPTY;
  }
  return { columns: grid.columns, cells: trimEnd(cells) };
}

/**
 * 把另一個資料夾的形狀接到這個格子的最後一列之後（整組搬進資料夾）。
 * `shape` 是來源格子與那幾個 id；欄數不同時超出的欄往左貼齊，形狀盡量保持。
 */
export function appendShape(grid: Grid, source: Grid, ids: ReadonlySet<string>): Grid {
  const blocks: { id: string; row: number; col: number }[] = [];
  source.cells.forEach((id, index) => {
    if (id !== EMPTY && ids.has(id)) {
      blocks.push({ id, row: rowOf(source, index), col: colOf(source, index) });
    }
  });
  if (blocks.length === 0) {
    return grid;
  }
  const minRow = Math.min(...blocks.map((block) => block.row));
  const minCol = Math.min(...blocks.map((block) => block.col));
  const maxCol = Math.max(...blocks.map((block) => block.col));
  // 太寬就從第 0 欄開始放，還是放不下的欄由 setColumns 的規則處理（往後找空格）
  const shift = maxCol < grid.columns ? 0 : minCol;
  // 「最後一列」要在拿掉這幾個 id 之後算：搬過來的那一刻它們已經被自動排在最後面了
  const cells = trimEnd(without(grid.cells, ids));
  const base = Math.ceil(cells.length / grid.columns);
  const overflow: string[] = [];
  for (const block of blocks) {
    const col = block.col - shift;
    if (col >= grid.columns) {
      overflow.push(block.id);
      continue;
    }
    const at = (base + block.row - minRow) * grid.columns + col;
    while (cells.length <= at) {
      cells.push(EMPTY);
    }
    cells[at] = block.id;
  }
  return placeAuto({ columns: grid.columns, cells: trimEnd(cells) }, overflow);
}

export type NavKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

/**
 * 方向鍵：在**有卡片的格子**之間移動，跳過空格。
 *
 * - 左右：照閱讀順序的前一張／後一張（跨得過列尾）
 * - 上下：往那個方向一列一列找，第一個有卡片的列裡挑欄位最近的（同距離取左邊）
 * - 到底了原地不動（與 `navMove` 同一個理由：不要讓焦點自己往旁邊挪）
 *
 * `from` 為 -1（焦點不在格子裡）時，下／Home 到第一張、上／End 到最後一張。
 * 回傳 null = 這個鍵不歸格子管，或格子是空的。
 */
export function navCell(grid: Grid, from: number, key: string): number | null {
  const filled: number[] = [];
  grid.cells.forEach((id, index) => {
    if (id !== EMPTY) {
      filled.push(index);
    }
  });
  const first = filled[0];
  const last = filled[filled.length - 1];
  if (first === undefined || last === undefined) {
    return null;
  }
  if (from < 0) {
    if (key === 'ArrowDown' || key === 'Home' || key === 'ArrowRight') {
      return first;
    }
    if (key === 'ArrowUp' || key === 'End' || key === 'ArrowLeft') {
      return last;
    }
    return null;
  }
  switch (key) {
    case 'Home':
      return first;
    case 'End':
      return last;
    case 'ArrowRight':
      return filled.find((index) => index > from) ?? from;
    case 'ArrowLeft':
      return [...filled].reverse().find((index) => index < from) ?? from;
    case 'ArrowUp':
    case 'ArrowDown': {
      const step = key === 'ArrowDown' ? 1 : -1;
      const col = colOf(grid, from);
      const lastRow = rowOf(grid, last);
      for (let row = rowOf(grid, from) + step; row >= 0 && row <= lastRow; row += step) {
        let best: number | null = null;
        let bestDistance = Infinity;
        for (let c = 0; c < grid.columns; c += 1) {
          const index = row * grid.columns + c;
          const id = grid.cells[index];
          if (id === undefined || id === EMPTY) {
            continue;
          }
          const distance = Math.abs(c - col);
          if (distance < bestDistance) {
            best = index;
            bestDistance = distance;
          }
        }
        if (best !== null) {
          return best;
        }
      }
      return from;
    }
    default:
      return null;
  }
}

/** 存起來的形狀：結尾空格去掉、只能是字串 */
export function encodeCells(grid: Grid): string[] {
  return trimEnd(grid.cells);
}

export function decodeCells(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((cell) => typeof cell === 'string')) {
    return null;
  }
  return trimEnd(value as string[]);
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
