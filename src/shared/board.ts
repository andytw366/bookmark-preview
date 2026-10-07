import {
  EMPTY,
  components,
  fromOrder,
  indexOfId,
  insertPush,
  neighbors4,
  normalize,
  placeAuto,
  readingOrder,
  colOf,
  rowOf,
  setColumns,
  shiftShape,
  stepCell,
  swapCells,
  trimEnd,
  type Direction,
  type Grid,
} from './grid';
import { nextColor, sameName, type GroupInfo } from './groups';
import { t } from './i18n';

/**
 * 一個資料夾的「版面」：固定格子 + 這個資料夾的群組 + 誰在哪個群組。
 *
 * 書籤與隱私空間各自把自己的資料轉成 `Board`（`buildBoard`）、套用同一套操作
 * （`applyOp`）、再各自寫回去。規則只寫在這一份裡，兩個空間的行為才會一模一樣。
 *
 * 使用者拍板的規則（NEXT.md「第 3 期改版」）：
 *
 * - 群組成員一定上下左右相連，形狀不限。放在和群組相鄰的格子 = 加入；拖到不相鄰的地方 = 離開。
 * - **擠動不改別人的群組**：被擠動的卡片保留原本的成員資格，只有被拖的那幾張依相鄰規則改。
 *   所以擠動可能把別的群組暫時拆成幾塊（每塊都畫框），不自動踢人。
 * - 被拖的卡片原本所在的群組若因此斷成幾塊，只留「有名稱標籤的那一塊」（第一個成員所在的那塊），
 *   其餘離開群組。
 * - 只有書籤能進群組（資料夾不行）。
 */

export interface Board {
  /** false = 還沒定下來（自動換行，欄數跟著視窗）。任何操作之後都會定下來，除了「恢復自動排列」 */
  fixed: boolean;
  grid: Grid;
  /** 這個資料夾的群組。沒有成員的會在操作後消失 */
  groups: GroupInfo[];
  /** 項目 id → 群組 id。只含這個資料夾裡、群組還在的 */
  memberOf: Map<string, string>;
}

export interface BoardInput {
  /** 存下來的格子；null = 還沒定下來 */
  stored: Grid | null;
  /** 這個資料夾現在的內容，照預設順序（原生書籤的順序；隱私空間的 `order`／預設排序） */
  children: readonly string[];
  /** 還沒定下來時用的欄數（畫面寬度算出來的） */
  autoColumns: number;
  groups: readonly GroupInfo[];
  groupOf: (id: string) => string | null;
}

export function buildBoard(input: BoardInput): Board {
  const live = new Set(input.children);
  const grid =
    input.stored === null
      ? fromOrder(input.children, input.autoColumns)
      : placeAuto(normalize(input.stored, live), input.children);
  const known = new Set(input.groups.map((group) => group.id));
  const memberOf = new Map<string, string>();
  for (const id of input.children) {
    const groupId = input.groupOf(id);
    if (groupId !== null && known.has(groupId)) {
      memberOf.set(id, groupId);
    }
  }
  return { fixed: input.stored !== null, grid, groups: input.groups.map((group) => ({ ...group })), memberOf };
}

export type GridOp =
  /** 拖拽放開：插入在 `at`（目標有卡片就往後擠）。`aimed` 是放下時對準的那張卡片（空格是 null） */
  | { kind: 'place'; ids: string[]; at: number; aimed: string | null }
  /** 鍵盤一次挪一格：目標空就放，有卡片就互換 */
  | { kind: 'nudge'; id: string; direction: Direction }
  /** 拖群組的標籤：整組照原形狀搬，標籤那一格落在 `at` */
  | { kind: 'shift-group'; groupId: string; at: number }
  | { kind: 'nudge-group'; groupId: string; direction: Direction }
  | { kind: 'columns'; columns: number }
  /** 恢復自動排列（有群組時拒絕） */
  | { kind: 'auto' }
  /** 合併選單「建立群組」：被拖的放到目標右邊一格，兩者成為一個沒名字的群組 */
  | { kind: 'merge-group'; targetId: string; ids: string[] }
  /** 多選的「框成群組」：要相連 */
  | { kind: 'frame'; ids: string[] }
  /** 設定 tag：加入這個資料夾裡同名的群組（沒有就建一個），搬到群組旁邊 */
  | { kind: 'tag'; ids: string[]; name: string }
  | { kind: 'untag'; ids: string[] }
  | { kind: 'group-update'; groupId: string; name?: string; color?: number }
  | { kind: 'dissolve'; groupId: string };

