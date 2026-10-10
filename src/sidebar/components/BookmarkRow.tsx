import type { MouseEvent } from 'react';
import type { BookmarkNode, OpenTarget } from '@/shared/types';
import { hostnameOf } from '@/shared/url';
import { IconButton } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { CheckMark } from '../../ui/Toggles';
import { contextMenuHandlers } from '../lib/keys';
import { countLinks } from '../lib/tree';
import { Highlight } from './Highlight';
import { FolderThumb, Thumb } from './Thumb';
import { t, tn } from '@/shared/i18n';

interface BookmarkRowProps {
  node: BookmarkNode;
  onOpenFolder: (folderId: string) => void;
  onOpenLink: (url: string, where: OpenTarget) => void;
  /**
   * 未提供時不顯示移入按鈕（隱私空間鎖著、或還沒建立）。座標用於把確認提示貼在按鈕旁。
   *
   * 資料夾也吃這個 —— 整棵子樹一起移入，結構在隱私空間裡保留。
   */
  onMoveToVault?: ((node: BookmarkNode, x: number, y: number) => void) | undefined;
  onContextMenu: (node: BookmarkNode, x: number, y: number) => void;
  /**
   * 多選模式。
   *
   * 連結：點整列就是勾選（多選時想開啟的機會很低）。
   * 資料夾：點整列也是勾選，巡覽移到右邊的箭頭 —— 跨資料夾挑選是這個功能的重點，
   * 資料夾一旦不能點進去就沒得挑了。
   */
  selecting: boolean;
  selected: boolean;
  onToggleSelect: (node: BookmarkNode) => void;
  /** 右鍵選單正開在這一列：留著外框，看得出選單作用在哪一筆 */
  active?: boolean | undefined;
  /** 搜尋字：符合的部分加底色 */
  highlight?: string | undefined;
  /** 搜尋結果的第二行補上所在資料夾 */
  location?: string | undefined;
  /** 拖拽（`useGridDrag` 的 `cardProps`），掛在整列外層。不能拖的畫面不傳 */
  dragProps?: object | undefined;
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
  active = false,
  highlight,
  location,
  dragProps,
}: BookmarkRowProps) {
  /** 三種列都要有右鍵選單，滑鼠與鍵盤各一個入口 */
  const menuProps = contextMenuHandlers(({ x, y }) => {
    onContextMenu(node, x, y);
  });
  const wrapClass = [
    'row-wrap',
    selecting ? 'row-wrap--selecting' : '',
    selecting && selected ? 'row-wrap--selected' : '',
    active ? 'row-wrap--ctx' : '',
  ]
    .filter(Boolean)
    .join(' ');

  if (node.kind === 'folder') {
    const total = countLinks(node.children);
    const name = node.title || t('folder_untitled_folder');
    const text = (
      <>
        <FolderThumb />
        <span className="row__text">
          <span className="row__title">
            <Highlight text={name} query={highlight} />
          </span>
          <span className="row__meta">{location ?? tn('unit_bookmarks', total)}</span>
        </span>
      </>
    );

    if (!selecting) {
      return (
        <div className={wrapClass} {...dragProps} {...menuProps}>
          <button
            type="button"
            className="row row--folder"
            data-nav=""
            data-folder={node.id}
            onClick={() => {
              onOpenFolder(node.id);
            }}
          >
            {text}
            {onMoveToVault === undefined ? <Icon name="chevron" className="row__chevron" /> : null}
          </button>
          {/* 有移入鈕時就不再畫箭頭：兩個都擠在右邊會分不出來點哪個，
              而「點整列進資料夾」本來就成立，箭頭只是提示 */}
          {onMoveToVault === undefined ? null : (
            <IconButton
              icon="move-in"
              className="row__lock"
              label={t('row_import_folder_named', node.title || t('folder_untitled'))}
              hint={t('row_import_folder')}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                onMoveToVault(node, rect.left, rect.bottom + 4);
              }}
            />
          )}
        </div>
      );
    }

    // 多選中：點整列是勾選（與書籤一致），巡覽移到右側的箭頭。
    // 箭頭必須是列**外面**的兄弟元素 —— 巢狀 <button> 是無效的 HTML。
    return (
      <div className={wrapClass} {...dragProps} {...menuProps}>
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
          <CheckMark state={selected} />
          {text}
        </button>
        <IconButton
          icon="chevron"
          className="row__enter"
          label={t('row_open_folder_named', node.title || t('folder_untitled'))}
          hint={t('row_open_folder')}
          onClick={() => {
            onOpenFolder(node.id);
          }}
        />
      </div>
    );
  }

  const hostname = hostnameOf(node.url);
  const link = node;
  const body = (
    <>
      <Thumb url={link.url} hostname={hostname} />
      <span className="row__text">
        <span className="row__title">
          <Highlight text={link.title || hostname} query={highlight} />
        </span>
        <span className="row__meta">{location === undefined ? hostname : `${hostname} · ${location}`}</span>
      </span>
    </>
  );

  // 多選模式下整列都是勾選的觸發區（連結在多選時想開啟的機會很低）。
  // 維持成 <a> 會讓「點擊等於開啟」與「點擊等於勾選」衝突，所以換成 <button>。
  if (selecting) {
    return (
      <div className={wrapClass} {...dragProps} {...menuProps}>
        <button
          type="button"
          className="row row--link row--select"
          data-nav=""
          role="checkbox"
          aria-checked={selected}
          title={link.url}
          onClick={() => {
            onToggleSelect(link);
          }}
        >
          <CheckMark state={selected} />
          {body}
        </button>
      </div>
    );
  }

  return (
    <div className={wrapClass} {...dragProps} {...menuProps}>
      <a
        className="row row--link"
        data-nav=""
        href={link.url}
        title={link.url}
        onClick={(event) => {
          event.preventDefault();
          onOpenLink(link.url, targetFromEvent(event));
        }}
        onAuxClick={(event) => {
          if (event.button !== 1) {
            return;
          }
          event.preventDefault();
          onOpenLink(link.url, targetFromEvent(event));
        }}
      >
        {body}
      </a>
      {onMoveToVault === undefined ? null : (
        <IconButton
          icon="move-in"
          className="row__lock"
          label={t('row_import_named', link.title || hostname)}
          hint={t('row_import')}
          onClick={(event) => {
            // 確認提示要貼著這顆按鈕跳出，所以把它的位置一起傳上去
            const rect = event.currentTarget.getBoundingClientRect();
            onMoveToVault(link, rect.left, rect.bottom + 4);
          }}
        />
      )}
    </div>
  );
}
