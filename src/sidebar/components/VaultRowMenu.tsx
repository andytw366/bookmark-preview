import { useState } from 'react';
import { request } from '@/shared/messages';
import type { PrivateBookmark, PrivateFolder } from '@/shared/types';
import { Popover } from './Popover';
import { t } from '@/shared/i18n';

export type VaultMenuTarget =
  | { kind: 'bookmark'; record: PrivateBookmark; x: number; y: number }
  | { kind: 'folder'; folder: PrivateFolder; x: number; y: number };

interface VaultRowMenuProps {
  target: VaultMenuTarget;
  folders: PrivateFolder[];
  onClose: () => void;
  onOpen: (url: string, newTab: boolean) => void;
  onMoveOut: (id: string) => void;
  /** 移出並自己挑落點；不用這個時走設定裡的預設資料夾 */
  onExportTo: (id: string, x: number, y: number) => void;
  onRemove: (id: string) => void;
  onMoveToFolder: (id: string, folderId: string | null) => void;
  /** 搬移資料夾本身。不能與 `onMoveToFolder` 共用：那條路送的是搬書籤的訊息 */
  onMoveFolder: (id: string, parentId: string | null) => void;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  /** 重新命名書籤成功後要重讀清單 */
  onChanged: () => void;
  onNotice: (message: string) => void;
}

interface FolderChoice {
  id: string;
  name: string;
  depth: number;
}

/**
 * 攤平成有縮排深度的清單，供「移動到…」顯示。
 *
 * `excludeSubtreeOf` 是搬資料夾時用的：**自己的子孫不能當目標**，否則就是環狀
 * parentId。背景頁擋得下來，但讓使用者選一個必定失敗的目標本來就沒有意義 ——
 * 而且那條錯誤訊息還會讓人以為是別的問題。
 */
function flatten(
  folders: PrivateFolder[],
  parentId: string | null,
  depth: number,
  excludeSubtreeOf: string | null = null,
): FolderChoice[] {
  const out: FolderChoice[] = [];
  for (const folder of folders.filter((item) => item.parentId === parentId)) {
    if (folder.id === excludeSubtreeOf) {
      continue;
    }
    out.push({ id: folder.id, name: folder.name, depth });
    // 深度上限防資料損毀造成的環狀 parentId 讓遞迴爆掉
    if (depth < 16) {
      out.push(...flatten(folders, folder.id, depth + 1, excludeSubtreeOf));
    }
  }
  return out;
}

/**
 * 隱私空間裡的右鍵選單，書籤與資料夾共用一個元件（以 target.kind 分流）。
 *
 * 為什麼不直接用 `RowMenu`：隱私書籤**不在 Firefox 的書籤樹裡**，
 * 所以那邊的每一個操作（`bookmarks/rename`、`bookmarks/move`、
 * `bookmarks/delete`）都不適用 —— 它們認的是原生書籤 ID。這裡的每一項
 * 都得走 vault 專屬訊息，由背景頁在解鎖狀態下改動加密資料。
 */
