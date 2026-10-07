import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { Board } from '@/shared/board';
import type { Grid } from '@/shared/grid';
import { groupRects, roundedPath, unionOutline, type MemberCell } from '@/shared/outline';

/** 框線離卡片多遠（網格間距 16px 的四分之一：兩個群組相鄰時中間留 8px） */
const PAD = 4;
/** 轉角的圓角半徑 */
const RADIUS = 10;

interface OutlinePath {
  groupId: string;
  color: number;
  d: string;
}

interface GroupOutlinesProps {
  /** 網格容器（`.grid`）；框線畫在它裡面，座標相對於它 */
  gridRef: RefObject<HTMLDivElement | null>;
  board: Board;
  /** 畫面上的擺法（`layoutGrid`），格子元素的 `data-cell` 是它的索引 */
  shown: Grid;
  /** 畫面上每個群組用的顏色（`displayColors`） */
  colors: ReadonlyMap<string, number>;
}

/**
 * 群組的外框：量出畫面上每張成員卡片的位置，每個群組合成一條圓角路徑，用一層 SVG 墊在卡片底下。
 *
 * 只量得到虛擬滾動畫出來的那幾列 —— 群組露出畫面外的部分本來就看不到，那一截的框在 overscan 的範圍外，
 * 不會被看見。卡片的高度會變（封面載入、切卡片大小），所以網格一改變大小就重量一次。
 */
export function GroupOutlines({ gridRef, board, shown, colors }: GroupOutlinesProps) {
  const [paths, setPaths] = useState<OutlinePath[]>([]);
  const [tick, setTick] = useState(0);
  const last = useRef('');

  useEffect(() => {
    const grid = gridRef.current;
    if (grid === null) {
      return;
    }
    const observer = new ResizeObserver(() => {
      setTick((value) => value + 1);
    });
    observer.observe(grid);
    return () => {
      observer.disconnect();
    };
  }, [gridRef]);

  // 每次 render 之後都量（資料、捲動範圍、欄數都可能變）；結果沒變就不 setState，不會一直重畫
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (grid === null) {
      return;
    }
    const base = grid.getBoundingClientRect();
    const byGroup = new Map<string, MemberCell[]>();
    for (const element of grid.querySelectorAll<HTMLElement>('.cell[data-cell]')) {
      const index = Number(element.dataset.cell);
      const group = board.memberOf.get(shown.cells[index] ?? '');
      if (group === undefined) {
        continue;
      }
      const box = element.getBoundingClientRect();
      const list = byGroup.get(group) ?? [];
      list.push({ index, rect: { x: box.left - base.left, y: box.top - base.top, w: box.width, h: box.height } });
      byGroup.set(group, list);
    }
    const next: OutlinePath[] = [];
    for (const [groupId, cells] of byGroup) {
      const d = unionOutline(groupRects(cells, shown.columns, PAD))
        .map((loop) => roundedPath(loop, RADIUS))
        .join('');
      next.push({ groupId, color: colors.get(groupId) ?? 0, d });
    }
    const signature = JSON.stringify(next);
    if (signature !== last.current) {
      last.current = signature;
      setPaths(next);
    }
  });

  void tick;

  return (
    <svg className="group-outlines" aria-hidden="true">
      {paths.map((path) => (
        <path key={path.groupId} className={`group-outline group-c${String(path.color)}`} d={path.d} />
      ))}
    </svg>
  );
}
