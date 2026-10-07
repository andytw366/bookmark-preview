import {
  afterRemoval,
  fromOrder,
  indexOfId,
  normalize,
  placeAuto,
  setColumns,
  stepCell,
  type Direction,
  type Grid,
} from './grid';
import { nextColor, sameName, type GroupInfo } from './groups';
import { t } from './i18n';

/**
 * 一個資料夾的「版面」：緊密排列的格子 + 這個資料夾的群組 + 誰在哪個群組。
 *
 * 書籤與隱私空間各自把自己的資料轉成 `Board`（`buildBoard`）、套用同一套操作
 * （`applyOp`）、再各自寫回去。規則只寫在這一份裡，兩個空間的行為才會一模一樣。
 *
 * 使用者拍板的規則（2026-10-07，看過「固定格子＋不規則形狀」之後改的）：
 *
 * - 卡片緊密排列、不留空格；拖進來後面的讓位，拿走後面的往前補。
 * - **群組是閱讀順序上連續的一段**，框起來是階梯形。移動群組時整段搬、其他卡片自動讓位。
 * - **放進框線範圍內才加入**：放下時對準的是某個群組的成員（插在它前後、或疊在它中央）就加入那個群組；
 *   放在群組旁邊、框外都不加入。成員被拖到框外 = 離開。
 * - 不是成員的東西（散卡片、資料夾、別的群組）不能插進一個群組中間：落點會被推到那個群組的頭或尾
 *   （離哪邊近就哪邊），群組永遠是連續的一段。
 * - 只有書籤能進群組（資料夾不行）。
 */

export interface Board {
  /** false = 欄數跟著視窗（自動排列）。只有改欄數會定下來，「恢復自動排列」會放開 */
  fixed: boolean;
  grid: Grid;
  /** 這個資料夾的群組。沒有成員的會在操作後消失 */
  groups: GroupInfo[];
  /** 項目 id → 群組 id。只含這個資料夾裡、群組還在的 */
  memberOf: Map<string, string>;
}

export interface BoardInput {
  /** 存下來的順序與欄數；null = 還沒有（照 `children`） */
  stored: Grid | null;
  /** 存下來的欄數是不是使用者定的（false = 跟著視窗，`autoColumns`） */
  fixed: boolean;
  /** 這個資料夾現在的內容，照預設順序（原生書籤的順序；隱私空間的 `order`／預設排序） */
  children: readonly string[];
  /** 自動排列時的欄數（畫面寬度算出來的） */
  autoColumns: number;
  groups: readonly GroupInfo[];
  groupOf: (id: string) => string | null;
}

/** 每個群組的成員聚成連續的一段，放在第一個成員的位置（資料被別處弄亂時也照樣是一段） */
function gather(cells: readonly string[], memberOf: ReadonlyMap<string, string>): string[] {
  const byGroup = new Map<string, string[]>();
  for (const id of cells) {
    const group = memberOf.get(id);
    if (group !== undefined) {
      byGroup.set(group, [...(byGroup.get(group) ?? []), id]);
    }
  }
  const out: string[] = [];
  const done = new Set<string>();
  for (const id of cells) {
    const group = memberOf.get(id);
    if (group === undefined) {
      out.push(id);
    } else if (!done.has(group)) {
      done.add(group);
      out.push(...(byGroup.get(group) ?? []));
    }
  }
  return out;
}

export function buildBoard(input: BoardInput): Board {
  const live = new Set(input.children);
  const fixed = input.fixed && input.stored !== null;
  const base =
    input.stored === null
      ? fromOrder(input.children, input.autoColumns)
      : placeAuto(normalize(input.stored, live), input.children);
  const grid = fixed ? base : setColumns(base, input.autoColumns);
  const known = new Set(input.groups.map((group) => group.id));
  const memberOf = new Map<string, string>();
  for (const id of grid.cells) {
    const groupId = input.groupOf(id);
    if (groupId !== null && known.has(groupId)) {
      memberOf.set(id, groupId);
    }
  }
  return {
    fixed,
    grid: { columns: grid.columns, cells: gather(grid.cells, memberOf) },
    groups: input.groups.map((group) => ({ ...group })),
    memberOf,
  };
}

