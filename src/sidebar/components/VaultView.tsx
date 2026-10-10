import { useEffect, useState, type ReactNode } from 'react';
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
import { IconButton } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { CheckMark } from '../../ui/Toggles';
import { Breadcrumb, UpButton } from './Breadcrumb';
import { Highlight } from './Highlight';
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
const ESTIMATE: Record<Density, number> = { card: 170, row: 52, text: 44 };

interface VaultViewProps {
  state: Extract<VaultState, { status: 'unlocked' }>;
  bookmarks: PrivateBookmark[];
  folders: PrivateFolder[];
  /** 版面（順序與群組）。搜尋要用它找 `#名稱` */
  layout: VaultLayout;
  density: Density;
  onOpenLink: (url: string, where: OpenTarget) => void;
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
  /**
   * 群組與拖拽（第 4 期）。一般的搜尋結果不傳（順序沒有意義）；`#名稱` 的搜尋結果傳一份不能拖、
   * 只畫出群組的（App 用同一份 `searchVault` 建）。
   */
  grouping?: { board: ListBoard; drag: GridDrag } | undefined;
  /** 右鍵選單正開在哪一列（留外框） */
  activeId?: string | null | undefined;
  /** 多選時清單頂端的「全選」（App 算好範圍） */
  selectAll?: ReactNode;
  /** 補抓完的「查看缺的」：只列出這些隱私書籤（跨資料夾、不能排） */
  onlyIds?: ReadonlySet<string> | undefined;
  onClearOnly?: (() => void) | undefined;
}

export function VaultView({
  state,
  bookmarks,
  folders,
  layout,
  density,
  onOpenLink,
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
  activeId,
  selectAll,
  onlyIds,
  onClearOnly,
}: VaultViewProps) {
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
  const filtered = onlyIds !== undefined && !searching;
  const listed: VaultRow[] = searching
    ? searchVault(folders, bookmarks, layout, query)
    : filtered
      ? bookmarks.filter((record) => onlyIds.has(record.id)).map((record) => ({ kind: 'bookmark' as const, record }))
      : vaultChildren(folders, bookmarks, folderId, layout);
  // 有版面時照版面的順序（群組聚成連續的幾列）；App 建版面用的是同一份清單
  const byId = new Map(listed.map((row) => [vaultChildId(row), row]));
  const rows: VaultRow[] =
    grouping === undefined
      ? listed
      : grouping.board.order.flatMap((id) => {
          const row = byId.get(id);
          return row === undefined ? [] : [row];
        });
  const listGrouping = grouping;

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
    resetKey: `${searching ? `search:${query}` : filtered ? 'missing' : (folderId ?? 'root')}/${density}/${String(selecting)}`,
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
  const wrapClass = (id: string): string =>
    [
      'row-wrap',
      selecting ? 'row-wrap--selecting' : '',
      selecting && selected.has(id) ? 'row-wrap--selected' : '',
      activeId === id ? 'row-wrap--ctx' : '',
    ]
      .filter(Boolean)
      .join(' ');

  const folderRow = (folder: PrivateFolder) => {
    const count = countIn.get(folder.id) ?? 0;
    return (
      <div
        className={wrapClass(folder.id)}
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
          {selecting ? <CheckMark state={selected.has(folder.id)} /> : null}
          <FolderThumb />
          <span className="row__text">
            <span className="row__title">
              <Highlight text={folder.name || t('folder_untitled_folder')} query={searching ? query : undefined} />
            </span>
            <span className="row__meta">{tn('unit_bookmarks', count)}</span>
          </span>
          {selecting ? null : <Icon name="chevron" className="row__chevron" />}
        </button>
        {selecting ? (
          <IconButton
            icon="chevron"
            className="row__enter"
            label={t('row_open_folder_named', folder.name || t('folder_untitled'))}
            hint={t('row_open_folder')}
            onClick={() => {
              onNavigate(folder.id);
            }}
          />
        ) : null}
      </div>
    );
  };

  const bookmarkRow = (record: PrivateBookmark) => {
    const hostname = hostnameOf(record.url);
    const body = (
      <>
        <VaultThumb id={record.id} hostname={hostname} />
        <span className="row__text">
          <span className="row__title">
            <Highlight text={record.title || hostname} query={searching ? query : undefined} />
          </span>
          <span className="row__meta">{hostname}</span>
        </span>
      </>
    );
    return (
      <div
        className={wrapClass(record.id)}
        {...listGrouping?.drag.cardProps(record.id)}
        {...contextMenuHandlers(({ x, y }) => {
          onBookmarkMenu(record, x, y);
        })}
      >
        {selecting ? (
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
            <CheckMark state={selected.has(record.id)} />
            {body}
          </button>
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
            {body}
          </a>
        )}
      </div>
    );
  };

  return (
    <>
      <header className="head">
        <SearchBar value={query} onChange={onQueryChange} placeholder={t('vault_search_placeholder')} />
        <div className="nav">
          {searching ? (
            <p className="nav__info">{tn('search_results', rows.length)}</p>
          ) : filtered ? (
            <>
              <p className="nav__info">{tn('missing_previews', rows.length)}</p>
              <IconButton icon="close" label={t('missing_previews_clear')} onClick={onClearOnly} />
            </>
          ) : folderId === null ? (
            <p className="nav__info">
              <strong>{t('crumbs_all')}</strong>
              {tn('unit_bookmarks', state.bookmarkCount)}
            </p>
          ) : (
            <>
              <UpButton
                onUp={() => {
                  onNavigate(parentId);
                }}
              />
              <Breadcrumb
                path={vaultPathTo(folders, folderId)}
                onNavigate={onNavigate}
                rootLabel={t('crumbs_all')}
                drop={
                  grouping === undefined
                    ? undefined
                    : { props: (id) => grouping.drag.crumbProps(id, true), className: grouping.drag.crumbClass }
                }
              />
            </>
          )}
          {searching || filtered ? null : (
            <IconButton
              icon="folder-plus"
              label={t('action_new_folder')}
              hint={t('new_folder_hint_nested')}
              onClick={() => {
                setCreatingFolder(true);
              }}
            />
          )}
        </div>
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
      </header>

      <main className="body">
        {selecting ? selectAll : null}
        {(searching || filtered) && rows.length === 0 ? (
          <p className="empty">{t('search_no_match')}</p>
        ) : !searching && empty ? (
          <p className="empty">{folderId === null ? t('vault_empty_hint') : t('folder_empty')}</p>
        ) : (
          <div
            ref={virtual.ref}
            onKeyDown={listGrouping === undefined ? nav.onKeyDown : listGrouping.board.onKeyDown(nav.onKeyDown)}
            {...listGrouping?.drag.gridProps}
            className={`list list--${density}${listGrouping?.drag.dragging === true ? ' list--dragging' : ''}`}
            // 墊高用 padding 而不是墊兩個空 div：多出來的元素會讓內容比計算出來的位置偏移幾個像素
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
      </main>
    </>
  );
}
