import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { rowContaining, type RowSpan } from '@/shared/groups';
import { columnsForWidth, windowFor, type VirtualWindow } from '../lib/virtual';

/** 被虛擬化的項目元素。與 `useListNav` 用同一個標記，兩者看的是同一批東西。 */
const ITEM = '[data-nav]';

export interface VirtualRowsOptions {
  /** 項目總數 */
  count: number;
  /** 一列幾個項目：側邊欄是 1，全頁瀏覽由容器寬度算出來 */
  columns: number;
  /** 還沒量到的列高用什麼估。只影響捲軸長度，不影響已經量到的部分 */
  estimate: number;
  /** 上下各多渲染幾列 */
  overscan?: number;
  /**
   * 換一份清單時要重置量測結果的識別值（資料夾 id、搜尋字串、密度…）。
   *
   * 少了這個，從「純文字」切到「大卡」之後會沿用舊密度量到的列高，
   * 表現成捲軸長度離譜、或捲動時整批位移。
   */
  resetKey?: string;
  /**
   * 裝著項目的容器。
   *
   * 讓呼叫端自己建，是因為欄數要用同一個元素去量（`useGridColumns`），
   * 而那個值又是這個 hook 的輸入 —— 由 hook 自己建 ref 會繞不出來。
   */
  ref?: React.RefObject<HTMLDivElement | null>;
  /**
   * 列長不一時（群組標題自己一列、群組的最後一列沒排滿）每一列從第幾個項目開始、有幾個。
   * 省略就是每 `columns` 個一列。見 `shared/groups.ts` 的 `gridModel`。
   */
  rows?: readonly RowSpan[] | undefined;
}

export interface VirtualRows extends VirtualWindow {
  /** 掛在裝著項目的那個容器上（`.list` / `.grid`） */
  ref: React.RefObject<HTMLDivElement | null>;
  /** 要渲染的項目索引範圍（不含 end） */
  start: number;
  end: number;
  /** 把某個項目捲進畫面，並確保它有被渲染出來 */
  scrollToIndex: (index: number) => void;
}

/**
 * 找出真正會捲動的那個祖先。
 *
 * 側邊欄捲的是 `.body`，全頁瀏覽捲的是整份文件 —— 讓 hook 自己往上找，
 * 就不必把一個 ref 從 App／Gallery 一路傳下來（那種傳遞很容易在新增畫面時漏掉，
 * 而漏掉的表現是「虛擬滾動看起來沒有生效」）。
 */
function scrollParentOf(element: HTMLElement): HTMLElement {
  let node = element.parentElement;
  while (node !== null) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') {
      return node;
    }
    node = node.parentElement;
  }
  return document.scrollingElement instanceof HTMLElement
    ? document.scrollingElement
    : document.documentElement;
}

interface Viewport {
  /** 已經捲過容器內容頂端多少 */
  scrollTop: number;
  height: number;
}

/**
 * 只渲染可視範圍的那幾列。
 *
 * 為什麼需要：3000 個書籤的資料夾在全頁瀏覽下要花約 200～300 毫秒才畫得出來
 * （實測，而且那還是**縮圖都還沒載入**的數字），同時掛載 3000 個縮圖元件。
 * 一併量到的另一半是：3000 次 IndexedDB 讀取一秒內就跑完 —— 瓶頸在渲染，
 * 不在讀取。所以要砍的是「同時存在的 DOM 與元件數量」。
 *
 * 列高是**量出來的**而不是假設固定：大卡模式下封面圖採用自己的長寬比，
 * 每一列本來就不一樣高。沒量到的列用 `estimate`，只影響捲軸長度。
 */
