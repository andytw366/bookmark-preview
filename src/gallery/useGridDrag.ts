import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { dropIntent, type DropTarget } from '../sidebar/lib/drop-intent';

/**
 * 全頁瀏覽網格的拖拽（第 3 期改版：固定格子）。
 *
 * 兩個網格（書籤、隱私空間）各掛一份，差別只在 `space` 的回呼與「能不能帶網址」。
 *
 * | 落在 | 拖卡片 | 拖群組標籤 |
 * |---|---|---|
 * | 空格 | 放進那一格 | 整組平移，標籤落在這一格（目標全空才行） |
 * | 卡片左右邊緣（約 30%） | 插入，後面的往後擠 | 同上 |
 * | 書籤卡片中央（停一下） | 合併選單 | 同上 |
 * | 資料夾卡片中央 | 移進資料夾 | 整組搬進資料夾 |
 * | 麵包屑 | 移到那一層 | 整組搬到那一層 |
 *
 * 幾個不顯眼但必要的決定：
 *
 * - **落點用格子的索引**（`data-cell`），不用 DOM 位置去換算：虛擬滾動下看不到的格子沒有 DOM。
 * - **事件掛在網格容器上**（委派）。卡片隨捲動掛上卸下，各自掛處理器的話剛掛上的那張常常
 *   收不到第一個 dragover。
 * - **游標在格子之間的間隙時維持上一個提示**，放開就照它做：提示一閃一閃地消失，放開時
 *   卻什麼都沒發生，比「照剛剛看到的做」難懂得多。
 * - **隱私卡片不帶任何網址型別。** 連結本來就能拖，`<a href>` 的預設拖拽資料裡有
 *   `text/uri-list` —— 拖到分頁列就會在一般視窗打開、寫進瀏覽記錄。`dragstart` 先
 *   `clearData()` 再只放自訂型別。
 * - **拖的那張卡片可能被卸載**（捲動讓它離開虛擬滾動的範圍），那時 `dragend` 送不到。
 *   視窗層級的 `drop` 與下一次 `pointerdown` 都代表拖拽一定已經結束，用它們把殘留的
 *   狀態收掉。**不能用 `mousemove`**：Firefox 在拖拽進行中照樣送 mousemove（實測），
 *   拖拽一開始狀態就被清掉了。
 */

/** 自訂型別。只認得自己頁面發起的拖拽，從別的分頁拖進來的東西一律不接 */
export const DRAG_TYPE = 'application/x-bookmark-preview';

/** 書籤卡片中央要停多久才算「要合併」——一路滑過去不該每張都亮 */
export const MERGE_DWELL_MS = 400;

/** 離視窗上下緣多近開始自動捲動 */
const SCROLL_EDGE = 70;

export type DropHint =
  | { cell: number; kind: 'before' | 'after' | 'into' | 'slot' }
  | { cell: number; kind: 'merge'; armed: boolean }
  | { cell: number; kind: 'shape'; cells: number[]; ok: boolean }
  | { kind: 'crumb'; folderId: string | null };

export interface DragSpace {
  /** 這個畫面能不能拖（搜尋結果、Firefox 的永久資料夾那一層都不能） */
  enabled: boolean;
  /** 格子：第 i 格是哪個 id（`''` = 空格），含虛擬滾動沒畫出來的 */
  cells: readonly string[];
  kindOf: (id: string) => DropTarget | undefined;
  /** 多選中拖已勾選的卡片 = 整批 */
  selected: ReadonlySet<string>;
  /** 書籤卡片拖到分頁列要能打開；隱私空間永遠回 null */
  linkOf: (id: string) => { url: string; title: string } | null;
  /** 放在第 `at` 格（有卡片就往後擠）。`aimed` 是對準的那張卡片，空格是 null */
  onPlace: (ids: string[], at: number, aimed: string | null) => void;
  /** 移進資料夾或麵包屑的某一層（null = 最上層） */
  onInto: (ids: string[], folderId: string | null) => void;
  onMerge: (targetId: string, ids: string[], x: number, y: number) => void;
  /** 拖標籤：整組平移之後佔哪幾格、放不放得下 */
  shapeAt: (groupId: string, at: number) => { cells: number[]; ok: boolean };
  onShape: (groupId: string, at: number) => void;
  onGroupInto: (groupId: string, folderId: string | null) => void;
  /** 開始／結束拖拽。呼叫端要在拖拽期間凍結資料（理由見 Gallery 的 `frozen`） */
  onDragChange: (dragging: boolean) => void;
}

type DragState = { kind: 'cards'; ids: string[] } | { kind: 'group'; groupId: string };

