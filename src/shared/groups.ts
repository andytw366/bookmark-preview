/**
 * 群組（＝ tag）的畫面模型：書籤與隱私空間共用。
 *
 * 群組是「某個資料夾裡的一段項目」加上名稱、顏色、收合狀態。有名字的群組就是 tag；
 * 沒名字的是不用 tag 建的 group（兩張卡片疊在一起選「建立群組」）。一個項目最多屬於
 * 一個群組（使用者拍板的決定）。資料存在哪裡兩邊不同（書籤：`storage.local` 明文；
 * 隱私空間：加密的版面文件），但畫面與鍵盤巡覽只看這裡的形狀。
 *
 * 這一檔全是純函式：哪一張卡片落在哪一列、上下鍵跳到哪裡，錯了的表現都是
 * 「畫面亂掉」或「焦點跳到奇怪的地方」，只有測試釘得住。
 */

export interface GroupInfo {
  id: string;
  /** 空字串 = 沒名字的群組（畫面顯示「未命名群組」） */
  name: string;
  /** `GROUP_COLORS` 的索引 */
  color: number;
  collapsed: boolean;
}

/** 群組標題列的色條。只存索引：顏色本身由樣式決定，深色主題可以換一組 */
export const GROUP_COLORS = 6;

/** 名稱比對：去頭尾空白、不分大小寫。同一個資料夾裡不能有兩個同名群組 */
export function normalizeName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

export function sameName(a: string, b: string): boolean {
  return normalizeName(a) === normalizeName(b);
}

/** 新群組的顏色：挑這個資料夾裡用得最少的那個，相鄰的群組才分得出來 */
export function nextColor(existing: readonly GroupInfo[]): number {
  const used = new Array<number>(GROUP_COLORS).fill(0);
  for (const group of existing) {
    const color = ((group.color % GROUP_COLORS) + GROUP_COLORS) % GROUP_COLORS;
    used[color] = (used[color] ?? 0) + 1;
  }
  let best = 0;
  for (let color = 1; color < GROUP_COLORS; color += 1) {
    if ((used[color] ?? 0) < (used[best] ?? 0)) {
      best = color;
    }
  }
  return best;
}

export type Arranged<T> =
  | { kind: 'item'; item: T }
  | { kind: 'group'; group: GroupInfo; items: T[] };

/**
 * 把一個資料夾的內容（已照顯示順序排好）與群組合成畫面上的段落。
 *
 * 群組顯示在**第一個成員**的位置，其餘成員聚過來 —— 即使原生書籤的順序被別處拖亂、
 * 成員不再相鄰，畫面上照樣聚在一起（不主動去搬原生書籤，下次拖這個群組時再整理）。
 * 沒有成員在這個資料夾裡的群組不顯示。
 */
export function arrange<T extends { id: string }>(
  items: readonly T[],
  groups: readonly GroupInfo[],
  groupOf: (id: string) => string | null,
): Arranged<T>[] {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const members = new Map<string, T[]>();
  for (const item of items) {
    const groupId = groupOf(item.id);
    if (groupId !== null && byId.has(groupId)) {
      const list = members.get(groupId) ?? [];
      list.push(item);
      members.set(groupId, list);
    }
  }
  const placed = new Set<string>();
  const out: Arranged<T>[] = [];
  for (const item of items) {
    const groupId = groupOf(item.id);
    const group = groupId === null ? undefined : byId.get(groupId);
    if (group === undefined) {
      out.push({ kind: 'item', item });
      continue;
    }
    if (placed.has(group.id)) {
      continue;
    }
    placed.add(group.id);
    out.push({ kind: 'group', group, items: members.get(group.id) ?? [] });
  }
  return out;
}

/** 畫面上一個能聚焦的格子：群組標題或一張卡片 */
export type Cell<T> =
  | { kind: 'header'; group: GroupInfo; count: number }
  | { kind: 'card'; item: T; group: GroupInfo | null };