export type GridOp =
  /** 拖拽放開：插在第 `at` 個位置（拿掉被拖的之前的索引）。`aimed` 是放下時對準的那張卡片（最後的空位是 null） */
  | { kind: 'place'; ids: string[]; at: number; aimed: string | null }
  /** 鍵盤一次挪一格（與那一格的卡片換位，照「放進框線範圍內才加入」改成員資格） */
  | { kind: 'nudge'; id: string; direction: Direction }
  /** 拖群組的標籤：整段搬到第 `at` 個位置（拿掉成員之前的索引），其他卡片讓位 */
  | { kind: 'move-group'; groupId: string; at: number }
  | { kind: 'nudge-group'; groupId: string; direction: Direction }
  /** 固定欄數 */
  | { kind: 'columns'; columns: number }
  /** 恢復自動排列（欄數跟著視窗） */
  | { kind: 'auto' }
  /** 合併選單「建立群組」：被拖的接在目標後面，兩者成為一個沒名字的群組 */
  | { kind: 'merge-group'; targetId: string; ids: string[] }
  /** 多選的「框成群組」：勾的聚到第一張的位置成為一個群組 */
  | { kind: 'frame'; ids: string[] }
  /** 設定 tag：加入這個資料夾裡同名的群組（沒有就建一個），接在群組最後 */
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

/** 一個群組的成員，照閱讀順序 */
export function membersInOrder(board: Board, groupId: string): string[] {
  return board.grid.cells.filter((id) => board.memberOf.get(id) === groupId);
}

/** 群組的標籤在哪一格：第一個成員。沒有成員回 -1 */
export function labelCell(board: Board, groupId: string): number {
  return board.grid.cells.findIndex((id) => board.memberOf.get(id) === groupId);
}

/** `cells` 裡某個群組那一段的頭尾（含）；沒有回 null */
function runIn(cells: readonly string[], memberOf: ReadonlyMap<string, string>, groupId: string): [number, number] | null {
  const start = cells.findIndex((id) => memberOf.get(id) === groupId);
  if (start === -1) {
    return null;
  }
  let end = start;
  while (end + 1 < cells.length && memberOf.get(cells[end + 1] ?? '') === groupId) {
    end += 1;
  }
  return [start, end];
}

/** 落點在某個群組（`except` 以外）中間時，推到那一段的頭或尾（離哪邊近就哪邊） */
function snap(cells: readonly string[], memberOf: ReadonlyMap<string, string>, pos: number, except: string | null): number {
  const group = memberOf.get(cells[pos] ?? '');
  const previous = memberOf.get(cells[pos - 1] ?? '');
  if (group === undefined || group !== previous || group === except) {
    return pos;
  }
  const run = runIn(cells, memberOf, group);
  if (run === null) {
    return pos;
  }
  const [start, end] = run;
  return pos - start <= end + 1 - pos ? start : end + 1;
}

function insert(cells: readonly string[], ids: readonly string[], pos: number): string[] {
  const index = Math.min(Math.max(0, pos), cells.length);
  return [...cells.slice(0, index), ...ids, ...cells.slice(index)];
}

