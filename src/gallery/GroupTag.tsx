import type { DragEvent as ReactDragEvent } from 'react';
import type { GroupInfo } from '@/shared/groups';
import { contextMenuHandlers } from '../sidebar/lib/keys';
import { IconButton } from '../ui/Button';
import { t, tn } from '@/shared/i18n';

interface GroupTagProps {
  group: GroupInfo;
  /** 拖標籤 = 整組照原形狀搬（`useGridDrag` 的 `labelProps`） */
  drag: {
    'data-group-label': string;
    draggable: boolean;
    onDragStart: (event: ReactDragEvent<HTMLElement>) => void;
    onDragEnd: () => void;
  };
  /** `align: 'end'` = 從右邊的 ⋯ 打開，選單右緣對齊 x */
  onMenu: (x: number, y: number, align?: 'start' | 'end') => void;
  /** 滑鼠停留的提示。搜尋結果裡點標籤是跳到資料夾，要換一句 */
  hint?: string | undefined;
}

/**
 * 群組的名稱標籤：貼在框左上角（第一個成員那一格）的小色塊。沒名字的群組只有色塊、沒有字。
 *
 * 它是一顆按鈕，所以 Tab 得到、Enter 就開 ⋯ 選單；在它上面按 Ctrl+Shift+方向鍵是整組挪一格
 * （由網格的 onKeyDown 認 `data-group-label`）。方向鍵巡覽只走卡片，不停在標籤上。
 */
export function GroupTag({ group, drag, onMenu, hint }: GroupTagProps) {
  const name = group.name === '' ? t('group_untitled') : group.name;
  return (
    <button
      type="button"
      className={`group-tag group-c${String(group.color)}${group.name === '' ? ' group-tag--untitled' : ''}`}
      title={hint ?? t('group_tag_hint')}
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
      {/* 沒名字的群組只是一個小色塊：「未命名群組」幾個字對使用者沒有資訊 */}
      {group.name === '' ? null : <span className="group-tag__name">{group.name}</span>}
    </button>
  );
}

/**
 * 群組的標題列（側邊欄、全頁瀏覽同一個樣子）：名稱標籤、成員數、⋯。
 *
 * ⋯ 是標籤之外的第二個選單入口，滑鼠移到群組上、或焦點進到群組裡才出現（CSS）；
 * 標籤本身已經能點開選單，⋯ 只是讓「這裡有選項」看得出來。
 */
export function GroupHead({
  group,
  count,
  drag,
  onMenu,
  hint,
  menuOpen = false,
}: GroupTagProps & { count: number; menuOpen?: boolean }) {
  const name = group.name === '' ? t('group_untitled') : group.name;
  return (
    <div className={`group-head group-c${String(group.color)}`}>
      <GroupTag group={group} drag={drag} onMenu={onMenu} hint={hint} />
      <span className="group-head__count">{tn('group_count', count)}</span>
      <IconButton
        icon="more"
        className="group-head__more"
        label={t('group_menu_named', name)}
        aria-haspopup="true"
        aria-expanded={menuOpen}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          onMenu(rect.right, rect.bottom + 4, 'end');
        }}
      />
    </div>
  );
}