export function useVirtualRows({
  count,
  columns,
  estimate,
  overscan = 4,
  resetKey = '',
  ref: externalRef,
  rows,
}: VirtualRowsOptions): VirtualRows {
  const ownRef = useRef<HTMLDivElement>(null);
  const ref = externalRef ?? ownRef;
  const scrollerRef = useRef<HTMLElement | null>(null);
  /** 量到的列高。key 是列索引 */
  const heights = useRef(new Map<number, number>());
  const [viewport, setViewport] = useState<Viewport>({ scrollTop: 0, height: 0 });
  /** 只是用來在量到新的列高之後觸發重算 */
  const [measureTick, setMeasureTick] = useState(0);

  const cols = Math.max(1, columns);
  const rowCount = rows === undefined ? Math.ceil(count / cols) : rows.length;
  const rowStart = (row: number): number => (rows === undefined ? row * cols : (rows[row]?.start ?? count));
  const rowLength = (row: number): number => (rows === undefined ? cols : (rows[row]?.count ?? 0));

  // 清單換了就把量測結果丟掉 —— 沿用舊的會讓捲軸長度與內容位置對不上
  const lastReset = useRef(resetKey);
  if (lastReset.current !== resetKey) {
    lastReset.current = resetKey;
    heights.current = new Map();
  }

  const heightOf = useCallback(
    (row: number): number => heights.current.get(row) ?? estimate,
    [estimate],
  );

  /**
   * 量目前的捲動位置。
   *
   * 用 `getBoundingClientRect()` 相減而不是 `scrollTop` 減 `offsetTop`：
   * 內容上方有幾層有沒有 padding、有沒有 sticky 的表頭，都不必知道。
   */
  const measureViewport = useCallback(() => {
    const content = ref.current;
    const scroller = scrollerRef.current;
    if (content === null || scroller === null) {
      return;
    }
    const isDocument = scroller === document.scrollingElement || scroller === document.body;
    const viewTop = isDocument ? 0 : scroller.getBoundingClientRect().top;
    const height = isDocument ? window.innerHeight : scroller.clientHeight;
    const scrollTop = viewTop - content.getBoundingClientRect().top;
    setViewport((current) =>
      current.scrollTop === scrollTop && current.height === height
        ? current
        : { scrollTop, height },
    );
  }, []);

  /*
   * 掛上捲動監聽。
   *
   * **每次 render 之後都檢查一次**，而不是只在掛載時做一次：清單容器是條件
   * 渲染的（空清單時畫的是一段文字，根本沒有 `.list`／`.grid`），只在掛載時
   * 找一次的話，那一次 `ref.current` 是 null，之後元素出現了也不會有人再找 ——
   * 表現成「進到某個資料夾之後捲動就失效了」。只有容器換掉時才真的重掛。
   */
  const attached = useRef<{ content: HTMLElement; off: () => void } | null>(null);
  useLayoutEffect(() => {
    const content = ref.current;
    if (attached.current?.content === content) {
      return;
    }
    attached.current?.off();
    attached.current = null;
    if (content === null) {
      scrollerRef.current = null;
      return;
    }
    const scroller = scrollParentOf(content);
    scrollerRef.current = scroller;
    measureViewport();

    // 捲動事件要掛在真正會捲的那個東西上；整份文件捲動時事件是送到 window 的
    const target: EventTarget =
      scroller === document.scrollingElement || scroller === document.body ? window : scroller;
    const onScroll = (): void => {
      measureViewport();
    };
    target.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    attached.current = {
      content,
      off: () => {
        target.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onScroll);
      },
    };
  });

  useEffect(
    () => () => {
      attached.current?.off();
      attached.current = null;
    },
    [],
  );

  const win = windowFor({
    rowCount,
    heightOf,
    scrollTop: viewport.scrollTop,
    viewport: viewport.height,
    overscan,
  });

  /*
   * 量剛剛畫出來的那幾列。
   *
   * 一列的高度是「那一列最高的項目 ＋ 列間距」：網格的列高由最高的格子決定，
   * 而間距沒有被算進任何一個元素的邊界框裡，得另外從樣式讀出來。
   *
   * 用 layout effect 而不是 effect：要在瀏覽器繪製之前就把修正後的墊高寫回去，
   * 不然估錯的那一格會先閃一下才跳到正確位置。
   */
  useLayoutEffect(() => {
    const content = ref.current;
    if (content === null) {
      return;
    }
    const items = [...content.querySelectorAll<HTMLElement>(ITEM)];
    if (items.length === 0) {
      return;
    }
    const gap = Number.parseFloat(getComputedStyle(content).rowGap) || 0;
    let changed = false;
    for (let offset = 0, row = win.firstRow; offset < items.length; offset += rowLength(row), row += 1) {
      const length = Math.max(1, rowLength(row));
      let tallest = 0;
      for (let cell = 0; cell < length && offset + cell < items.length; cell += 1) {
        const item = items[offset + cell];
        if (item !== undefined) {
          tallest = Math.max(tallest, item.getBoundingClientRect().height);
        }
      }
      const height = tallest + gap;
      // 半個像素的差異不值得重畫；量到 0 代表還沒排版，別把它記下來
      if (tallest > 0 && Math.abs((heights.current.get(row) ?? -1) - height) > 0.5) {
        heights.current.set(row, height);
        changed = true;
      }
    }
    if (changed) {
      setMeasureTick((tick) => tick + 1);
    }
  });

  // measureTick 只是用來讓上面的量測結果反映到下一次 windowFor —— 讀一下讓
  // 相依關係明確，否則會看起來像沒有人用它
  void measureTick;

  // 內容或視窗高度變了（切密度、換資料夾、視窗縮放）要重新對一次捲動位置
  useEffect(() => {
    measureViewport();
  }, [measureViewport, count, columns, resetKey]);

  const scrollToIndex = useCallback(
    (index: number) => {
      const content = ref.current;
      const scroller = scrollerRef.current;
      if (content === null || scroller === null) {
        return;
      }
      const row = rows === undefined ? Math.floor(index / cols) : rowContaining(rows, index);
      let offset = 0;
      for (let before = 0; before < row; before += 1) {
        offset += heights.current.get(before) ?? estimate;
      }
      const isDocument = scroller === document.scrollingElement || scroller === document.body;
      const contentTop = content.getBoundingClientRect().top;
      const viewTop = isDocument ? 0 : scroller.getBoundingClientRect().top;
      // 目前這一列相對於視窗上緣的位置，加上去就把它捲到上緣
      scroller.scrollTop += contentTop - viewTop + offset;
      measureViewport();
    },
    [cols, estimate, measureViewport, rows],
  );

  return {
    ...win,
    ref,
    start: rowStart(win.firstRow),
    end: Math.min(count, win.endRow >= rowCount ? count : rowStart(win.endRow)),
    scrollToIndex,
  };
}

