import type { DragEvent as ReactDragEvent } from 'react';
import type { GroupInfo } from '@/shared/groups';
import { contextMenuHandlers } from '../sidebar/lib/keys';
import { t, tn } from '@/shared/i18n';

interface GroupHeaderProps {
  group: GroupInfo;
  count: number;
  /** 這一列是不是拖拽的落點（亮框） */
  dropClass: string;
  /** 拖標題 = 整組一起搬 */
  drag: {
    'data-drag-id': string;
    draggable: boolean;
    onDragStart: (event: ReactDragEvent<HTMLElement>) => void;
    onDragEnd: () => void;
  };
  onToggle: () => void;
  onMenu: (x: number, y: number) => void;
}

/**
 * 群組的標題列：色條、名稱、數量、收合、⋯ 選單。橫跨整列（`grid-column: 1 / -1`）。
 *
 * 能聚焦的是標題本體（`data-nav`），所以方向鍵跨得過它，Enter 就是收合／展開 ——
 * 它本來就是一顆按鈕，不用另外接鍵盤。
 */
export function GroupHeader({ group, count, dropClass, drag, onToggle, onMenu }: GroupHeaderProps) {
  const name = group.name === '' ? t('group_untitled') : group.name;
  return (
    <div className={`group-head group-c${String(group.color)}${dropClass}`} {...drag}>
      <button
        type="button"
        className="group-head__main"
        data-nav=""
        aria-expanded={!group.collapsed}
        title={group.collapsed ? t('group_expand') : t('group_collapse')}
        onClick={onToggle}
        {...contextMenuHandlers(({ x, y }) => {
          onMenu(x, y);
        })}
      >
        <span className="group-head__chevron" aria-hidden="true">
          {group.collapsed ? '▸' : '▾'}
        </span>
        <span className={`group-head__name${group.name === '' ? ' group-head__name--untitled' : ''}`}>
          {name}
        </span>
        <span className="group-head__count">{tn('unit_bookmarks', count)}</span>
      </button>
      <button
        type="button"
        className="group-head__more"
        title={t('group_menu')}
        aria-label={t('group_menu_named', name)}
        aria-haspopup="true"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          onMenu(rect.right - 200, rect.bottom + 4);
        }}
      >
        ⋯
      </button>
    </div>
  );
}
