import type { BookmarkNode, Density, OpenTarget } from '@/shared/types';
import { useListNav } from '../hooks/useListNav';
import { useVirtualRows } from '../hooks/useVirtualRows';
import type { GridDrag } from '../../gallery/useGridDrag';
import type { ListBoard } from '../hooks/useListBoard';
import { BookmarkRow } from './BookmarkRow';
import { ListCell } from './ListCell';

interface BookmarkListProps {
  nodes: BookmarkNode[];
  density: Density;
  emptyMessage: string;
  onOpenFolder: (folderId: string) => void;
  onOpenLink: (url: string, where: OpenTarget) => void;
  onMoveToVault?: ((node: BookmarkNode, x: number, y: number) => void) | undefined;
  onContextMenu: (node: BookmarkNode, x: number, y: number) => void;
  selecting: boolean;
  /** 已勾選的 id（書籤與資料夾）。跨資料夾巡覽時保留，所以由 App 持有 */
  selected: ReadonlySet<string>;
  onToggleSelect: (node: BookmarkNode) => void;
  /** Backspace／左方向鍵回上一層。已經在最上層時不傳，那兩個鍵就不做事 */
  onNavigateUp?: (() => void) | undefined;
  /**
   * 目前這一份清單是什麼（資料夾 id 或搜尋字串）。
   *
   * 換清單時虛擬滾動要把量到的列高丟掉 —— 沿用另一個資料夾的列高會讓捲軸
   * 長度與內容位置對不上。
   */
  listKey: string;
  /**
   * 群組與拖拽（第 4 期）。`nodes` 要已經照版面排好（群組是連續的幾列）。
   * 搜尋結果與 Firefox 的永久資料夾那一層不傳：那裡的順序沒有意義、也不能排。
   */
  grouping?: { board: ListBoard; drag: GridDrag } | undefined;
  /** 右鍵選單正開在哪一列（留外框） */
  activeId?: string | null | undefined;
  /** 搜尋字（符合的部分加底色） */
  highlight?: string | undefined;
  /** 搜尋結果的第二行：這一筆在哪個資料夾。不是搜尋結果就不傳 */
  locationOf?: ((node: BookmarkNode) => string | undefined) | undefined;
}

/**
 * 每一列大概多高（還沒量到的列用這個估）。
 *
 * 只影響捲軸長度與第一次繪製要畫幾列，量到之後就以實際值為準，所以不必精準；
 * 但也不能亂給 —— 估太小會在第一次繪製時畫出遠超過視窗的列數。
 */
const ESTIMATE: Record<Density, number> = { card: 170, row: 52, text: 44 };

export function BookmarkList({
  nodes,
  density,
  emptyMessage,
  onOpenFolder,
  onOpenLink,
  onMoveToVault,
  onContextMenu,
  selecting,
  selected,
  onToggleSelect,
  onNavigateUp,
  listKey,
  grouping,
  activeId,
  highlight,
  locationOf,
}: BookmarkListProps) {
  // hook 不能寫在 early return 後面，所以擺在空清單那個分支之前
  const virtual = useVirtualRows({
    count: nodes.length,
    columns: 1,
    estimate: ESTIMATE[density],
    // 密度也要進來：切了密度之後每一列的高度就變了
    resetKey: `${listKey}/${density}/${String(selecting)}`,
    // 量整個格子：群組第一列上面多一個名稱標籤，只量可聚焦的那一列會少算
    item: '[data-cell]',
  });
  const nav = useListNav(
    {
      onEnterFolder: onOpenFolder,
      onLeave: onNavigateUp,
      virtual: {
        start: virtual.start,
        count: nodes.length,
        columns: 1,
        scrollToIndex: virtual.scrollToIndex,
      },
    },
    virtual.ref,
  );

  if (nodes.length === 0) {
    return <p className="empty">{emptyMessage}</p>;
  }

  return (
    <div
      ref={virtual.ref}
      onKeyDown={grouping === undefined ? nav.onKeyDown : grouping.board.onKeyDown(nav.onKeyDown)}
      {...grouping?.drag.gridProps}
      className={`list list--${density}${grouping?.drag.dragging === true ? ' list--dragging' : ''}`}
      // 用 padding 而不是墊兩個空 div：`.list` 有 gap，空 div 會多出兩道間距，
      // 讓內容比計算的位置多偏移幾個像素
      style={{ paddingTop: virtual.padTop, paddingBottom: virtual.padBottom }}
    >
      {nodes.slice(virtual.start, virtual.end).map((node, offset) => (
        <ListCell key={node.id} id={node.id} at={virtual.start + offset} grouping={grouping}>
          <BookmarkRow
            node={node}
            onOpenFolder={onOpenFolder}
            onOpenLink={onOpenLink}
            onMoveToVault={onMoveToVault}
            onContextMenu={onContextMenu}
            selecting={selecting}
            selected={selected.has(node.id)}
            onToggleSelect={onToggleSelect}
            active={activeId === node.id}
            highlight={highlight}
            location={locationOf?.(node)}
            dragProps={grouping?.drag.cardProps(node.id)}
          />
        </ListCell>
      ))}
    </div>
  );
}