/**
 * 網格目前有幾欄，從容器實際寬度算出來。
 *
 * 虛擬滾動要在**決定渲染哪幾列之前**就知道欄數，所以不能沿用
 * `list-nav.ts` 的 `columnsOf()`（那個是從已渲染的元素量的）。
 *
 * 第一次繪製時容器還沒有寬度，會先回 1；量到之後修正。差一格的那一幀
 * 不會被看到 —— layout effect 在瀏覽器繪製之前就跑完了。
 */
export function useGridColumns(
  ref: React.RefObject<HTMLElement | null>,
  min: number,
  gap: number,
): number {
  const [columns, setColumns] = useState(1);
  const observed = useRef<{ element: Element; observer: ResizeObserver } | null>(null);

  /*
   * 理由同上面的捲動監聽：容器是條件渲染的，只在掛載時量一次會量到 null，
   * 而且不會有第二次機會 —— 欄數於是永遠停在 1，畫面上排了四欄卻只渲染一欄的量。
   * （這個 bug 實機上長得像「虛擬滾動只畫得出 5 張卡片」。）
   */
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    setColumns((current) => {
      const next = columnsForWidth(element.clientWidth, min, gap);
      return current === next ? current : next;
    });
    if (observed.current?.element === element) {
      return;
    }
    observed.current?.observer.disconnect();
    const observer = new ResizeObserver(() => {
      setColumns((current) => {
        const next = columnsForWidth(element.clientWidth, min, gap);
        return current === next ? current : next;
      });
    });
    observer.observe(element);
    observed.current = { element, observer };
  });

  useEffect(
    () => () => {
      observed.current?.observer.disconnect();
      observed.current = null;
    },
    [],
  );

  return columns;
}
