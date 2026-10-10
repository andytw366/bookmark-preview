import { useState } from 'react';
import { GROUP_COLORS, type GroupInfo } from '@/shared/groups';
import { ReorderItems, type ReorderActions } from '../sidebar/components/ReorderItems';
import { Button } from '../ui/Button';
import { Menu, MenuHeader, MenuItem, MenuSeparator } from '../ui/Menu';
import { t } from '@/shared/i18n';

/** 6 個群組色的名稱，順序與 `.group-c0`～`.group-c5` 一致（字串鍵要寫死，i18n 測試才掃得到） */
const COLOR_NAMES = [
  t('group_color_0'),
  t('group_color_1'),
  t('group_color_2'),
  t('group_color_3'),
  t('group_color_4'),
  t('group_color_5'),
];

interface GroupMenuProps {
  group: GroupInfo;
  x: number;
  y: number;
  /** `end`：選單右緣對齊 x（從群組標題列右邊的 ⋯ 打開時） */
  align?: 'start' | 'end' | undefined;
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
  align,
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
      <Menu x={x} y={y} align={align} onClose={onClose}>
        <form
          className="menu__form"
          onSubmit={(event) => {
            event.preventDefault();
            onRename(name.trim());
            onClose();
          }}
        >
          <input
            className="input"
            value={name}
            data-autofocus=""
            placeholder={t('group_untitled')}
            aria-label={t('group_name_label')}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <Button type="submit" variant="primary">
            {t('action_save')}
          </Button>
        </form>
      </Menu>
    );
  }

  const run = (work: () => void) => () => {
    work();
    onClose();
  };

  return (
    <Menu x={x} y={y} align={align} role="menu" label={t('group_menu_named', group.name || t('group_untitled'))} onClose={onClose}>
      <MenuItem
        icon="rename"
        label={t('action_rename')}
        onClick={() => {
          setRenaming(true);
        }}
      />
      <MenuSeparator />
      <MenuHeader>{t('group_color')}</MenuHeader>
      <div className="dots" role="group" aria-label={t('group_color')}>
        {Array.from({ length: GROUP_COLORS }, (_, color) => (
          <button
            key={color}
            type="button"
            role="menuitemradio"
            aria-checked={group.color === color}
            aria-label={COLOR_NAMES[color]}
            title={COLOR_NAMES[color]}
            className={`dot group-c${String(color)}${group.color === color ? ' dot--on' : ''}`}
            onClick={run(() => {
              onColor(color);
            })}
          />
        ))}
      </div>
      <MenuSeparator />
      <ReorderItems reorder={reorder} onClose={onClose} />
      <MenuSeparator />
      <MenuItem icon="folder" label={t('group_to_folder')} title={t('group_to_folder_hint')} onClick={run(onToFolder)} />
      <MenuItem icon="dissolve" label={t('group_dissolve')} title={t('group_dissolve_hint')} onClick={run(onDissolve)} />
    </Menu>
  );
}
