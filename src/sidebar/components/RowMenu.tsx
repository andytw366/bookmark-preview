import { useState } from 'react';
import { request } from '@/shared/messages';
import type { BookmarkNode } from '@/shared/types';
import { folderHash } from '../lib/gallery-history';
import { knownDigest } from '../lib/thumb-cache';
import { Button } from '../../ui/Button';
import { Menu, MenuItem, MenuSeparator } from '../../ui/Menu';
import { PreviewModeItem } from './PreviewModeItem';
import { FolderPicker } from './FolderPicker';
import { ReorderItems, type ReorderActions } from './ReorderItems';
import { TagItems, type TagActions } from './TagItems';
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
  /** 全頁瀏覽的群組（＝ tag）項目。省略就不顯示 */
  tag?: TagActions | undefined;
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
  tag,
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
      <Menu x={target.x} y={target.y} onClose={onClose}>
        <form
          className="menu__form"
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
            className="input"
            value={title}
            autoFocus
            data-autofocus=""
            onChange={(event) => {
              setTitle(event.target.value);
            }}
            aria-label={t('bookmark_name_label')}
          />
          <Button type="submit" variant="primary">
            {t('action_save')}
          </Button>
        </form>
      </Menu>
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
      <Menu x={target.x} y={target.y} variant="prompt" onClose={onClose}>
        <p className="menu__title">
          {t('delete_confirm_named', node.title || t('folder_untitled'))}
          {node.kind === 'folder' ? t('delete_confirm_folder_suffix') : ''}
        </p>
        {/* 焦點落在「取消」而不是「確定刪除」：用鍵盤按下選單裡的「刪除」之後，
            焦點會自動進到這個確認框，若那是確定鈕，連按兩次 Enter 就刪掉了 ——
            不可逆的動作不該只隔一個重複鍵。用 data-autofocus 而不是 React 的
            autoFocus，理由見 Popover */}
        <div className="menu__actions">
          <Button variant="ghost" data-autofocus="" onClick={onClose}>
            {t('action_cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              run(async () => request('bookmarks/delete', { id: node.id }));
            }}
          >
            {t('action_delete_confirm')}
          </Button>
        </div>
      </Menu>
    );
  }

  return (
    <Menu x={target.x} y={target.y} role="menu" onClose={onClose}>
      {node.kind === 'link' ? (
        <>
          <MenuItem
            icon="open-new"
            label={t('action_open_in_new_tab')}
            onClick={() => {
              onOpen(node.url, true);
              onClose();
            }}
          />
          <MenuItem
            icon="copy"
            label={t('action_copy_url')}
            onClick={() => {
              void navigator.clipboard.writeText(node.url).catch(() => undefined);
              onClose();
            }}
          />
          <MenuSeparator />
          <MenuItem
            icon="refresh"
            label={t('action_refresh_thumb')}
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
          />
          <PreviewModeItem
            thumbKey={knownDigest(node.url)}
            send={async (mode) => request('thumbs/set-mode', { url: node.url, mode })}
            onClose={onClose}
            onNotice={onNotice}
          />
        </>
      ) : (
        // 只有書籤這邊有：隱私資料夾的 id 不能出現在網址上（理由見 gallery-history）
        <MenuItem
          icon="gallery"
          label={t('row_open_in_gallery')}
          onClick={() => {
            void browser.tabs.create({
              url: `${browser.runtime.getURL('gallery/index.html')}${folderHash(node.id)}`,
            });
            onClose();
          }}
        />
      )}

      <MenuSeparator />
      <MenuItem
        icon="rename"
        label={t('action_rename')}
        onClick={() => {
          setRenaming(true);
        }}
      />
      <MenuItem
        icon="folder-move"
        label={t('action_move_to')}
        onClick={() => {
          setChoosingFolder(true);
        }}
      />
      {reorder !== undefined ? <ReorderItems reorder={reorder} onClose={onClose} /> : null}
      {tag !== undefined ? (
        <TagItems tag={tag} x={target.x} y={target.y} isFolder={node.kind === 'folder'} onClose={onClose} />
      ) : null}

      {canMoveToVault ? (
        <>
          <MenuSeparator />
          {/* 資料夾是整棵子樹一起移入，講清楚才不會以為只搬了資料夾這個殼 */}
          <MenuItem
            icon="move-in"
            label={node.kind === 'folder' ? t('row_import_folder') : t('row_import')}
            onClick={() => {
              onMoveToVault(node);
              onClose();
            }}
          />
        </>
      ) : null}

      <MenuSeparator />
      <MenuItem
        icon="trash"
        label={t('action_delete')}
        danger
        onClick={() => {
          setConfirmDelete(true);
        }}
      />
    </Menu>
  );
}
