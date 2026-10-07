import { useState } from 'react';
import { Popover } from './Popover';
import { t } from '@/shared/i18n';

interface MergeMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  onCreateFolder: (name: string) => void;
  /** 建立（沒名字的）群組。省略就不提供（例如拖的是資料夾） */
  onCreateGroup?: (() => void) | undefined;
}

/**
 * 兩張卡片疊在一起之後的小選單。
 *
 * 「建立群組」在**第一項**而且是預設（使用者拍板的決定，見 NEXT.md），第二項「建立資料夾」。
 * Popover 開啟時焦點落在 `data-autofocus` 那一項，所以 Enter 就是預設、Esc 是取消 ——
 * 這兩件事不用另外寫。
 *
 * 選了「建立資料夾」之後當場問名稱，預設值已經填好：疊卡片是很快的動作，
 * 連按兩次 Enter 就該完成，不該先建一個「未命名」再要人去改名。
 */
export function MergeMenu({ x, y, onClose, onCreateFolder, onCreateGroup }: MergeMenuProps) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState(t('merge_folder_default_name'));

  if (naming) {
    return (
      <Popover x={x} y={y} onClose={onClose}>
        <form
          className="rowmenu__form"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = name.trim();
            onCreateFolder(trimmed === '' ? t('merge_folder_default_name') : trimmed);
            onClose();
          }}
        >
          <input
            className="rowmenu__input"
            value={name}
            data-autofocus=""
            aria-label={t('folder_name_label')}
            onChange={(event) => {
              setName(event.target.value);
            }}
            onFocus={(event) => {
              event.target.select();
            }}
          />
          <button type="submit" className="chip chip--primary">
            {t('action_save')}
          </button>
        </form>
      </Popover>
    );
  }

  return (
    <Popover x={x} y={y} role="menu" onClose={onClose}>
      <p className="rowmenu__heading">{t('merge_heading')}</p>
      {onCreateGroup !== undefined ? (
        <button
          type="button"
          role="menuitem"
          className="rowmenu__item"
          data-autofocus=""
          onClick={() => {
            onCreateGroup();
            onClose();
          }}
        >
          {t('merge_create_group')}
        </button>
      ) : null}
      <button
        type="button"
        role="menuitem"
        className="rowmenu__item"
        {...(onCreateGroup === undefined ? { 'data-autofocus': '' } : {})}
        onClick={() => {
          setNaming(true);
        }}
      >
        {t('merge_create_folder')}
      </button>
    </Popover>
  );
}
