import type { ReactNode } from 'react';
import { GroupHead } from '../../gallery/GroupTag';
import type { GridDrag } from '../../gallery/useGridDrag';
import type { ListBoard } from '../hooks/useListBoard';

/**
 * 側邊欄清單的一列外面那一層（第 4 期）：拖拽的落點（`data-cell`）、群組的框、
 * 第一個成員上面的標題列（名稱標籤、數量、⋯；點標籤開選單、拖標籤整組搬，與全頁瀏覽同一個元件）。
 *
 * 群組的框由同一組上下相鄰的幾列拼成：每一列畫左右兩邊，第一列加上緣、最後一列加下緣
 * （`lcell--first` / `lcell--last`），底色是群組色的 8%。
 */
export function ListCell({
  id,
  at,
  grouping,
  children,
}: {
  id: string;
  at: number;
  grouping: { board: ListBoard; drag: GridDrag } | undefined;
  children: ReactNode;
}) {
  const row = grouping?.board.rowGroup(id) ?? null;
  const className = [
    'lcell',
    row === null ? '' : `lcell--group group-c${String(row.group.color)}`,
    row?.first === true ? 'lcell--first' : '',
    row?.last === true ? 'lcell--last' : '',
  ]
    .filter((part) => part !== '')
    .join(' ');
  return (
    <div className={`${className}${grouping?.drag.dropClass(at) ?? ''}`} data-cell={at}>
      {row?.first === true && grouping !== undefined ? (
        <GroupHead
          group={row.group}
          count={row.count}
          drag={grouping.drag.labelProps(row.group.id)}
          hint={grouping.board.tagHint}
          menuOpen={grouping.board.menuGroupId === row.group.id}
          onMenu={(x, y, align) => {
            grouping.board.openGroupMenu(row.group, x, y, align);
          }}
        />
      ) : null}
      {children}
    </div>
  );
}
