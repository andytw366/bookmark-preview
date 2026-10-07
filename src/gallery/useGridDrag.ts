import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { anchorFor, dropIntent, isNoop, type DropTarget } from '../sidebar/lib/drop-intent';

/**
 * 全頁瀏覽網格的拖拽：排序、拖進資料夾、兩張疊在一起合併、拖到麵包屑。
 *
 * 兩個網格（書籤、隱私空間）各掛一份，差別只在 `space` 的回呼與「能不能帶網址」。
 *
 * 幾個不顯眼但必要的決定：
 *
 * - **落點用 id 算，不用 DOM 位置。** 虛擬滾動下看不到的卡片沒有 DOM；`order` 是整個
 *   資料夾的順序，錨點從那裡換算。
 * - **事件掛在網格容器上**（委派），卡片只帶 `data-drag-id`。卡片隨捲動掛上卸下，各自
 *   掛處理器的話剛掛上的那張常常收不到第一個 dragover。
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
  | { id: string; kind: 'before' | 'after' | 'into' }
  | { id: string; kind: 'merge'; armed: boolean }
  | { id: string | null; kind: 'crumb' };

export interface DragSpace {
  /** 這個畫面能不能拖（搜尋結果、Firefox 的永久資料夾那一層都不能） */
  enabled: boolean;
  /** 畫面上這個資料夾的完整順序（含虛擬滾動沒畫出來的） */
  order: readonly string[];
  kindOf: (id: string) => DropTarget | undefined;
  /** 多選中拖已勾選的卡片 = 整批 */
  selected: ReadonlySet<string>;
  /** 書籤卡片拖到分頁列要能打開；隱私空間永遠回 null */
  linkOf: (id: string) => { url: string; title: string } | null;
  onReorder: (ids: string[], beforeId: string | null) => void;
  onInto: (ids: string[], folderId: string | null) => void;
  onMerge: (targetId: string, ids: string[], x: number, y: number) => void;
  /** 開始／結束拖拽。呼叫端要在拖拽期間凍結資料（理由見 Gallery 的 `frozen`） */
  onDragChange: (dragging: boolean) => void;
}

interface DragState {
  ids: string[];
}

export function useGridDrag(space: DragSpace) {
  const dragRef = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hint, setHint] = useState<DropHint | null>(null);
  const dwellRef = useRef<{ id: string; since: number } | null>(null);
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

  const cardProps = (id: string) => ({
    'data-drag-id': id,
    draggable: space.enabled,
    onDragStart: (event: ReactDragEvent<HTMLElement>) => {
      const current = spaceRef.current;
      if (!current.enabled) {
        event.preventDefault();
        return;
      }
      // 拖的是已勾選的其中一張 → 整批，照畫面順序（別的資料夾勾的接在後面）
      const ids = current.selected.has(id)
        ? [
            ...current.order.filter((member) => current.selected.has(member)),
            ...[...current.selected].filter((member) => !current.order.includes(member)),
          ]
        : [id];
      const transfer = event.dataTransfer;
      transfer.clearData();
      transfer.setData(DRAG_TYPE, String(ids.length));
      const links = ids.map(current.linkOf).filter((link) => link !== null);
      const first = links[0];
      if (first !== undefined) {
        transfer.setData('text/x-moz-url', `${first.url}\n${first.title}`);
        transfer.setData('text/uri-list', links.map((link) => link.url).join('\r\n'));
        transfer.effectAllowed = 'all';
      } else {
        transfer.effectAllowed = 'move';
      }
      dragRef.current = { ids };
      setDragging(true);
      current.onDragChange(true);
    },
    onDragEnd: () => {
      finish();
    },
  });

  const targetOf = (event: ReactDragEvent): HTMLElement | null =>
    (event.target as HTMLElement).closest<HTMLElement>('[data-drag-id]');

  const gridProps = {
    onDragOver: (event: ReactDragEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (drag === null || !ours(event)) {
        return;
      }
      const element = targetOf(event);
      const id = element?.dataset.dragId;
      const kind = id === undefined ? undefined : spaceRef.current.kindOf(id);
      if (element === null || id === undefined || kind === undefined || drag.ids.includes(id)) {
        // 卡片之間的空隙、或在自己身上：允許放開（放到空隙 = 放到最後），但不畫提示
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        dwellRef.current = null;
        setHint((current) => (current === null ? current : null));
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const intent = dropIntent(element.getBoundingClientRect(), event.clientX, event.clientY, kind);
      if (intent.kind === 'merge') {
        const now = Date.now();
        if (dwellRef.current?.id !== id) {
          dwellRef.current = { id, since: now };
        }
        const armed = now - dwellRef.current.since >= MERGE_DWELL_MS;
        setHint((current) =>
          current?.kind === 'merge' && current.id === id && current.armed === armed
            ? current
            : { id, kind: 'merge', armed },
        );
        return;
      }
      dwellRef.current = null;
      setHint((current) =>
        current !== null && current.id === id && current.kind === intent.kind
          ? current
          : { id, kind: intent.kind },
      );
    },
    onDrop: (event: ReactDragEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (drag === null || !ours(event)) {
        return;
      }
      event.preventDefault();
      const current = spaceRef.current;
      const shown = hint;
      finish();
      const element = targetOf(event);
      const id = element?.dataset.dragId;
      if (id === undefined || shown === null || shown.kind === 'crumb' || shown.id !== id) {
        // 放在空隙：排到最後。這也是「拖到最後一張後面」最自然的做法
        if (id === undefined && !isNoop(current.order, drag.ids, null)) {
          current.onReorder(drag.ids, null);
        }
        return;
      }
      if (shown.kind === 'into') {
        current.onInto(drag.ids, id);
        return;
      }
      if (shown.kind === 'merge') {
        if (shown.armed) {
          current.onMerge(id, drag.ids, event.clientX, event.clientY);
        }
        return;
      }
      const beforeId = anchorFor(current.order, id, { kind: shown.kind === 'after' ? 'after' : 'before' });
      if (!isNoop(current.order, drag.ids, beforeId)) {
        current.onReorder(drag.ids, beforeId);
      }
    },
    onDragLeave: (event: ReactDragEvent<HTMLElement>) => {
      // 只在離開整個網格時清掉；卡片之間移動也會觸發 dragleave
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
            setHint((current) =>
              current?.kind === 'crumb' && current.id === folderId ? current : { id: folderId, kind: 'crumb' },
            );
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
            spaceRef.current.onInto(drag.ids, folderId);
          },
        };

  /** 卡片要加的 class：插入線、移入的外框、合併的亮框 */
  const dropClass = (id: string): string => {
    if (hint === null || hint.kind === 'crumb' || hint.id !== id) {
      return '';
    }
    if (hint.kind === 'merge') {
      return hint.armed ? ' drop--merge' : '';
    }
    return ` drop--${hint.kind}`;
  };

  const crumbClass = (folderId: string | null): string =>
    hint?.kind === 'crumb' && hint.id === folderId ? ' crumbs__item--drop' : '';

  return { dragging, hint, cardProps, gridProps, crumbProps, dropClass, crumbClass };
}
