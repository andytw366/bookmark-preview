import type { DragEvent as ReactDragEvent } from 'react';
import type { GroupInfo } from '@/shared/groups';
import { contextMenuHandlers } from '../sidebar/lib/keys';
import { t } from '@/shared/i18n';

interface GroupTagProps {
  group: GroupInfo;
  /** 拖標籤 = 整組照原形狀搬（`useGridDrag` 的 `labelProps`） */
  drag: {
    'data-group-label': string;
    draggable: boolean;
    onDragStart: (event: ReactDragEvent<HTMLElement>) => void;
    onDragEnd: () => void;
  };
  onMenu: (x: number, y: number) => void;
}

/**
 * 群組的名稱標籤：貼在框左上角（第一個成員那一格）的小色塊。
 *
 * 它是一顆按鈕，所以 Tab 得到、Enter 就開 ⋯ 選單；在它上面按 Ctrl+Shift+方向鍵是整組挪一格
 * （由網格的 onKeyDown 認 `data-group-label`）。方向鍵巡覽只走卡片，不停在標籤上。
 */
export function GroupTag({ group, drag, onMenu }: GroupTagProps) {
  const name = group.name === '' ? t('group_untitled') : group.name;
  return (
    <button
      type="button"
      className={`group-tag group-c${String(group.color)}${group.name === '' ? ' group-tag--untitled' : ''}`}
      title={t('group_tag_hint')}
      aria-label={t('group_menu_named', name)}
      aria-haspopup="true"
      {...drag}
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        onMenu(rect.left, rect.bottom + 4);
      }}
      {...contextMenuHandlers(({ x, y }) => {
        onMenu(x, y);
      })}
    >
      {name}
    </button>
  );
}