export function VaultRowMenu({
  target,
  folders,
  onClose,
  onOpen,
  onMoveOut,
  onExportTo,
  onRemove,
  onMoveToFolder,
  onMoveFolder,
  onRenameFolder,
  onDeleteFolder,
  onChanged,
  onNotice,
}: VaultRowMenuProps) {
  const initialName = target.kind === 'bookmark' ? target.record.title : target.folder.name;
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(initialName);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (renaming) {
    return (
      <Popover x={target.x} y={target.y} onClose={onClose}>
        <form
          className="rowmenu__form"
          onSubmit={(event) => {
            event.preventDefault();
            const next = name.trim();
            if (next === '' || next === initialName) {
              onClose();
              return;
            }
            if (target.kind === 'folder') {
              onRenameFolder(target.folder.id, next);
              onClose();
              return;
            }
            void request('vault/rename', { id: target.record.id, title: next }).then(
              () => {
                onChanged();
                onClose();
              },
              (cause: unknown) => {
                onNotice(cause instanceof Error ? cause.message : String(cause));
                onClose();
              },
            );
          }}
        >
          <input
            className="rowmenu__input"
            value={name}
            autoFocus
            data-autofocus=""
            onChange={(event) => {
              setName(event.target.value);
            }}
            aria-label={target.kind === 'folder' ? t('folder_name_label_edit') : t('vault_bookmark_name_label')}
          />
          <button type="submit" className="chip chip--primary">
            {t('action_save')}
          </button>
        </form>
      </Popover>
    );
  }

  if (choosingFolder) {
    const movingFolder = target.kind === 'folder';
    const current = movingFolder ? target.folder.parentId : target.record.folderId;
    const movingId = movingFolder ? target.folder.id : target.record.id;
    // 搬資料夾與搬書籤是兩條不同的訊息（不同的 id 空間、不同的規則）
    const move = (destination: string | null): void => {
      if (movingFolder) {
        onMoveFolder(movingId, destination);
      } else {
        onMoveToFolder(movingId, destination);
      }
      onClose();
    };
    // 搬資料夾時把自己整棵子樹拿掉；自己那一項在下面也一併排除了
    const choices = flatten(folders, null, 0, movingFolder ? movingId : null);
    return (
      <Popover x={target.x} y={target.y} className="rowmenu rowmenu--list" onClose={onClose}>
        <p className="rowmenu__heading">{t('action_move_to')}</p>
        <button
          type="button"
          className="rowmenu__item"
          disabled={current === null}
          onClick={() => {
            move(null);
          }}
        >
          {t('folder_top_level')}
        </button>
        {choices.map((choice) => (
          <button
            key={choice.id}
            type="button"
            className="rowmenu__item"
            disabled={choice.id === current}
            onClick={() => {
              move(choice.id);
            }}
          >
            {' '.repeat(choice.depth * 2)}
            {choice.name || t('folder_untitled')}
          </button>
        ))}
      </Popover>
    );
  }

  if (confirmDelete) {
    const isFolder = target.kind === 'folder';
    return (
      <Popover x={target.x} y={target.y} onClose={onClose}>
        <p className="rowmenu__heading">{t('delete_confirm_named', initialName || t('folder_untitled'))}</p>
        <p className="rowmenu__note">
          {isFolder
            ? t('vault_delete_folder_note')
            : t('vault_delete_bookmark_note')}
        </p>
        <button
          type="button"
          className="rowmenu__item rowmenu__item--danger"
          onClick={() => {
            if (target.kind === 'folder') {
              onDeleteFolder(target.folder.id);
            } else {
              onRemove(target.record.id);
            }
            onClose();
          }}
        >
          {t('action_delete_confirm')}
        </button>
        {/* 焦點給「取消」，理由同 RowMenu：連按兩次 Enter 不該就刪掉東西 */}
        <button type="button" className="rowmenu__item" data-autofocus="" onClick={onClose}>
          {t('action_cancel')}
        </button>
      </Popover>
    );
  }

  return (
    <Popover x={target.x} y={target.y} role="menu" onClose={onClose}>
      {target.kind === 'bookmark' ? (
        <>
          <button
            type="button"
            role="menuitem"
            className="rowmenu__item"
            onClick={() => {
              onOpen(target.record.url, true);
              onClose();
            }}
          >
            {t('action_open_in_new_tab')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="rowmenu__item"
            onClick={() => {
              void navigator.clipboard.writeText(target.record.url).catch(() => undefined);
              onClose();
            }}
          >
            {t('action_copy_url')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="rowmenu__item"
            title={t('vault_refresh_thumb_hint')}
            onClick={() => {
              const id = target.record.id;
              onClose();
              onNotice(t('refresh_thumb_running'));
              void request('vault/refresh-thumb', { id }).then(
                (report) => {
                  onNotice(report.detail);
                },
                (cause: unknown) => {
                  onNotice(cause instanceof Error ? cause.message : String(cause));
                },
              );
            }}
          >
            {t('action_refresh_thumb')}
          </button>
        </>
      ) : null}

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

      {/* 資料夾也能搬 —— 多選已經可以勾它了，單筆選單沒有反而不一致 */}
      <button
        type="button"
        role="menuitem"
        className="rowmenu__item"
        onClick={() => {
          setChoosingFolder(true);
        }}
      >
        {t('action_move_to')}
      </button>

      {/* 資料夾與書籤都能移出：資料夾會連同子樹在原生書籤裡重建，與移入對稱 */}
      <button
        type="button"
        role="menuitem"
        className="rowmenu__item"
        title={
          target.kind === 'folder'
            ? t('vault_export_folder_hint')
            : t('vault_export_hint')
        }
        onClick={() => {
          onMoveOut(target.kind === 'folder' ? target.folder.id : target.record.id);
          onClose();
        }}
      >
        {target.kind === 'folder' ? t('vault_export_folder') : t('vault_export')}
      </button>
      <button
        type="button"
        role="menuitem"
        className="rowmenu__item"
        title={t('vault_export_to_hint')}
        onClick={() => {
          onExportTo(target.kind === 'folder' ? target.folder.id : target.record.id, target.x, target.y);
          onClose();
        }}
      >
        {t('vault_export_to')}
      </button>

      <button
        type="button"
        role="menuitem"
        className="rowmenu__item rowmenu__item--danger"
        onClick={() => {
          setConfirmDelete(true);
        }}
      >
        {t('action_delete')}
      </button>
    </Popover>
  );
}