export interface OpContext {
  /** 只有書籤能進群組 */
  isLink: (id: string) => boolean;
  newId: () => string;
}

function clone(board: Board): Board {
  return {
    fixed: board.fixed,
    grid: { columns: board.grid.columns, cells: [...board.grid.cells] },
    groups: board.groups.map((group) => ({ ...group })),
    memberOf: new Map(board.memberOf),
  };
}

export function membersOf(board: Board, groupId: string): Set<string> {
  const out = new Set<string>();
  for (const [id, group] of board.memberOf) {
    if (group === groupId) {
      out.add(id);
    }
  }
  return out;
}

/** 群組的標籤在哪一格：閱讀順序第一個成員。沒有成員回 -1 */
export function labelCell(board: Board, groupId: string): number {
  return board.grid.cells.findIndex((id) => id !== EMPTY && board.memberOf.get(id) === groupId);
}

function requireGroup(board: Board, groupId: string): GroupInfo {
  const group = board.groups.find((item) => item.id === groupId);
  if (group === undefined) {
    throw new Error(t('group_not_found'));
  }
  return group;
}

function groupsOf(board: Board, ids: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    const group = board.memberOf.get(id);
    if (group !== undefined) {
      out.add(group);
    }
  }
  return out;
}

/** 斷成幾塊的群組：只留有標籤（第一個成員）的那一塊 */
function keepLabelBlock(board: Board, groupIds: Iterable<string>): void {
  for (const groupId of groupIds) {
    const blocks = components(board.grid, membersOf(board, groupId));
    for (const block of blocks.slice(1)) {
      for (const cell of block) {
        board.memberOf.delete(board.grid.cells[cell] ?? EMPTY);
      }
    }
  }
}

/**
 * 被拖的卡片放好之後要加入哪個群組：
 * 對準的那張卡片在群組裡、而且就在旁邊 → 那個群組；否則照閱讀順序第一個相鄰的群組；
 * 都沒有 → 不在任何群組。
 */
function joinTarget(board: Board, moved: ReadonlySet<string>, aimed: string | null): string | null {
  const placed = new Set<number>();
  board.grid.cells.forEach((id, index) => {
    if (moved.has(id)) {
      placed.add(index);
    }
  });
  const around = new Set<number>();
  for (const cell of placed) {
    for (const next of neighbors4(board.grid, cell)) {
      if (!placed.has(next)) {
        around.add(next);
      }
    }
  }
  if (aimed !== null && !moved.has(aimed)) {
    const group = board.memberOf.get(aimed);
    if (group !== undefined && around.has(indexOfId(board.grid, aimed))) {
      return group;
    }
  }
  for (const cell of [...around].sort((a, b) => a - b)) {
    const group = board.memberOf.get(board.grid.cells[cell] ?? EMPTY);
    if (group !== undefined) {
      return group;
    }
  }
  return null;
}

/** 位置已經改好之後：被拖的那幾張照相鄰規則加入／離開，原本的群組斷開就只留標籤那塊 */
function regroup(board: Board, ids: readonly string[], aimed: string | null, ctx: OpContext): void {
  const before = groupsOf(board, ids);
  const moved = new Set(ids);
  const target = joinTarget(board, moved, aimed);
  for (const id of ids) {
    if (target !== null && ctx.isLink(id)) {
      board.memberOf.set(id, target);
    } else {
      board.memberOf.delete(id);
    }
  }
  keepLabelBlock(board, before);
}

function newGroup(board: Board, name: string, ctx: OpContext): GroupInfo {
  const group = { id: ctx.newId(), name: name.trim(), color: nextColor(board.groups) };
  board.groups.push(group);
  return group;
}

function requireLinks(ids: readonly string[], ctx: OpContext): void {
  if (!ids.every(ctx.isLink)) {
    throw new Error(t('group_links_only'));
  }
}

