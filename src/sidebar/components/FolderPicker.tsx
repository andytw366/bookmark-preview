import { useEffect, useState } from 'react';
import { request, type FolderChoice } from '@/shared/messages';
import { Popover } from './Popover';

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
  heading = '移動到…',
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
    <Popover x={x} y={y} className="rowmenu rowmenu--list" onClose={onClose}>
      <p className="rowmenu__heading">{heading}</p>
      {folders === null ? (
        <p className="rowmenu__note">載入資料夾…</p>
      ) : folders.length === 0 ? (
        <p className="rowmenu__note">沒有可用的資料夾。</p>
      ) : (
        folders.map((folder) => (
          <button
            key={folder.id}
            type="button"
            className="rowmenu__item"
            disabled={folder.id === disabledId}
            onClick={() => {
              onPick(folder.id);
            }}
          >
            {' '.repeat(folder.depth * 2)}
            {folder.title}
          </button>
        ))
      )}
    </Popover>
  );
}
