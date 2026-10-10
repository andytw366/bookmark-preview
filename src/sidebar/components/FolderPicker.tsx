import { useEffect, useState } from 'react';
import { request, type FolderChoice } from '@/shared/messages';
import { Menu, MenuHeader, MenuItem, MenuNote } from '../../ui/Menu';
import { t } from '@/shared/i18n';

interface FolderPickerProps {
  x: number;
  y: number;
  heading?: string;
  /** 停用的目標（例如書籤目前所在的資料夾，搬過去等於沒動） */
  disabledId?: string | null;
  onPick: (parentId: string) => void;
  onClose: () => void;
}

/**
 * 選一個原生書籤資料夾。
 *
 * 抽成共用元件是因為有兩處要用：單筆的「移動到…」與多選的批量搬移。
 * 資料夾清單自己去背景頁取 —— 呼叫端只需要知道使用者選了哪一個。
 */
export function FolderPicker({
  x,
  y,
  heading = t('action_move_to'),
  disabledId = null,
  onPick,
  onClose,
}: FolderPickerProps) {
  const [folders, setFolders] = useState<FolderChoice[] | null>(null);

  useEffect(() => {
    void request('bookmarks/folders', undefined).then(setFolders, () => {
      setFolders([]);
    });
  }, []);

  return (
    <Menu x={x} y={y} variant="list" onClose={onClose}>
      <MenuHeader>{heading}</MenuHeader>
      {folders === null ? (
        <MenuNote>{t('folders_loading')}</MenuNote>
      ) : folders.length === 0 ? (
        <MenuNote>{t('folders_none')}</MenuNote>
      ) : (
        folders.map((folder) => (
          <MenuItem
            key={folder.id}
            icon="folder"
            label={`${'\u2003'.repeat(folder.depth)}${folder.title}`}
            title={folder.title}
            disabled={folder.id === disabledId}
            onClick={() => {
              onPick(folder.id);
            }}
          />
        ))
      )}
    </Menu>
  );
}