export function useGridDrag(space: DragSpace) {
  const dragRef = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hint, setHint] = useState<DropHint | null>(null);
  const hintRef = useRef<DropHint | null>(null);
  hintRef.current = hint;
  const dwellRef = useRef<{ cell: number; since: number } | null>(null);
  // 處理器只綁一次的地方要讀到最新的 space
  const spaceRef = useRef(space);
  spaceRef.current = space;

  const finish = (): void => {
    const wasDragging = dragRef.current !== null;
    dragRef.current = null;
    dwellRef.current = null;
    setDragging(false);
    setHint(null);
    if (wasDragging) {
      spaceRef.current.onDragChange(false);
    }
  };

  useEffect(() => {
    if (!dragging) {
      return;
    }
    const onWindowDragOver = (event: DragEvent): void => {
      if (event.clientY < SCROLL_EDGE) {
        window.scrollBy(0, -Math.ceil((SCROLL_EDGE - event.clientY) / 3));
      } else if (event.clientY > window.innerHeight - SCROLL_EDGE) {
        window.scrollBy(0, Math.ceil((event.clientY - (window.innerHeight - SCROLL_EDGE)) / 3));
      }
    };
    const onStale = (): void => {
      finish();
    };
    window.addEventListener('dragover', onWindowDragOver);
    window.addEventListener('drop', onStale);
    window.addEventListener('pointerdown', onStale);
    window.addEventListener('dragend', onStale);
    return () => {
      window.removeEventListener('dragover', onWindowDragOver);
      window.removeEventListener('drop', onStale);
      window.removeEventListener('pointerdown', onStale);
      window.removeEventListener('dragend', onStale);
    };
  }, [dragging]);

  const ours = (event: ReactDragEvent): boolean =>
    dragRef.current !== null && event.dataTransfer.types.includes(DRAG_TYPE);

  const begin = (event: ReactDragEvent<HTMLElement>, state: DragState, links: { url: string; title: string }[]): void => {
    const transfer = event.dataTransfer;
    transfer.clearData();
    transfer.setData(DRAG_TYPE, state.kind);
    const first = links[0];
    if (first !== undefined) {
      transfer.setData('text/x-moz-url', `${first.url}\n${first.title}`);
      transfer.setData('text/uri-list', links.map((link) => link.url).join('\r\n'));
      transfer.effectAllowed = 'all';
    } else {
      transfer.effectAllowed = 'move';
    }
    dragRef.current = state;
    setDragging(true);
    spaceRef.current.onDragChange(true);
  };

  const cardProps = (id: string) => ({
    'data-drag-id': id,
    draggable: space.enabled,
    onDragStart: (event: ReactDragEvent<HTMLElement>) => {
      const current = spaceRef.current;
      if (!current.enabled) {
        event.preventDefault();
        return;
      }
      // 拖的是已勾選的其中一張 → 整批，照閱讀順序（別的資料夾勾的接在後面）
      const here = current.cells.filter((cell) => cell !== '');
      const ids = current.selected.has(id)
        ? [
            ...here.filter((member) => current.selected.has(member)),
            ...[...current.selected].filter((member) => !here.includes(member)),
          ]
        : [id];
      begin(event, { kind: 'cards', ids }, ids.map(current.linkOf).filter((link) => link !== null));
    },
    onDragEnd: () => {
      finish();
    },
  });

  /** 群組的標籤：拖它 = 整組照原形狀搬 */
  const labelProps = (groupId: string) => ({
    'data-group-label': groupId,
    draggable: space.enabled,
    onDragStart: (event: ReactDragEvent<HTMLElement>) => {
      if (!spaceRef.current.enabled) {
        event.preventDefault();
        return;
      }
      event.stopPropagation();
      begin(event, { kind: 'group', groupId }, []);
    },
    onDragEnd: () => {
      finish();
    },
  });

  const setHintIfChanged = (next: DropHint | null): void => {
    setHint((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
  };

  /** 游標所在的格子與那一格的意圖 */
  const intentAt = (event: ReactDragEvent<HTMLElement>, drag: DragState): DropHint | null | 'gap' => {
    const cellElement = (event.target as HTMLElement).closest<HTMLElement>('[data-cell]');
    if (cellElement === null) {
      return 'gap';
    }
    const cell = Number(cellElement.dataset.cell);
    const current = spaceRef.current;
    const id = current.cells[cell] ?? '';
    const kind = id === '' ? undefined : current.kindOf(id);
    const card = cellElement.querySelector<HTMLElement>('[data-drag-id]');
    const intent =
      kind === undefined || card === null
        ? null
        : dropIntent(card.getBoundingClientRect(), event.clientX, event.clientY, kind);

    if (drag.kind === 'group') {
      if (intent?.kind === 'into') {
        return { cell, kind: 'into' };
      }
      const target = current.shapeAt(drag.groupId, cell);
      return { cell, kind: 'shape', cells: target.cells, ok: target.ok };
    }
    if (id === '') {
      return { cell, kind: 'slot' };
    }
    if (drag.ids.includes(id) || intent === null) {
      return null;
    }
    if (intent.kind === 'merge') {
      const now = Date.now();
      if (dwellRef.current?.cell !== cell) {
        dwellRef.current = { cell, since: now };
      }
      return { cell, kind: 'merge', armed: now - dwellRef.current.since >= MERGE_DWELL_MS };
    }
    dwellRef.current = null;
    return { cell, kind: intent.kind };
  };

  const gridProps = {
    onDragOver: (event: ReactDragEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (drag === null || !ours(event)) {
        return;
      }
      const next = intentAt(event, drag);
      event.preventDefault();
      if (next === 'gap') {
        // 格子之間的間隙：維持上一個提示
        event.dataTransfer.dropEffect = hintRef.current === null ? 'none' : 'move';
        return;
      }
      event.dataTransfer.dropEffect = next === null || (next.kind === 'shape' && !next.ok) ? 'none' : 'move';
      if (next?.kind !== 'merge') {
        dwellRef.current = null;
      }
      setHintIfChanged(next);
    },
    onDrop: (event: ReactDragEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (drag === null || !ours(event)) {
        return;
      }
      event.preventDefault();
      const current = spaceRef.current;
      const shown = hintRef.current;
      finish();
      if (shown === null || shown.kind === 'crumb') {
        return;
      }
      const id = current.cells[shown.cell] ?? '';
      if (drag.kind === 'group') {
        if (shown.kind === 'into' && id !== '') {
          current.onGroupInto(drag.groupId, id);
        } else if (shown.kind === 'shape' && shown.ok) {
          current.onShape(drag.groupId, shown.cell);
        }
        return;
      }
      switch (shown.kind) {
        case 'slot':
          if (!(drag.ids.length === 1 && id === drag.ids[0])) {
            current.onPlace(drag.ids, shown.cell, null);
          }
          return;
        case 'before':
          current.onPlace(drag.ids, shown.cell, id);
          return;
        case 'after':
          current.onPlace(drag.ids, shown.cell + 1, id);
          return;
        case 'into':
          current.onInto(drag.ids, id);
          return;
        case 'merge':
          if (shown.armed) {
            current.onMerge(id, drag.ids, event.clientX, event.clientY);
          }
          return;
        case 'shape':
          return;
      }
    },
    onDragLeave: (event: ReactDragEvent<HTMLElement>) => {
      // 只在離開整個網格時清掉；格子之間移動也會觸發 dragleave
      const next = event.relatedTarget as Node | null;
      if (next === null || !event.currentTarget.contains(next)) {
        dwellRef.current = null;
        setHint(null);
      }
    },
  };

  /** 麵包屑的某一段當落點：移到那一層。`folderId` null = 最上層 */
  const crumbProps = (folderId: string | null, allowed: boolean) =>
    !allowed
      ? {}
      : {
          onDragOver: (event: ReactDragEvent<HTMLElement>) => {
            if (!ours(event)) {
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            setHintIfChanged({ kind: 'crumb', folderId });
          },
          onDragLeave: () => {
            setHint((current) => (current?.kind === 'crumb' ? null : current));
          },
          onDrop: (event: ReactDragEvent<HTMLElement>) => {
            const drag = dragRef.current;
            if (drag === null || !ours(event)) {
              return;
            }
            event.preventDefault();
            finish();
            if (drag.kind === 'group') {
              spaceRef.current.onGroupInto(drag.groupId, folderId);
            } else {
              spaceRef.current.onInto(drag.ids, folderId);
            }
          },
        };

  /** 格子要加的 class：插入線、移入的外框、合併的亮框、整組平移的目標 */
  const dropClass = (cell: number): string => {
    if (hint === null || hint.kind === 'crumb') {
      return '';
    }
    if (hint.kind === 'shape') {
      return hint.cells.includes(cell) ? (hint.ok ? ' drop--shape' : ' drop--blocked') : '';
    }
    if (hint.cell !== cell) {
      return '';
    }
    if (hint.kind === 'merge') {
      return hint.armed ? ' drop--merge' : '';
    }
    return ` drop--${hint.kind}`;
  };

  const crumbClass = (folderId: string | null): string =>
    hint?.kind === 'crumb' && hint.folderId === folderId ? ' crumbs__item--drop' : '';

  return { dragging, hint, cardProps, labelProps, gridProps, crumbProps, dropClass, crumbClass };
}
