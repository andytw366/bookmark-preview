import { useEffect, useState } from 'react';
import type {
  Density,
  OpenTarget,
  PrivateBookmark,
  PrivateFolder,
  VaultState,
} from '@/shared/types';
import { hostnameOf } from '@/shared/url';
import { vaultChildren, type VaultLayout } from '@/shared/vault-layout';
import { useListNav } from '../hooks/useListNav';
import { useVirtualRows } from '../hooks/useVirtualRows';
import { contextMenuHandlers } from '../lib/keys';
import { vaultPathTo } from '../lib/vault-tree';
import { Breadcrumb } from './Breadcrumb';
import { NewFolderForm } from './NewFolderForm';
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
  /** 全頁瀏覽排過的順序。側邊欄還不能拖（第 4 期），但要照同一個順序顯示 */
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

  /*
   * 資料夾與書籤合成一份陣列。
   *
   * 虛擬滾動的單位是「第幾列」，兩段各自 map 的話就沒有一個共同的索引可以切 ——
   * 而且「先資料夾後書籤」本來就是同一份清單的順序，只是原本分兩段畫。
   */
  const rows: VaultRow[] = vaultChildren(folders, bookmarks, folderId, layout);

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
    resetKey: `${folderId ?? 'root'}/${density}/${String(selecting)}`,
  });
  const nav = useListNav(
    {
      onEnterFolder: onNavigate,
      // 最上層沒有上一層可回
      onLeave:
        folderId === null
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
      key={folder.id}
      className={`vault__row row-wrap${selecting ? ' row-wrap--selecting' : ''}${
        selecting && selected.has(folder.id) ? ' row-wrap--selected' : ''
      }`}
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
      key={record.id}
      className={`vault__row row-wrap${selecting ? ' row-wrap--selecting' : ''}${
        selecting && selected.has(record.id) ? ' row-wrap--selected' : ''
      }`}
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

      <Breadcrumb path={vaultPathTo(folders, folderId)} onNavigate={onNavigate} />

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

      {empty ? (
        <p className="empty">
          {folderId === null
            ? t('vault_empty_hint')
            : t('folder_empty')}
        </p>
      ) : (
        <div
          ref={virtual.ref}
          onKeyDown={nav.onKeyDown}
          className={`list list--${density}`}
          // 墊高用 padding 而不是墊兩個空 div：`.list` 有 gap，空 div 會多出兩道
          // 間距，讓內容比計算出來的位置多偏移幾個像素
          style={{ paddingTop: virtual.padTop, paddingBottom: virtual.padBottom }}
        >
          {rows
            .slice(virtual.start, virtual.end)
            .map((row) => (row.kind === 'folder' ? folderRow(row.folder) : bookmarkRow(row.record)))}
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
