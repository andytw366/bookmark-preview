import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { columnsOf, navMove } from '../lib/list-nav';

/** 方向鍵可以聚焦的項目。書籤列與全頁瀏覽的卡片都掛這個屬性。 */
const ITEM = '[data-nav]';

export interface ListNavVirtual {
  /** 目前渲染出來的第一個項目在整份清單裡的索引 */
  start: number;
  /** 整份清單的項目總數 */
  count: number;
  /** 每列幾個。虛擬化時渲染出來的項目可能不足一列，量不出正確欄數 */
  columns: number;
  /** 把某個項目捲進畫面，讓它被渲染出來 */
  scrollToIndex: (index: number) => void;
  /**
   * 固定格子（全頁瀏覽）：項目是 `[data-cell]` 格子裡的卡片，格子可以是空的，方向鍵由
   * `nav` 決定（`shared/grid.ts` 的 `navCell`）。有它時所有索引都是**格子**的索引。
   */
  cells?: { nav: (key: string, at: number) => number | null } | undefined;
}

/** 固定格子裡第 index 格的卡片（空格或還沒渲染出來回 null） */
function cardInCell(container: HTMLElement, index: number): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-cell="${String(index)}"] ${ITEM}`);
}

export interface ListNavActions {
  /** 進入資料夾。id 取自項目上的 `data-folder`，只有資料夾列有這個屬性 */
  onEnterFolder?: ((id: string) => void) | undefined;
  /** 回到上一層。已經在最上層時就不要傳，Backspace 於是不做事 */
  onLeave?: (() => void) | undefined;
  /**
   * 清單有做虛擬滾動時要傳。
   *
   * 少了它，方向鍵會以為「渲染出來的就是全部」——`End` 跳到的是可視範圍的
   * 最後一列而不是清單的最後一列，而往下走到渲染邊界時會直接卡住。
   */
  virtual?: ListNavVirtual | undefined;
}

/**
 * 從焦點所在的元素找出它屬於哪一個項目。
 *
 * 不能只用 `closest`：多選模式下資料夾右側的巡覽箭頭（`.row__enter`）是列的
 * **兄弟**而不是子元素，焦點停在它上面時 `closest` 會找不到任何項目，
 * 於是方向鍵表現成「按了跳回第一列」。往上找到共同的外框再往下取列。
 */
function itemOf(active: Element, container: HTMLElement): HTMLElement | null {
  let node: Element | null = active;
  while (node !== null && node !== container) {
    if (node.matches(ITEM)) {
      return node as HTMLElement;
    }
    const inside = node.querySelector<HTMLElement>(ITEM);
    if (inside !== null) {
      return inside;
    }
    node = node.parentElement;
  }
  return null;
}

/** 換層之後要聚焦第一項；跨出渲染範圍時要聚焦指定的那一項。 */
type PendingFocus = 'first' | number | null;

/**
 * 清單／網格的鍵盤巡覽。
 *
 * 列本身是 `<button>` 或 `<a>`，所以 Tab 與 Enter 本來就通；這個 hook 補的是
 * 「一列一列 Tab 過去太慢」的部分 —— 上下鍵移動、（單欄時）右鍵進資料夾、
 * Backspace 回上一層。側邊欄與全頁瀏覽共用。
 *
 * `containerRef` 可以從外面傳進來，讓虛擬滾動與鍵盤巡覽掛在同一個容器上
 * （一個元素只能有一個 ref）。
 */
export function useListNav(actions: ListNavActions, containerRef?: RefObject<HTMLDivElement | null>) {
  const ownRef = useRef<HTMLDivElement>(null);
  const ref = containerRef ?? ownRef;
  const pending = useRef<PendingFocus>(null);

  /*
   * 巡覽或捲動之後把焦點放到該去的地方。
   *
   * 少了這一段，按右鍵進資料夾時焦點會留在已經被卸載的那一列上（實際落到
   * `<body>`），鍵盤使用者等於被丟出清單，得重新 Tab 一輪才回得來。
   *
   * 沒有依賴陣列是刻意的：要等的是「巡覽造成的那次 render」，而那次 render
   * 由哪個 state 觸發是呼叫端的事。旗標沒立起來時整個函式立刻返回。
   */
  useEffect(() => {
    const target = pending.current;
    if (target === null) {
      return;
    }
    pending.current = null;
    const container = ref.current;
    if (container === null) {
      return;
    }
    if (target === 'first') {
      container.querySelector<HTMLElement>(ITEM)?.focus();
      return;
    }
    if (actions.virtual?.cells !== undefined) {
      cardInCell(container, target)?.focus();
      return;
    }
    const items = container.querySelectorAll<HTMLElement>(ITEM);
    items[target - (actions.virtual?.start ?? 0)]?.focus();
  });

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // 帶修飾鍵的多半是瀏覽器自己的快捷鍵，不要攔
    if (event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) {
      return;
    }
    // 列內若有輸入框（例如重新命名），方向鍵與 Backspace 要留給游標與刪字
    if (active.matches('input, textarea, select')) {
      return;
    }

    const container = event.currentTarget;
    const cells = actions.virtual?.cells;
    if (cells !== undefined && event.key !== 'Backspace') {
      const cell = active.closest<HTMLElement>('[data-cell]');
      const target = cells.nav(event.key, cell === null ? -1 : Number(cell.dataset['cell']));
      if (target === null) {
        return;
      }
      event.preventDefault();
      const element = cardInCell(container, target);
      if (element !== null) {
        element.focus();
        return;
      }
      pending.current = target;
      actions.virtual?.scrollToIndex(target);
      return;
    }

    const items = [...container.querySelectorAll<HTMLElement>(ITEM)];
    const current = itemOf(active, container);
    const local = current === null ? -1 : items.indexOf(current);

    // 虛擬滾動時「渲染出來的」只是整份清單的一段，所有計算都要換算成全域索引
    const base = actions.virtual?.start ?? 0;
    const total = actions.virtual?.count ?? items.length;
    const columns = actions.virtual?.columns ?? columnsOf(items);
    const at = local < 0 ? -1 : base + local;

    const move = navMove(event.key, at, total, columns);
    if (move === null) {
      return;
    }

    if (move.kind === 'focus') {
      event.preventDefault();
      const target = items[move.index - base];
      if (target !== undefined) {
        target.focus();
        return;
      }
      // 目標還沒被渲染出來（跨出可視範圍）：先捲過去，等這次 render 完再聚焦
      pending.current = move.index;
      actions.virtual?.scrollToIndex(move.index);
      return;
    }

    if (move.kind === 'enter') {
      const id = current?.dataset['folder'];
      if (id === undefined || actions.onEnterFolder === undefined) {
        return;
      }
      event.preventDefault();
      pending.current = 'first';
      actions.onEnterFolder(id);
      return;
    }

    if (actions.onLeave === undefined) {
      return;
    }
    event.preventDefault();
    pending.current = 'first';
    actions.onLeave();
  };

  return { ref, onKeyDown };
}
