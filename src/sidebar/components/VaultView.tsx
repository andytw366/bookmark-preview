import { useEffect, useState } from 'react';
import type {
  Density,
  OpenTarget,
  PrivateBookmark,
  PrivateFolder,
  VaultState,
} from '@/shared/types';
import { hostnameOf } from '@/shared/url';
import { vaultChildId, vaultChildren, type VaultLayout } from '@/shared/vault-layout';
import type { GridDrag } from '../../gallery/useGridDrag';
import type { ListBoard } from '../hooks/useListBoard';
import { useListNav } from '../hooks/useListNav';
import { useVirtualRows } from '../hooks/useVirtualRows';
import { contextMenuHandlers } from '../lib/keys';
import { searchVault, vaultPathTo } from '../lib/vault-tree';
import { Breadcrumb } from './Breadcrumb';
import { ListCell } from './ListCell';
import { NewFolderForm } from './NewFolderForm';
import { SearchBar } from './SearchBar';
import { FolderThumb } from './Thumb';
import { VaultThumb } from './VaultThumb';
import { t, tn } from '@/shared/i18n';

/** 資料夾與書籤在畫面上是同一份清單，只是原本分兩段畫 */
type VaultRow =
  | { kind: 'folder'; folder: PrivateFolder }
  | { kind: 'bookmark'; record: PrivateBookmark };

/** 還沒量到的列高用這個估。與 `BookmarkList` 同一組值，兩邊的列是同一套樣式 */
const ESTIMATE: Record<Density, number> = { card: 210, row: 55, text: 28 };

interface VaultViewProps {
  state: Extract<VaultState, { status: 'unlocked' }>;
  bookmarks: PrivateBookmark[];
  folders: PrivateFolder[];
  /** 版面（順序與群組）。搜尋要用它找 `#名稱` */
  layout: VaultLayout;
  density: Density;
  onOpenLink: (url: string, where: OpenTarget) => void;
  onLock: () => void;
  onDestroy: () => void;
  onCreateFolder: (name: string, parentId: string | null) => void;
  onBookmarkMenu: (record: PrivateBookmark, x: number, y: number) => void;
  onFolderMenu: (folder: PrivateFolder, x: number, y: number) => void;
  /** 目前所在的資料夾，由 App 持有 —— 批量動作要知道「全選」的範圍 */
  folderId: string | null;
  onNavigate: (folderId: string | null) => void;
  selecting: boolean;
  selected: ReadonlySet<string>;
  onToggleSelect: (id: string) => void;
  /** 搜尋字。由 App 持有：上鎖時要一起清掉 */
  query: string;
  onQueryChange: (query: string) => void;
  /** 群組與拖拽（第 4 期）。搜尋中不用（順序沒有意義） */
  grouping: { board: ListBoard; drag: GridDrag };
}

