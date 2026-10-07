import type { ReactNode } from 'react';
import { GroupTag } from '../../gallery/GroupTag';
import type { GridDrag } from '../../gallery/useGridDrag';
import type { ListBoard } from '../hooks/useListBoard';

/**
 * 側邊欄清單的一列外面那一層（第 4 期）：拖拽的落點（`data-cell`）、群組的左側色條、
 * 第一個成員上面的名稱標籤（點它開選單、拖它整組搬，與全頁瀏覽的標籤是同一個元件）。
 *
 * 色條畫在這一層的左邊，同一組上下相鄰的列接成一條（`lcell--first` / `lcell--last` 決定圓角）。
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
        <GroupTag
          group={row.group}
          drag={grouping.drag.labelProps(row.group.id)}
          hint={grouping.board.tagHint}
          onMenu={(x, y) => {
            grouping.board.openGroupMenu(row.group, x, y);
          }}
        />
      ) : null}
      {children}
    </div>
  );
}