/** 一列：在攤平的格子清單裡從 `start` 開始的 `count` 個 */
export interface RowSpan {
  start: number;
  count: number;
}

export interface GridModel<T> {
  cells: Cell<T>[];
  rows: RowSpan[];
  /** 每個格子屬於第幾列，與 `cells` 對齊 */
  rowOfCell: number[];
}

/**
 * 段落 → 列。
 *
 * - 群組標題自己一列（橫跨整列）。
 * - 卡片照欄數換列，**同一段的卡片不跨到下一段**：群組的最後一列沒排滿，下一段也從新的一列開始。
 * - 收合的群組只剩標題列。
 *
 * 沒有群組時，結果與「每 `columns` 個一列」完全相同 —— 舊的固定切法是這裡的特例。
 */
export function gridModel<T>(arranged: readonly Arranged<T>[], columns: number): GridModel<T> {
  const cols = Math.max(1, columns);
  const cells: Cell<T>[] = [];
  const rows: RowSpan[] = [];
  const rowOfCell: number[] = [];

  const pushRow = (start: number, count: number): void => {
    for (let index = start; index < start + count; index += 1) {
      rowOfCell[index] = rows.length;
    }
    rows.push({ start, count });
  };

  // 連續的散卡片要湊成一段，才不會每張自成一列
  let loose: T[] = [];
  const flushCards = (items: readonly T[], group: GroupInfo | null): void => {
    for (let offset = 0; offset < items.length; offset += cols) {
      const start = cells.length;
      const slice = items.slice(offset, offset + cols);
      for (const item of slice) {
        cells.push({ kind: 'card', item, group });
      }
      pushRow(start, slice.length);
    }
  };

  for (const part of arranged) {
    if (part.kind === 'item') {
      loose.push(part.item);
      continue;
    }
    flushCards(loose, null);
    loose = [];
    const start = cells.length;
    cells.push({ kind: 'header', group: part.group, count: part.items.length });
    pushRow(start, 1);
    if (!part.group.collapsed) {
      flushCards(part.items, part.group);
    }
  }
  flushCards(loose, null);

  return { cells, rows, rowOfCell };
}

/** 第 index 個格子在第幾列（二分搜尋；列是照 start 遞增排的） */
export function rowContaining(rows: readonly RowSpan[], index: number): number {
  let low = 0;
  let high = rows.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((rows[mid]?.start ?? 0) <= index) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return Math.max(0, low);
}

/**
 * 列長不一時的方向鍵。回傳目標格子的索引，或 null（這個鍵不歸網格管）。
 *
 * 上下鍵換到上一列／下一列的同一欄（那一列比較短就落在它的最後一格；標題列只有一格）。
 * 左右鍵照攤平的順序走，所以跨得過標題列。已經在最上／最下一列時原地不動，理由與
 * `navMove` 相同：不要讓焦點自己往旁邊挪。
 */
export function rowNav(key: string, at: number, rows: readonly RowSpan[]): number | null {
  const last = rows.length === 0 ? -1 : (rows[rows.length - 1]?.start ?? 0) + (rows[rows.length - 1]?.count ?? 1) - 1;
  if (last < 0) {
    return null;
  }
  if (at < 0) {
    if (key === 'ArrowDown' || key === 'Home') {
      return 0;
    }
    if (key === 'ArrowUp' || key === 'End') {
      return last;
    }
    return null;
  }
  const row = rowContaining(rows, at);
  const span = rows[row];
  const column = span === undefined ? 0 : at - span.start;
  const into = (target: RowSpan | undefined): number =>
    target === undefined ? at : target.start + Math.min(column, target.count - 1);
  switch (key) {
    case 'ArrowDown':
      return into(rows[row + 1]);
    case 'ArrowUp':
      return into(rows[row - 1]);
    case 'ArrowRight':
      return Math.min(at + 1, last);
    case 'ArrowLeft':
      return Math.max(at - 1, 0);
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return null;
  }
}