function requireGroup(board: Board, groupId: string): GroupInfo {
  const group = board.groups.find((item) => item.id === groupId);
  if (group === undefined) {
    throw new Error(t('group_not_found'));
  }
  return group;
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

/**
 * 放下：對準的是某個群組的成員就插在那裡並加入（資料夾不能加入，會被 `gather` 擠到那一段後面），
 * 否則插在落點（在別的群組中間就推到頭或尾）並離開原本的群組。
 */
function place(board: Board, ids: readonly string[], at: number, aimed: string | null, ctx: OpContext): void {
  const moving = new Set(ids);
  const target = aimed === null || moving.has(aimed) ? null : (board.memberOf.get(aimed) ?? null);
  const rest = board.grid.cells.filter((id) => !moving.has(id));
  let pos = afterRemoval(board.grid, moving, at);
  for (const id of ids) {
    board.memberOf.delete(id);
  }
  if (target === null) {
    pos = snap(rest, board.memberOf, pos, null);
  } else {
    for (const id of ids) {
      if (ctx.isLink(id)) {
        board.memberOf.set(id, target);
      }
    }
  }
  board.grid = { columns: board.grid.columns, cells: insert(rest, ids, pos) };
}

/**
 * 套用一個操作。純函式：不改 `board`。拒絕的操作丟出帶有給使用者看的訊息的 Error。
 * 結果裡每個群組都是連續的一段，沒有成員的群組拿掉。
 */
export function applyOp(input: Board, op: GridOp, ctx: OpContext): Board {
  const board = clone(input);
  const cells = board.grid.cells;
  switch (op.kind) {
    case 'place': {
      const ids = op.ids.filter((id) => cells.includes(id));
      if (ids.length > 0) {
        place(board, ids, op.at, op.aimed, ctx);
      }
      break;
    }
    case 'nudge': {
      const from = indexOfId(board.grid, op.id);
      const to = from === -1 ? null : stepCell(board.grid, from, op.direction);
      if (to !== null) {
        place(board, [op.id], to > from ? to + 1 : to, cells[to] ?? null, ctx);
      }
      break;
    }
    case 'move-group':
    case 'nudge-group': {
      requireGroup(board, op.groupId);
      const run = runIn(cells, board.memberOf, op.groupId);
      if (run === null) {
        break;
      }
      const [start, end] = run;
      const members = cells.slice(start, end + 1);
      const moving = new Set(members);
      const rest = cells.filter((id) => !moving.has(id));
      const runOf = (id: string | undefined): [number, number] | null => {
        const group = id === undefined ? undefined : board.memberOf.get(id);
        return group === undefined ? null : runIn(rest, board.memberOf, group);
      };
      let pos: number | null;
      if (op.kind === 'move-group') {
        pos = afterRemoval(board.grid, moving, op.at);
      } else if (op.direction === 'left') {
        // 往前跨一格；前面是另一個群組就跨過那整段
        pos = start === 0 ? null : (runOf(cells[start - 1])?.[0] ?? start - 1);
      } else if (op.direction === 'right') {
        pos = end + 1 >= cells.length ? null : ((runOf(cells[end + 1])?.[1] ?? start) + 1);
      } else {
        const step = op.direction === 'up' ? -board.grid.columns : board.grid.columns;
        pos = Math.min(Math.max(0, start + step), rest.length);
      }
      if (pos !== null) {
        pos = snap(rest, board.memberOf, pos, op.groupId);
        board.grid = { columns: board.grid.columns, cells: insert(rest, members, pos) };
      }
      break;
    }
    case 'columns':
      board.fixed = true;
      board.grid = setColumns(board.grid, op.columns);
      break;
    case 'auto':
      board.fixed = false;
      break;
    case 'merge-group': {
      const ids = op.ids.filter((id) => id !== op.targetId && cells.includes(id));
      requireLinks([op.targetId, ...ids], ctx);
      if (!cells.includes(op.targetId)) {
        throw new Error(t('group_not_found'));
      }
      const moving = new Set(ids);
      for (const id of [op.targetId, ...ids]) {
        board.memberOf.delete(id);
      }
      const rest = cells.filter((id) => !moving.has(id));
      board.grid = { columns: board.grid.columns, cells: insert(rest, ids, rest.indexOf(op.targetId) + 1) };
      const group = newGroup(board, '', ctx);
      for (const id of [op.targetId, ...ids]) {
        board.memberOf.set(id, group.id);
      }
      break;
    }
    case 'frame': {
      const ids = cells.filter((id) => op.ids.includes(id));
      requireLinks(ids, ctx);
      if (ids.length === 0) {
        break;
      }
      const moving = new Set(ids);
      for (const id of ids) {
        board.memberOf.delete(id);
      }
      const rest = cells.filter((id) => !moving.has(id));
      const pos = snap(rest, board.memberOf, afterRemoval(board.grid, moving, cells.indexOf(ids[0] ?? '')), null);
      board.grid = { columns: board.grid.columns, cells: insert(rest, ids, pos) };
      const group = newGroup(board, '', ctx);
      for (const id of ids) {
        board.memberOf.set(id, group.id);
      }
      break;
    }
    case 'tag': {
      const ids = cells.filter((id) => op.ids.includes(id) && ctx.isLink(id));
      const name = op.name.trim();
      if (ids.length === 0) {
        break;
      }
      for (const id of ids) {
        board.memberOf.delete(id);
      }
      if (name === '') {
        break;
      }
      const group = board.groups.find((item) => sameName(item.name, name)) ?? newGroup(board, name, ctx);
      const moving = new Set(ids);
      const rest = cells.filter((id) => !moving.has(id));
      const run = runIn(rest, board.memberOf, group.id);
      // 已有成員：接在那一段最後；新的群組：聚到第一張的位置
      const pos =
        run === null
          ? snap(rest, board.memberOf, afterRemoval(board.grid, moving, cells.indexOf(ids[0] ?? '')), null)
          : run[1] + 1;
      board.grid = { columns: board.grid.columns, cells: insert(rest, ids, pos) };
      for (const id of ids) {
        board.memberOf.set(id, group.id);
      }
      break;
    }
    case 'untag':
      // 在那一段中間的會被 `gather` 擠到那一段後面（留在框裡的話看起來還像是成員）
      for (const id of op.ids) {
        board.memberOf.delete(id);
      }
      break;
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
  return settle(board);
}

/** 每個群組聚成一段、沒有成員的群組拿掉 */
function settle(board: Board): Board {
  board.grid = { columns: board.grid.columns, cells: gather(board.grid.cells, board.memberOf) };
  const used = new Set(board.memberOf.values());
  board.groups = board.groups.filter((group) => used.has(group.id));
  return board;
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

/** 從資料夾裡拿掉一些項目（轉成資料夾、整組搬走之後）：後面的往前補，成員資格拿掉 */
export function removeItems(input: Board, ids: ReadonlySet<string>): Board {
  const board = clone(input);
  board.grid = { columns: board.grid.columns, cells: board.grid.cells.filter((id) => !ids.has(id)) };
  for (const id of ids) {
    board.memberOf.delete(id);
  }
  return settle(board);
}

/** 某一格換成另一個 id（新資料夾佔被疊上去那張卡片、或群組第一個成員的位置） */
export function replaceItem(input: Board, oldId: string, newId: string): Board {
  const board = clone(input);
  board.grid = { columns: board.grid.columns, cells: board.grid.cells.map((id) => (id === oldId ? newId : id)) };
  board.memberOf.delete(oldId);
  return settle(board);
}

/**
 * 把 `ids` 照順序放在第 `at` 個位置（拿掉它們之前的索引；省略 = 最後），成為 `group` 的成員
 * （null = 不在群組裡）。整組搬進資料夾、攤平成群組用：那時它們已經被自動排在最後面了。
 */
export function insertItems(input: Board, ids: readonly string[], group: GroupInfo | null, at?: number): Board {
  const board = clone(input);
  const moving = new Set(ids);
  const rest = board.grid.cells.filter((id) => !moving.has(id));
  for (const id of ids) {
    board.memberOf.delete(id);
  }
  const pos = at === undefined ? rest.length : snap(rest, board.memberOf, afterRemoval(board.grid, moving, at), null);
  board.grid = { columns: board.grid.columns, cells: insert(rest, ids, pos) };
  if (group !== null) {
    if (!board.groups.some((item) => item.id === group.id)) {
      board.groups.push({ ...group });
    }
    for (const id of ids) {
      board.memberOf.set(id, group.id);
    }
  }
  return settle(board);
}
