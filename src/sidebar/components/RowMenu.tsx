import { useState } from 'react';
import { request } from '@/shared/messages';
import type { BookmarkNode } from '@/shared/types';
import { FolderPicker } from './FolderPicker';
import { Popover } from './Popover';

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
            aria-label="書籤名稱"
          />
          <button type="submit" className="chip chip--primary">
            儲存
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
          刪除「{node.title || '（未命名）'}」
          {node.kind === 'folder' ? '及其中所有內容' : ''}？
        </p>
        <button
          type="button"
          className="rowmenu__item rowmenu__item--danger"
          onClick={() => {
            run(async () => request('bookmarks/delete', { id: node.id }));
          }}
        >
          確定刪除
        </button>
        {/* 焦點落在「取消」而不是排在前面的「確定刪除」：用鍵盤按下選單裡的
            「刪除」之後，焦點會自動進到這個確認框，若那是確定鈕，連按兩次
            Enter 就刪掉了 —— 不可逆的動作不該只隔一個重複鍵。
            用 data-autofocus 而不是 React 的 autoFocus，理由見 Popover */}
        <button type="button" className="rowmenu__item" data-autofocus="" onClick={onClose}>
          取消
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
            在新分頁開啟
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
            複製網址
          </button>
          <button
            type="button"
            role="menuitem"
            className="rowmenu__item"
            title="刪掉現有預覽圖並重新抓。頁面開著時品質最好（會從已渲染的 DOM 找封面）。"
            onClick={() => {
              const url = node.url;
              onClose();
              onNotice('正在重新抓預覽圖…');
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
            重新抓預覽圖
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
        重新命名
      </button>

      <button
        type="button"
        role="menuitem"
        className="rowmenu__item"
        onClick={() => {
          setChoosingFolder(true);
        }}
      >
        移動到…
      </button>

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
          {node.kind === 'folder' ? '把整個資料夾移入隱私空間' : '移入隱私空間'}
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
        刪除
      </button>
    </Popover>
  );
}