/** 設定 tag 時把 `id` 搬到群組旁邊（已經相鄰就不動） */
function moveBeside(board: Board, id: string, members: ReadonlySet<string>): void {
  const grid = board.grid;
  const memberCells = grid.cells.flatMap((cell, index) => (cell !== EMPTY && members.has(cell) ? [index] : []));
  const own = indexOfId(grid, id);
  const around = new Set(memberCells.flatMap((cell) => neighbors4(grid, cell)));
  if (own !== -1 && around.has(own)) {
    return;
  }
  const free = [...around]
    .sort((a, b) => a - b)
    .find((cell) => (grid.cells[cell] ?? EMPTY) === EMPTY);
  if (free !== undefined) {
    const cells = grid.cells.map((cell) => (cell === id ? EMPTY : cell));
    while (cells.length <= free) {
      cells.push(EMPTY);
    }
    cells[free] = id;
    board.grid = { columns: grid.columns, cells: trimEnd(cells) };
    return;
  }
  // 群組四周都滿了：插在最後一個成員的右邊（在列尾就插在它下面），往後擠
  const last = memberCells[memberCells.length - 1] ?? 0;
  const at = stepCell(grid, last, 'right') ?? stepCell(grid, last, 'down') ?? last + 1;
  board.grid = insertPush(grid, [id], at);
}

/**
 * 套用一個操作。純函式：不改 `board`。拒絕的操作丟出帶有給使用者看的訊息的 Error。
 *
 * 結果一定是定下來的（`fixed: true`），除了「恢復自動排列」。沒有成員的群組拿掉。
 */
export function applyOp(input: Board, op: GridOp, ctx: OpContext): Board {
  const board = clone(input);
  board.fixed = true;
  switch (op.kind) {
    case 'place': {
      const ids = op.ids.filter((id) => board.grid.cells.includes(id));
      if (ids.length === 0) {
        break;
      }
      board.grid = insertPush(board.grid, ids, op.at);
      regroup(board, ids, op.aimed, ctx);
      break;
    }
    case 'nudge': {
      const from = indexOfId(board.grid, op.id);
      const to = from === -1 ? null : stepCell(board.grid, from, op.direction);
      if (to === null) {
        break;
      }
      const there = board.grid.cells[to] ?? EMPTY;
      board.grid = swapCells(board.grid, from, to);
      regroup(board, [op.id], there === EMPTY ? null : there, ctx);
      break;
    }
    case 'shift-group':
    case 'nudge-group': {
      requireGroup(board, op.groupId);
      const label = labelCell(board, op.groupId);
      const at = op.kind === 'shift-group' ? op.at : label === -1 ? null : stepCell(board.grid, label, op.direction);
      const moved =
        label === -1 || at === null
          ? null
          : shiftShape(
              board.grid,
              membersOf(board, op.groupId),
              rowOf(board.grid, at) - rowOf(board.grid, label),
              colOf(board.grid, at) - colOf(board.grid, label),
            );
      if (moved === null) {
        throw new Error(t('grid_shape_blocked'));
      }
      board.grid = moved;
      break;
    }
    case 'columns':
      board.grid = setColumns(board.grid, op.columns);
      break;
    case 'auto': {
      if (board.memberOf.size > 0) {
        throw new Error(t('grid_auto_has_groups'));
      }
      board.fixed = false;
      board.grid = fromOrder(readingOrder(board.grid), board.grid.columns);
      break;
    }
    case 'merge-group': {
      const ids = op.ids.filter((id) => id !== op.targetId);
      requireLinks([op.targetId, ...ids], ctx);
      const before = groupsOf(board, [op.targetId, ...ids]);
      const target = indexOfId(board.grid, op.targetId);
      if (target === -1) {
        throw new Error(t('group_not_found'));
      }
      const at = stepCell(board.grid, target, 'right') ?? stepCell(board.grid, target, 'down') ?? target + 1;
      board.grid = insertPush(board.grid, ids, at);
      const group = newGroup(board, '', ctx);
      for (const id of [op.targetId, ...ids]) {
        board.memberOf.set(id, group.id);
      }
      keepLabelBlock(board, before);
      break;
    }
    case 'frame': {
      requireLinks(op.ids, ctx);
      if (components(board.grid, new Set(op.ids)).length !== 1) {
        throw new Error(t('grid_frame_disconnected'));
      }
      const before = groupsOf(board, op.ids);
      const group = newGroup(board, '', ctx);
      for (const id of op.ids) {
        board.memberOf.set(id, group.id);
      }
      keepLabelBlock(board, before);
      break;
    }
    case 'tag': {
      const ids = op.ids.filter(ctx.isLink);
      const name = op.name.trim();
      if (ids.length === 0) {
        break;
      }
      const before = groupsOf(board, ids);
      if (name === '') {
        for (const id of ids) {
          board.memberOf.delete(id);
        }
        keepLabelBlock(board, before);
        break;
      }
      const group = board.groups.find((item) => sameName(item.name, name)) ?? newGroup(board, name, ctx);
      before.delete(group.id);
      const members = membersOf(board, group.id);
      for (const id of ids) {
        members.delete(id);
      }
      for (const id of ids) {
        if (members.size > 0) {
          moveBeside(board, id, members);
        }
        board.memberOf.set(id, group.id);
        members.add(id);
      }
      keepLabelBlock(board, before);
      break;
    }
    case 'untag': {
      const before = groupsOf(board, op.ids);
      for (const id of op.ids) {
        board.memberOf.delete(id);
      }
      keepLabelBlock(board, before);
      break;
    }
    case 'group-update': {
      const group = requireGroup(board, op.groupId);
      if (op.name !== undefined) {
        const name = op.name.trim();
        // 同一個資料夾裡不能有兩個同名群組（名稱就是 tag）
        if (name !== '' && board.groups.some((item) => item.id !== op.groupId && sameName(item.name, name))) {
          throw new Error(t('group_name_taken', name));
        }
        group.name = name;
      }
      if (op.color !== undefined) {
        group.color = op.color;
      }
      break;
    }
    case 'dissolve': {
      requireGroup(board, op.groupId);
      for (const id of membersOf(board, op.groupId)) {
        board.memberOf.delete(id);
      }
      break;
    }
  }
  board.groups = board.groups.filter((group) => [...board.memberOf.values()].includes(group.id));
  return board;
}

