import { useState } from 'react';
import { request } from '@/shared/messages';
import type { BookmarkNode } from '@/shared/types';
import { folderHash } from '../lib/gallery-history';
import { FolderPicker } from './FolderPicker';
import { Popover } from './Popover';
import { ReorderItems, type ReorderActions } from './ReorderItems';
import { t } from '@/shared/i18n';

export interface MenuTarget {
  node: BookmarkNode;
  x: number;
  y: number;
}

interface RowMenuProps {
  target: MenuTarget;
  /** 隱私空間鎖著時不提供「移入隱私空間」 */
  canMoveToVault: boolean;
  onClose: () => void;
  onOpen: (url: string, newTab: boolean) => void;
  onMoveToVault: (node: BookmarkNode) => void;
  onChanged: () => void;
  onNotice: (message: string) => void;
  /** 全頁瀏覽的「往前移／往後移」。省略就不顯示（側邊欄、搜尋結果、最上層） */
  reorder?: ReorderActions | undefined;
}

/**
 * 書籤列的右鍵選單，補上原生書籤欄該有的操作。
 *
 * 自己畫而不是用 menus API：menus 是掛在瀏覽器層級的，
 * 要對應到「使用者右鍵的是哪一列」得靠額外傳遞狀態，
 * 而且沒辦法做「移動到…」這種需要即時載入資料夾清單的子選單。
 */
export function RowMenu({
  target,
  canMoveToVault,
  onClose,
  onOpen,
  onMoveToVault,
  onChanged,
  onNotice,
  reorder,
}: RowMenuProps) {
  const { node } = target;
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(node.title);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const run = (work: () => Promise<unknown>): void => {
    void work().then(
      () => {
        onChanged();
        onClose();
      },
      () => {
        onClose();
      },
    );
  };

  if (renaming) {
    return (
      <Popover x={target.x} y={target.y} onClose={onClose}>
        <form
          className="rowmenu__form"
          onSubmit={(event) => {
            event.preventDefault();
            const next = title.trim();
            if (next === '' || next === node.title) {
              onClose();
              return;
            }
            run(async () => request('bookmarks/rename', { id: node.id, title: next }));
          }}
        >
          <input
            className="rowmenu__input"
            value={title}
            autoFocus
            data-autofocus=""
            onChange={(event) => {
              setTitle(event.target.value);
            }}
            aria-label={t('bookmark_name_label')}
          />
          <button type="submit" className="chip chip--primary">
            {t('action_save')}
          </button>
        </form>
      </Popover>
    );
  }

  if (choosingFolder) {
    return (
      <FolderPicker
        x={target.x}
        y={target.y}
        disabledId={node.parentId}
        onClose={onClose}
        onPick={(parentId) => {
          run(async () => request('bookmarks/move', { id: node.id, parentId }));
        }}
      />
    );
  }

  if (confirmDelete) {
    return (
      <Popover x={target.x} y={target.y} onClose={onClose}>
        <p className="rowmenu__heading">
          {t('delete_confirm_named', node.title || t('folder_untitled'))}
          {node.kind === 'folder' ? t('delete_confirm_folder_suffix') : ''}
        </p>
        <button
          type="button"
          className="rowmenu__item rowmenu__item--danger"
          onClick={() => {
            run(async () => request('bookmarks/delete', { id: node.id }));
          }}
        >
          {t('action_delete_confirm')}
        </button>
        {/* 焦點落在「取消」而不是排在前面的「確定刪除」：用鍵盤按下選單裡的
            「刪除」之後，焦點會自動進到這個確認框，若那是確定鈕，連按兩次
            Enter 就刪掉了 —— 不可逆的動作不該只隔一個重複鍵。
            用 data-autofocus 而不是 React 的 autoFocus，理由見 Popover */}
        <button type="button" className="rowmenu__item" data-autofocus="" onClick={onClose}>
          {t('action_cancel')}
        </button>
      </Popover>
    );
  }

  return (
    <Popover x={target.x} y={target.y} role="menu" onClose={onClose}>
      {node.kind === 'link' ? (
        <>
          <button
            type="button"
            role="menuitem"
            className="rowmenu__item"
            onClick={() => {
              onOpen(node.url, true);
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
              void navigator.clipboard.writeText(node.url).catch(() => undefined);
              onClose();
            }}
          >
            {t('action_copy_url')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="rowmenu__item"
            title={t('refresh_thumb_hint')}
            onClick={() => {
              const url = node.url;
              onClose();
              onNotice(t('refresh_thumb_running'));
              void request('thumbs/refresh', { url }).then(
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
      ) : (
        // 只有書籤這邊有：隱私資料夾的 id 不能出現在網址上（理由見 gallery-history）
        <button
          type="button"
          role="menuitem"
          className="rowmenu__item"
          onClick={() => {
            void browser.tabs.create({
              url: `${browser.runtime.getURL('gallery/index.html')}${folderHash(node.id)}`,
            });
            onClose();
          }}
        >
          {t('row_open_in_gallery')}
        </button>
      )}

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

      {reorder !== undefined ? <ReorderItems reorder={reorder} onClose={onClose} /> : null}

      {canMoveToVault ? (
        <button
          type="button"
          role="menuitem"
          className="rowmenu__item"
          onClick={() => {
            onMoveToVault(node);
            onClose();
          }}
        >
          {/* 資料夾是整棵子樹一起移入，講清楚才不會以為只搬了資料夾這個殼 */}
          {node.kind === 'folder' ? t('row_import_folder') : t('row_import')}
        </button>
      ) : null}

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
