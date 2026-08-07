import type { MouseEvent } from 'react';
import type { BookmarkLink, BookmarkNode, OpenTarget } from '@/shared/types';
import { hostnameOf } from '@/shared/url';
import { contextMenuHandlers } from '../lib/keys';
import { countLinks } from '../lib/tree';
import { FolderThumb, Thumb } from './Thumb';

interface BookmarkRowProps {
  node: BookmarkNode;
  onOpenFolder: (folderId: string) => void;
  onOpenLink: (url: string, where: OpenTarget) => void;
  /**
   * 未提供時不顯示移入按鈕（例如隱私空間尚未建立）。座標用於把確認提示貼在按鈕旁。
   *
   * 資料夾也吃這個 —— 整棵子樹一起移入，結構在隱私空間裡保留。
   */
  onMoveToVault?: ((node: BookmarkNode, x: number, y: number) => void) | undefined;
  onContextMenu: (node: BookmarkNode, x: number, y: number) => void;
  /**
   * 多選模式。
   *
   * 連結：點整列就是勾選（多選時想開啟的機會很低）。
   * 資料夾：**點整列仍然是巡覽**，只有左上角的勾選框才切換勾選 ——
   * 跨資料夾挑選是這個功能的重點，資料夾一旦不能點進去就沒得挑了。
   */
  selecting: boolean;
  selected: boolean;
  onToggleSelect: (node: BookmarkNode) => void;
}

/** 依修飾鍵決定開啟位置，比照 Firefox 原生書籤的慣例。 */
function targetFromEvent(event: MouseEvent): OpenTarget {
  const wantsNewTab = event.ctrlKey || event.metaKey || event.button === 1;
  if (!wantsNewTab) {
    return 'current';
  }
  return event.shiftKey ? 'newTab' : 'newTabBackground';
}

export function BookmarkRow({
  node,
  onOpenFolder,
  onOpenLink,
  onMoveToVault,
  onContextMenu,
  selecting,
  selected,
  onToggleSelect,
}: BookmarkRowProps) {
  /** 三種列都要有右鍵選單，滑鼠與鍵盤各一個入口 */
  const menuProps = contextMenuHandlers(({ x, y }) => {
    onContextMenu(node, x, y);
  });

  /** 勾選標記：疊在縮圖左上角，純視覺 —— 整列本身就是勾選的觸發區。 */
  const check = (
    <span className={`row__check${selected ? ' row__check--on' : ''}`} aria-hidden="true">
      {selected ? '✓' : ''}
    </span>
  );

  if (node.kind === 'folder') {
    const total = countLinks(node.children);

    if (!selecting) {
      return (
        <div className="row-wrap" {...menuProps}>
          <button
            type="button"
            className="row row--folder"
            data-nav=""
            data-folder={node.id}
            onClick={() => {
              onOpenFolder(node.id);
            }}
          >
            <FolderThumb />
            <span className="row__text">
              <span className="row__title">{node.title || '（未命名資料夾）'}</span>
              <span className="row__meta">{total} 個書籤</span>
            </span>
            {onMoveToVault === undefined ? (
              <span className="row__chevron" aria-hidden="true">
                ›
              </span>
            ) : null}
          </button>
          {/* 有鎖圖示時就不再畫箭頭：兩個都擠在右邊會分不出來點哪個，
              而「點整列進資料夾」本來就成立，箭頭只是提示 */}
          {onMoveToVault === undefined ? null : (
            <button
              type="button"
              className="row__lock"
              title="把整個資料夾移入隱私空間"
              aria-label={`把資料夾「${node.title || '（未命名）'}」移入隱私空間`}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                onMoveToVault(node, rect.left, rect.bottom + 4);
              }}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="5" y="11" width="14" height="9" rx="2" />
                <path d="M8 11V8a4 4 0 0 1 8 0v3" />
              </svg>
            </button>
          )}
        </div>
      );
    }

    // 多選中：點整列是勾選（與書籤一致），巡覽移到右側的箭頭。
    // 箭頭必須是列**外面**的兄弟元素 —— 巢狀 <button> 是無效的 HTML。
    return (
      <div
        className={`row-wrap row-wrap--selecting${selected ? ' row-wrap--selected' : ''}`}
        {...menuProps}
      >
        <button
          type="button"
          className="row row--folder row--select"
          data-nav=""
          data-folder={node.id}
          role="checkbox"
          aria-checked={selected}
          onClick={() => {
            onToggleSelect(node);
          }}
        >
          <FolderThumb />
          <span className="row__text">
            <span className="row__title">{node.title || '（未命名資料夾）'}</span>
            <span className="row__meta">{total} 個書籤</span>
          </span>
        </button>
        {check}
        <button
          type="button"
          className="row__enter"
          title="開啟這個資料夾"
          aria-label={`開啟資料夾「${node.title || '（未命名）'}」`}
          onClick={() => {
            onOpenFolder(node.id);
          }}
        >
          ›
        </button>
      </div>
    );
  }

  const hostname = hostnameOf(node.url);
  const link = node;

  // 多選模式下整列都是勾選的觸發區（連結在多選時想開啟的機會很低）。
  // 維持成 <a> 會讓「點擊等於開啟」與「點擊等於勾選」衝突，所以換成 <button>。
  if (selecting) {
    return (
      <div
        className={`row-wrap row-wrap--selecting${selected ? ' row-wrap--selected' : ''}`}
        {...menuProps}
      >
        <button
          type="button"
          className="row row--link row--select"
          data-nav=""
          title={link.url}
          onClick={() => {
            onToggleSelect(link);
          }}
        >
          <Thumb url={link.url} hostname={hostname} />
          <span className="row__text">
            <span className="row__title">{link.title || hostname}</span>
            <span className="row__meta">{hostname}</span>
          </span>
        </button>
        {check}
      </div>
    );
  }

  return (
    <div className="row-wrap" {...menuProps}>
      <a
        className="row row--link"
        data-nav=""
        href={node.url}
        title={node.url}
        onClick={(event) => {
          event.preventDefault();
          onOpenLink(node.url, targetFromEvent(event));
        }}
        onAuxClick={(event) => {
          if (event.button !== 1) {
            return;
          }
          event.preventDefault();
          onOpenLink(node.url, targetFromEvent(event));
        }}
      >
        <Thumb url={node.url} hostname={hostname} />
        <span className="row__text">
          <span className="row__title">{node.title || hostname}</span>
          <span className="row__meta">{hostname}</span>
        </span>
      </a>
      {onMoveToVault === undefined ? null : (
        <button
          type="button"
          className="row__lock"
          title="移入隱私空間"
          aria-label={`把「${node.title || hostname}」移入隱私空間`}
          onClick={(event) => {
            // 確認提示要貼著這顆按鈕跳出，所以把它的位置一起傳上去
            const rect = event.currentTarget.getBoundingClientRect();
            onMoveToVault(link, rect.left, rect.bottom + 4);
          }}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="5" y="11" width="14" height="9" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
        </button>
      )}
    </div>
  );
}