/** 一個群組的成員，照閱讀順序 */
export function membersInOrder(board: Board, groupId: string): string[] {
  return readingOrder(board.grid).filter((id) => board.memberOf.get(id) === groupId);
}

/** 標籤所在的格子 → 群組。畫面用來把標籤貼在那一格的左上角 */
export function labels(board: Board): Map<number, GroupInfo> {
  const out = new Map<number, GroupInfo>();
  for (const group of board.groups) {
    const cell = labelCell(board, group.id);
    if (cell !== -1) {
      out.set(cell, group);
    }
  }
  return out;
}

/** 從資料夾裡拿掉一些項目（轉成資料夾、整組搬走之後）：格子留空，成員資格拿掉 */
export function removeItems(input: Board, ids: ReadonlySet<string>): Board {
  const board = clone(input);
  board.grid = {
    columns: board.grid.columns,
    cells: trimEnd(board.grid.cells.map((id) => (ids.has(id) ? EMPTY : id))),
  };
  for (const id of ids) {
    board.memberOf.delete(id);
  }
  board.groups = board.groups.filter((group) => [...board.memberOf.values()].includes(group.id));
  return board;
}

/**
 * 拖標籤時的落點：整組平移之後佔哪幾格、放不放得下（目標要全空或本來就是自己的）。
 * 畫面用它把目標格子亮起來；放不下時游標顯示不能放。
 */
export function shapeTarget(board: Board, groupId: string, at: number): { cells: number[]; ok: boolean } {
  const label = labelCell(board, groupId);
  if (label === -1) {
    return { cells: [], ok: false };
  }
  const dRow = rowOf(board.grid, at) - rowOf(board.grid, label);
  const dCol = colOf(board.grid, at) - colOf(board.grid, label);
  const members = membersOf(board, groupId);
  const cells: number[] = [];
  board.grid.cells.forEach((id, index) => {
    if (id === EMPTY || !members.has(id)) {
      return;
    }
    const row = rowOf(board.grid, index) + dRow;
    const col = colOf(board.grid, index) + dCol;
    if (row >= 0 && col >= 0 && col < board.grid.columns) {
      cells.push(row * board.grid.columns + col);
    }
  });
  return { cells, ok: shiftShape(board.grid, members, dRow, dCol) !== null };
}
