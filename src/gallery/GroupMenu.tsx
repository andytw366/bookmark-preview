import { useState } from 'react';
import { GROUP_COLORS, type GroupInfo } from '@/shared/groups';
import { Popover } from '../sidebar/components/Popover';
import { ReorderItems, type ReorderActions } from '../sidebar/components/ReorderItems';
import { t } from '@/shared/i18n';

interface GroupMenuProps {
  group: GroupInfo;
  x: number;
  y: number;
  reorder: ReorderActions;
  onClose: () => void;
  onRename: (name: string) => void;
  onColor: (color: number) => void;
  onDissolve: () => void;
  onToFolder: () => void;
}

/**
 * 群組標籤的選單（點標籤、或在標籤上按 Enter／右鍵）。兩個空間共用，差別只在呼叫端送哪一種訊息。
 *
 * 「解散」不需要確認：成員留在原地，只是不再聚成一組，隨時可以再建回來。
 * 「轉成資料夾」也不需要：它是把群組換成一個子資料夾，內容一個都沒少。
 */
export function GroupMenu({
  group,
  x,
  y,
  reorder,
  onClose,
  onRename,
  onColor,
  onDissolve,
  onToFolder,
}: GroupMenuProps) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(group.name);

  if (renaming) {
    return (
      <Popover x={x} y={y} onClose={onClose}>
        <form
          className="rowmenu__form"
          onSubmit={(event) => {
            event.preventDefault();
            onRename(name.trim());
            onClose();
          }}
        >
          <input
            className="rowmenu__input"
            value={name}
            data-autofocus=""
            placeholder={t('group_untitled')}
            aria-label={t('group_name_label')}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <button type="submit" className="chip chip--primary">
            {t('action_save')}
          </button>
        </form>
      </Popover>
    );
  }

  const run = (work: () => void) => () => {
    work();
    onClose();
  };

  return (
    <Popover x={x} y={y} role="menu" onClose={onClose}>
      <button
        type="button"
        role="menuitem"
        className="rowmenu__item"
        onClick={() => {
          setRenaming(true);
        }}
      >
        {t('action_rename')}
      </button>
      <div className="group-menu__colors" role="group" aria-label={t('group_color')}>
        {Array.from({ length: GROUP_COLORS }, (_, color) => (
          <button
            key={color}
            type="button"
            role="menuitemradio"
            aria-checked={group.color === color}
            aria-label={t('group_color_n', String(color + 1))}
            className={`group-menu__swatch group-c${String(color)}${group.color === color ? ' group-menu__swatch--on' : ''}`}
            onClick={run(() => {
              onColor(color);
            })}
          />
        ))}
      </div>
      <ReorderItems reorder={reorder} onClose={onClose} />
      <button
        type="button"
        role="menuitem"
        className="rowmenu__item"
        title={t('group_to_folder_hint')}
        onClick={run(onToFolder)}
      >
        {t('group_to_folder')}
      </button>
      <button
        type="button"
        role="menuitem"
        className="rowmenu__item"
        title={t('group_dissolve_hint')}
        onClick={run(onDissolve)}
      >
        {t('group_dissolve')}
      </button>
    </Popover>
  );
}