export function VaultView({
  state,
  bookmarks,
  folders,
  layout,
  density,
  onOpenLink,
  onLock,
  onDestroy,
  onCreateFolder,
  onBookmarkMenu,
  onFolderMenu,
  folderId,
  onNavigate,
  selecting,
  selected,
  onToggleSelect,
  query,
  onQueryChange,
  grouping,
}: VaultViewProps) {
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const parentId = folders.find((folder) => folder.id === folderId)?.parentId ?? null;

  // 目前所在的資料夾被刪掉時退回最上層，而不是卡在一個空畫面
  useEffect(() => {
    if (folderId !== null && !folders.some((folder) => folder.id === folderId)) {
      onNavigate(null);
    }
  }, [folders, folderId, onNavigate]);

  const childFolders = folders.filter((folder) => folder.parentId === folderId);
  const childBookmarks = bookmarks.filter((record) => record.folderId === folderId);
  const empty = childFolders.length === 0 && childBookmarks.length === 0;
  const searching = query.trim() !== '';

  /*
   * 資料夾與書籤合成一份陣列。
   *
   * 虛擬滾動的單位是「第幾列」，兩段各自 map 的話就沒有一個共同的索引可以切 ——
   * 而且「先資料夾後書籤」本來就是同一份清單的順序，只是原本分兩段畫。
   */
  const rows: VaultRow[] = searching
    ? searchVault(folders, bookmarks, layout, query)
    : (() => {
        // 照版面的順序（群組聚成連續的幾列）；`order` 與這裡用的是同一份 `vaultChildren`
        const byId = new Map(vaultChildren(folders, bookmarks, folderId, layout).map((row) => [vaultChildId(row), row]));
        return grouping.board.order.flatMap((id) => {
          const row = byId.get(id);
          return row === undefined ? [] : [row];
        });
      })();
  const listGrouping = searching ? undefined : grouping;

  /*
   * 每個資料夾直接裝了幾個書籤，一次算完。
   *
   * 原本是每一列各自 `bookmarks.filter(...)`，也就是「資料夾數 × 書籤數」次
   * 比對，而且每次重繪都重算一遍。掃一次建成 Map 之後每一列只是一次查表。
   */
  const countIn = new Map<string, number>();
  for (const record of bookmarks) {
    if (record.folderId !== null) {
      countIn.set(record.folderId, (countIn.get(record.folderId) ?? 0) + 1);
    }
  }

  const virtual = useVirtualRows({
    count: rows.length,
    columns: 1,
    estimate: ESTIMATE[density],
    resetKey: `${searching ? `search:${query}` : (folderId ?? 'root')}/${density}/${String(selecting)}`,
    item: '[data-cell]',
  });
  const nav = useListNav(
    {
      onEnterFolder: onNavigate,
      // 最上層與搜尋結果沒有上一層可回
      onLeave:
        folderId === null || searching
          ? undefined
          : () => {
              onNavigate(parentId);
            },
      virtual: {
        start: virtual.start,
        count: rows.length,
        columns: 1,
        scrollToIndex: virtual.scrollToIndex,
      },
    },
    virtual.ref,
  );

  /*
   * 兩種列各自的畫法。
   *
   * 抽成函式是因為虛擬滾動之後兩者必須在**同一次 map** 裡畫出來（切片的索引
   * 橫跨資料夾與書籤），而把兩段 JSX 直接塞進一個三元運算會難以閱讀。
   */
  const folderRow = (folder: PrivateFolder) => (
    <div
      className={`vault__row row-wrap${selecting ? ' row-wrap--selecting' : ''}${
        selecting && selected.has(folder.id) ? ' row-wrap--selected' : ''
      }`}
      {...listGrouping?.drag.cardProps(folder.id)}
      {...contextMenuHandlers(({ x, y }) => {
        onFolderMenu(folder, x, y);
      })}
    >
      <button
        type="button"
        className={`row row--folder${selecting ? ' row--select' : ''}`}
        data-nav=""
        data-folder={folder.id}
        {...(selecting ? { role: 'checkbox', 'aria-checked': selected.has(folder.id) } : {})}
        onClick={() => {
          if (selecting) {
            onToggleSelect(folder.id);
            return;
          }
          onNavigate(folder.id);
        }}
      >
        <FolderThumb />
        <span className="row__text">
          <span className="row__title">{folder.name || t('folder_untitled_folder')}</span>
          <span className="row__meta">{tn('unit_bookmarks', countIn.get(folder.id) ?? 0)}</span>
        </span>
        {selecting ? null : (
          <span className="row__chevron" aria-hidden="true">
            ›
          </span>
        )}
      </button>
      {selecting ? (
        <>
          <span
            className={`row__check${selected.has(folder.id) ? ' row__check--on' : ''}`}
            aria-hidden="true"
          >
            {selected.has(folder.id) ? '✓' : ''}
          </span>
          <button
            type="button"
            className="row__enter"
            title={t('row_open_folder')}
            aria-label={t('row_open_folder_named', folder.name || t('folder_untitled'))}
            onClick={() => {
              onNavigate(folder.id);
            }}
          >
            ›
          </button>
        </>
      ) : null}
    </div>
  );

  const bookmarkRow = (record: PrivateBookmark) => (
    <div
      className={`vault__row row-wrap${selecting ? ' row-wrap--selecting' : ''}${
        selecting && selected.has(record.id) ? ' row-wrap--selected' : ''
      }`}
      {...listGrouping?.drag.cardProps(record.id)}
      {...contextMenuHandlers(({ x, y }) => {
        onBookmarkMenu(record, x, y);
      })}
    >
      {selecting ? (
        <>
          <button
            type="button"
            className="row row--link row--select"
            data-nav=""
            role="checkbox"
            aria-checked={selected.has(record.id)}
            title={record.url}
            onClick={() => {
              onToggleSelect(record.id);
            }}
          >
            <VaultThumb id={record.id} hostname={hostnameOf(record.url)} />
            <span className="row__text">
              <span className="row__title">{record.title || hostnameOf(record.url)}</span>
              <span className="row__meta">{hostnameOf(record.url)}</span>
            </span>
          </button>
          <span
            className={`row__check${selected.has(record.id) ? ' row__check--on' : ''}`}
            aria-hidden="true"
          >
            {selected.has(record.id) ? '✓' : ''}
          </span>
        </>
      ) : (
        <a
          className="row row--link"
          data-nav=""
          href={record.url}
          title={record.url}
          onClick={(event) => {
            event.preventDefault();
            const newTab = event.ctrlKey || event.metaKey;
            onOpenLink(record.url, newTab ? 'newTabBackground' : 'current');
          }}
        >
          <VaultThumb id={record.id} hostname={hostnameOf(record.url)} />
          <span className="row__text">
            <span className="row__title">{record.title || hostnameOf(record.url)}</span>
            <span className="row__meta">{hostnameOf(record.url)}</span>
          </span>
        </a>
      )}
    </div>
  );

  return (
    <div className="vault">
      <div className="vault__bar">
        <span className="vault__count">{tn('unit_vault_bookmarks', state.bookmarkCount)}</span>
        <button
          type="button"
          className="toolbar__action"
          onClick={() => {
            setCreatingFolder(true);
          }}
        >
          {t('action_new_folder')}
        </button>
        <button type="button" className="toolbar__action" onClick={onLock}>
          {t('vault_lock_now')}
        </button>
      </div>

      <SearchBar value={query} onChange={onQueryChange} placeholder={t('vault_search_placeholder')} />

      {searching ? (
        <p className="head__hint">{tn('search_results', rows.length)}</p>
      ) : (
        <Breadcrumb
          path={vaultPathTo(folders, folderId)}
          onNavigate={onNavigate}
          drop={{ props: (id) => grouping.drag.crumbProps(id, true), className: grouping.drag.crumbClass }}
        />
      )}

      {creatingFolder ? (
        <NewFolderForm
          onCancel={() => {
            setCreatingFolder(false);
          }}
          onCreate={(name) => {
            setCreatingFolder(false);
            onCreateFolder(name, folderId);
          }}
        />
      ) : null}

      {searching && rows.length === 0 ? (
        <p className="empty">{t('search_no_match')}</p>
      ) : !searching && empty ? (
        <p className="empty">
          {folderId === null
            ? t('vault_empty_hint')
            : t('folder_empty')}
        </p>
      ) : (
        <div
          ref={virtual.ref}
          onKeyDown={listGrouping === undefined ? nav.onKeyDown : listGrouping.board.onKeyDown(nav.onKeyDown)}
          {...listGrouping?.drag.gridProps}
          className={`list list--${density}${listGrouping?.drag.dragging === true ? ' list--dragging' : ''}`}
          // 墊高用 padding 而不是墊兩個空 div：`.list` 有 gap，空 div 會多出兩道
          // 間距，讓內容比計算出來的位置多偏移幾個像素
          style={{ paddingTop: virtual.padTop, paddingBottom: virtual.padBottom }}
        >
          {rows.slice(virtual.start, virtual.end).map((row, offset) => {
            const id = vaultChildId(row);
            return (
              <ListCell key={id} id={id} at={virtual.start + offset} grouping={listGrouping}>
                {row.kind === 'folder' ? folderRow(row.folder) : bookmarkRow(row.record)}
              </ListCell>
            );
          })}
        </div>
      )}

      <div className="vault__danger">
        {confirmDestroy ? (
          <div className="notice notice--error">
            <p>
              <strong>{t('vault_destroy_confirm')}</strong>
            </p>
            <p className="notice__body">
              {t('vault_destroy_warning', tn('unit_vault_bookmarks', state.bookmarkCount))}
            </p>
            <div className="vault__actions">
              <button type="button" className="chip chip--danger" onClick={onDestroy}>
                {t('action_delete_confirm')}
              </button>
              <button
                type="button"
                className="chip"
                onClick={() => {
                  setConfirmDestroy(false);
                }}
              >
                {t('action_cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setConfirmDestroy(true);
            }}
          >
            {t('vault_destroy_action')}
          </button>
        )}
      </div>
    </div>
  );
}
