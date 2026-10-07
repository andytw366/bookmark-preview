import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { request } from '@/shared/messages';
import type { BookmarkNode, PrivateBookmark, PrivateFolder } from '@/shared/types';
import { hostnameOf } from '@/shared/url';
import { matchesVaultTrigger } from '@/shared/vault-entry';
import { Breadcrumb } from '../sidebar/components/Breadcrumb';
import { FolderPicker } from '../sidebar/components/FolderPicker';
import { MoveInPrompt } from '../sidebar/components/MoveInPrompt';
import { NewFolderForm } from '../sidebar/components/NewFolderForm';
import { RowMenu, type MenuTarget } from '../sidebar/components/RowMenu';
import { Thumb } from '../sidebar/components/Thumb';
import { VaultFolderPicker } from '../sidebar/components/VaultFolderPicker';
import { VaultPrompt } from '../sidebar/components/VaultPrompt';
import { VaultRowMenu, type VaultMenuTarget } from '../sidebar/components/VaultRowMenu';
import { VaultThumb } from '../sidebar/components/VaultThumb';
import { PreviewOptionsMenu } from '../sidebar/components/PreviewOptionsMenu';
import type { SelectionAction } from '../sidebar/components/Toolbar';
import { useBackfill } from '../sidebar/hooks/useBackfill';
import { useBookmarks } from '../sidebar/hooks/useBookmarks';
import { useHostPermission } from '../sidebar/hooks/useHostPermission';
import { useListNav } from '../sidebar/hooks/useListNav';
import { useGridColumns, useVirtualRows } from '../sidebar/hooks/useVirtualRows';
import { useSettings } from '../sidebar/hooks/useSettings';
import { useVault } from '../sidebar/hooks/useVault';
import {
  VaultTokens,
  historyEntry,
  historyStep,
  parseFolderHash,
  placeFromHistory,
  type GalleryPlace,
} from '../sidebar/lib/gallery-history';
import { contextMenuHandlers } from '../sidebar/lib/keys';
import { buildIndex, countLinks, pathTo, searchLinks } from '../sidebar/lib/tree';
import { vaultPathTo } from '../sidebar/lib/vault-tree';
import { t, tn } from '@/shared/i18n';

/**
 * 獨立分頁的全頁書籤瀏覽。
 *
 * 側邊欄再怎麼調都只有 320–420px 寬，一次只放得下一欄；要一眼看過幾十個
 * 封面就需要整個視窗的寬度。所以這是一個獨立的擴充套件頁面，用網格並排排列，
 * 而不是把側邊欄硬撐開。
 *
 * 邏輯（樹索引、搜尋、縮圖讀取、隱私空間）全部沿用側邊欄那一套，沒有另寫一份 ——
 * 搜尋、縮圖 fallback 與加密處理的行為一分岔就會開始各自漂移。
 *
 * **隱私空間的入口與側邊欄一致**：在搜尋框輸入主密碼按 Enter。`useVault` 會在
 * 解鎖期間自己維持一條 keepalive port，所以這個頁面單獨開著也撐得住事件頁；
 * 分頁關閉時 port 斷開，若側邊欄也沒開就會自動上鎖。
 */
const COLUMN_CHOICES = [140, 200, 280] as const;
type ColumnSize = (typeof COLUMN_CHOICES)[number];

const SIZE_LABEL: Record<ColumnSize, string> = {
  140: t('size_small'),
  200: t('size_medium'),
  280: t('size_large'),
};

type Mode = 'bookmarks' | 'vault';

/** 與 gallery.css 的 `.grid { gap: 16px }` 一致 —— 欄數是照這個算的 */
const GRID_GAP = 16;

/**
 * 一張卡片大概多高（還沒量到的列用這個估）。
 *
 * 縮圖區是 `--card-min * 0.72`，其餘是標題、網域、內距與列間距。只影響捲軸
 * 長度與第一次要畫幾列，量到之後就以實際值為準。
 */
const cardEstimate = (size: ColumnSize): number => size * 0.72 + 82;

/** 隱私空間的資料夾與書籤在畫面上是同一份清單 */
type VaultGridRow =
  | { kind: 'folder'; folder: PrivateFolder }
  | { kind: 'bookmark'; record: PrivateBookmark };

export function Gallery() {
  const { roots, error, reload } = useBookmarks();
  const { settings, update } = useSettings();
  const permission = useHostPermission();
  const permissionGranted = permission.granted === true;

  const [mode, setMode] = useState<Mode>('bookmarks');
  // vaultInView 讓 useVault 知道要不要把使用者的操作算成「還在用隱私空間」
  const vault = useVault({ vaultInView: mode === 'vault' });
  // 開頁時照網址的 #folder= 停在那個資料夾：重新整理、或把網址存起來再開都一樣
  const [folderId, setFolderId] = useState<string | null>(() => parseFolderHash(location.hash));
  const [vaultFolderId, setVaultFolderId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [size, setSize] = useState<ColumnSize>(200);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [vaultMenu, setVaultMenu] = useState<VaultMenuTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [vaultPrompt, setVaultPrompt] = useState(false);
  const [selecting, setSelecting] = useState(false);
  // 勾選跨資料夾巡覽保留，所以存 id
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [folderPicker, setFolderPicker] = useState<{ x: number; y: number } | null>(null);
  /** 批量移出：要選一個原生資料夾當落點 */
  const [exportPicker, setExportPicker] = useState<{
    x: number;
    y: number;
    ids: string[];
  } | null>(null);
  /** 隱私空間內的巡覽勾選（與書籤那邊分開，id 空間不同） */
  const [vaultSelecting, setVaultSelecting] = useState(false);
  const [vaultSelectedIds, setVaultSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [vaultFolderPicker, setVaultFolderPicker] = useState<{ x: number; y: number } | null>(null);
  const [optionsMenu, setOptionsMenu] = useState<{ x: number; y: number } | null>(null);
  const backfill = useBackfill();
  const [pendingMove, setPendingMove] = useState<{
    nodes: BookmarkNode[];
    x: number;
    y: number;
  } | null>(null);

  // 兩個網格的容器。由元件持有而不是各自的 hook 建，因為欄數與虛擬滾動
  // 要量同一個元素，而欄數又是虛擬滾動的輸入
  const gridRef = useRef<HTMLDivElement>(null);
  const vaultGridRef = useRef<HTMLDivElement>(null);

  const index = useMemo(() => buildIndex(roots ?? []), [roots]);
  const vaultStatus = vault.state?.status;
  const vaultUnlocked = vaultStatus === 'unlocked';

  /*
   * 資料夾巡覽接到瀏覽器的歷史紀錄（規則與隱私空間為什麼只放代號，見 gallery-history）。
   *
   * 歷史只在事件處理裡寫，不在 effect 裡寫 —— StrictMode 會把 effect 跑兩次，
   * push 跑兩次就多一筆。唯一的例外是「退回」那幾個 effect，它們用 replace，跑幾次都一樣。
   */
  const tokensRef = useRef<VaultTokens | null>(null);
  tokensRef.current ??= new VaultTokens();
  const tokens = tokensRef.current;

  const here: GalleryPlace =
    mode === 'vault' ? { mode: 'vault', folderId: vaultFolderId } : { mode: 'bookmarks', folderId };

  const writeHistory = (place: GalleryPlace, how: 'push' | 'replace'): void => {
    const entry = historyEntry(place, tokens);
    const url = `${location.pathname}${location.search}${entry.hash}`;
    if (how === 'push') {
      history.pushState(entry.state, '', url);
      return;
    }
    history.replaceState(entry.state, '', url);
  };

  const showPlace = (place: GalleryPlace): void => {
    if (place.mode === 'vault') {
      setMode('vault');
      setVaultFolderId(place.folderId);
      return;
    }
    setMode('bookmarks');
    setFolderId(place.folderId);
  };

  /** 使用者的巡覽一律走這裡，上一頁才回得來 */
  const go = (place: GalleryPlace): void => {
    const step = historyStep(here, place, 'user');
    if (step !== 'none') {
      writeHistory(place, step);
    }
    showPlace(place);
  };

  // popstate 的處理器只綁一次，要讀到最新的解鎖狀態得經過 ref
  const vaultUnlockedRef = useRef(vaultUnlocked);
  vaultUnlockedRef.current = vaultUnlocked;

  useEffect(() => {
    // 開頁時一定在書籤這邊：若重新整理前停在隱私空間，記憶體裡的代號表已經沒了
    const initial = placeFromHistory(history.state, location.hash, tokens, false).place;
    writeHistory(initial, 'replace');

    const onPop = (event: PopStateEvent): void => {
      const { place, known } = placeFromHistory(
        event.state,
        location.hash,
        tokens,
        vaultUnlockedRef.current,
      );
      if (!known) {
        // 不認得的代號換成書籤最上層的項目，再按一次下一頁也不會回到這個死掉的代號
        writeHistory(place, 'replace');
      }
      // 搜尋字留著的話，回到的資料夾會被搜尋結果蓋住，看起來像上一頁沒反應
      setQuery('');
      showPlace(place);
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
    };
    // 只在開頁時跑：writeHistory 與 tokens 都不會換
  }, []);

  // 所在的資料夾被刪掉時退回最上層。用 replace：上一頁不該回到一個不存在的地方。
  // 書籤還沒讀進來時索引是空的，那時不能判斷 —— 否則網址帶的 #folder= 一開頁就被清掉
  useEffect(() => {
    if (roots !== null && folderId !== null && !index.byId.has(folderId)) {
      setFolderId(null);
      if (mode === 'bookmarks') {
        writeHistory({ mode: 'bookmarks', folderId: null }, 'replace');
      }
    }
  }, [roots, index, folderId, mode]);

  // 上鎖時清掉代號表：之後按上一頁回到隱私空間的項目，一律當成不認得
  useEffect(() => {
    if (!vaultUnlocked) {
      tokens.clear();
    }
  }, [vaultUnlocked, tokens]);

  // 上鎖後不要停在隱私空間 —— 隱密模式下那會留下一個解鎖畫面暴露它的存在
  useEffect(() => {
    if (!vaultUnlocked && mode === 'vault') {
      setMode('bookmarks');
      setVaultFolderId(null);
      writeHistory({ mode: 'bookmarks', folderId }, 'replace');
    }
  }, [vaultUnlocked, mode]);

  // 目前所在的隱私資料夾被刪掉時退回最上層
  useEffect(() => {
    if (vaultFolderId !== null && !vault.folders.some((folder) => folder.id === vaultFolderId)) {
      setVaultFolderId(null);
      if (mode === 'vault') {
        writeHistory({ mode: 'vault', folderId: null }, 'replace');
      }
    }
  }, [vault.folders, vaultFolderId]);

  const open = (url: string, background: boolean): void => {
    // 從整頁視圖點開時預設開新分頁：用當前分頁載入會把這個瀏覽畫面本身蓋掉
    void request('bookmarks/open', { url, where: background ? 'newTabBackground' : 'newTab' });
  };

  /** 與側邊欄同一個入口：打中觸發字串就清掉輸入並跳出密碼畫面。 */
  const handleQueryChange = (value: string): void => {
    if (settings !== null && matchesVaultTrigger(value, settings.vaultTrigger)) {
      setQuery('');
      // 問一次現在的狀態，不要相信快取 —— 事件頁被卸載時金鑰會無聲消失，
      // 快取可能還停在「已解鎖」，那時跳進去只會看到一個什麼都做不了的畫面
      void vault.refreshState().then((fresh) => {
        if (fresh?.status === 'unlocked') {
          go({ mode: 'vault', folderId: vaultFolderId });
          return;
        }
        setVaultPrompt(true);
      });
      return;
    }
    setQuery(value);
  };

  // 通知訊息幾秒後自己消失（理由同側邊欄：不該讓一小時前那句話一直跟著使用者）
  useEffect(() => {
    if (notice === null) {
      return;
    }
    const timer = setTimeout(() => {
      setNotice(null);
    }, 10_000);
    return () => {
      clearTimeout(timer);
    };
  }, [notice]);

  const exitSelection = (): void => {
    setSelecting(false);
    setSelectedIds(new Set());
    setVaultSelecting(false);
    setVaultSelectedIds(new Set());
  };

  const toggleVaultSelect = (id: string): void => {
    setVaultSelectedIds((current) => {
      const next = new Set(current);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });
  };

  const toggleSelect = (id: string): void => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });
  };

  const trimmed = query.trim();
  const currentNode = folderId === null ? undefined : index.byId.get(folderId);
  const currentFolder = currentNode?.kind === 'folder' ? currentNode : undefined;
  const search = trimmed === '' ? null : searchLinks(roots ?? [], trimmed);
  const nodes: BookmarkNode[] =
    search !== null ? search.links : (currentFolder?.children ?? roots ?? []);

  // 勾選跨資料夾保留，所以要從整棵樹的索引還原成節點，並濾掉已不存在的 id
  const selectedNodes: BookmarkNode[] = [...selectedIds]
    .map((id) => index.byId.get(id))
    .filter((node): node is BookmarkNode => node !== undefined);

  // 資料夾整棵一起移入，所以送的是 selectedNodes；這個數字只用來判斷有沒有東西可移
  const selectedLinkCount = countLinks(selectedNodes);

  const vaultFolders: PrivateFolder[] = vault.folders.filter(
    (folder) => folder.parentId === vaultFolderId,
  );
  const vaultBookmarks: PrivateBookmark[] = vault.bookmarks.filter(
    (record) => record.folderId === vaultFolderId,
  );

  /*
   * 隱私空間的資料夾與書籤合成一份陣列 —— 虛擬滾動的切片索引要橫跨兩者。
   */
  /* 每個隱私資料夾直接裝了幾個書籤，掃一次建表 —— 原本是每張卡片各自
     filter 整份清單，也就是「資料夾數 × 書籤數」次比對，而且每次重繪都重算 */
  const vaultCountIn = new Map<string, number>();
  for (const record of vault.bookmarks) {
    if (record.folderId !== null) {
      vaultCountIn.set(record.folderId, (vaultCountIn.get(record.folderId) ?? 0) + 1);
    }
  }

  const vaultRows: VaultGridRow[] = [
    ...vaultFolders.map((folder): VaultGridRow => ({ kind: 'folder', folder })),
    ...vaultBookmarks.map((record): VaultGridRow => ({ kind: 'bookmark', record })),
  ];

  /*
   * 兩個網格各有一組虛擬滾動與鍵盤巡覽。
   *
   * 欄數要在「決定渲染哪幾列」之前就知道，所以是從容器寬度算的（`useGridColumns`），
   * 不是從已渲染的卡片量的。
   *
   * 網格裡左右鍵是相鄰的格子，沒得挪去做「進資料夾」—— 那件事交給 Enter，
   * 資料夾卡片本來就是按下去就進去。只有回上一層需要另外給鍵，用 Backspace。
   */
  /** 「上一層」：Backspace 與麵包屑旁的 ↑ 共用。搜尋結果與最上層沒有上一層 */
  const upBookmarks =
    search !== null || currentFolder === undefined
      ? undefined
      : () => {
          go({ mode: 'bookmarks', folderId: index.parentOf.get(currentFolder.id) ?? null });
        };
  const upVault =
    vaultFolderId === null
      ? undefined
      : () => {
          go({
            mode: 'vault',
            folderId: vault.folders.find((folder) => folder.id === vaultFolderId)?.parentId ?? null,
          });
        };

  const listKey = search === null ? (folderId ?? 'root') : `search:${trimmed}`;
  const columns = useGridColumns(gridRef, size, GRID_GAP);
  const gridRows = useVirtualRows({
    count: nodes.length,
    columns,
    estimate: cardEstimate(size),
    resetKey: `${listKey}/${String(size)}/${String(selecting)}/${String(columns)}`,
    ref: gridRef,
  });
  const nav = useListNav(
    {
      onLeave: upBookmarks,
      virtual: {
        start: gridRows.start,
        count: nodes.length,
        columns,
        scrollToIndex: gridRows.scrollToIndex,
      },
    },
    gridRef,
  );

  const vaultColumns = useGridColumns(vaultGridRef, size, GRID_GAP);
  const vaultGrid = useVirtualRows({
    count: vaultRows.length,
    columns: vaultColumns,
    estimate: cardEstimate(size),
    resetKey: `${vaultFolderId ?? 'root'}/${String(size)}/${String(vaultSelecting)}/${String(vaultColumns)}`,
    ref: vaultGridRef,
  });
  const vaultNav = useListNav(
    {
      onLeave: upVault,
      virtual: {
        start: vaultGrid.start,
        count: vaultRows.length,
        columns: vaultColumns,
        scrollToIndex: vaultGrid.scrollToIndex,
      },
    },
    vaultGridRef,
  );

  // 隱密模式下只有解鎖後才顯示切換，否則這個頁面完全沒有隱私空間的痕跡
  const showModes = settings?.vaultEntry === 'tab' || vaultUnlocked;
  // 根層列的是 Firefox 內建的永久資料夾，移入對它們一定失敗（理由同側邊欄）
  const showingRoots = search === null && currentFolder === undefined;

  /*
   * 兩個模式各有自己的多選狀態（id 空間不同），但工具列只有一組。
   * 這裡把「目前這個模式的」狀態與動作收斂成同一組值，讓那一列不必到處
   * 判斷 mode —— 否則每個按鈕都要寫一次三元運算，正是原本兩邊長得不一樣的成因。
   */
  const activeSelecting = mode === 'vault' ? vaultSelecting : selecting;
  const activeSelectedCount = mode === 'vault' ? vaultSelectedIds.size : selectedNodes.length;

  const selectAllInView = (): void => {
    if (mode === 'vault') {
      setVaultSelectedIds((current) => {
        const next = new Set(current);
        for (const folder of vaultFolders) {
          next.add(folder.id);
        }
        for (const record of vaultBookmarks) {
          next.add(record.id);
        }
        return next;
      });
      return;
    }
    // 資料夾也一起選：批量搬移對資料夾同樣有效
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const node of nodes) {
        next.add(node.id);
      }
      return next;
    });
  };

  const selectionActions: SelectionAction[] =
    mode === 'vault'
      ? [
          {
            label: t('action_move_to'),
            primary: true,
            onPick: (x, y) => {
              setVaultFolderPicker({ x, y });
            },
          },
          {
            label: t('vault_export_to'),
            title: t('vault_export_to_hint'),
            onPick: (x, y) => {
              setExportPicker({ x, y, ids: [...vaultSelectedIds] });
            },
          },
        ]
      : [
          {
            label: t('action_move_to'),
            primary: true,
            onPick: (x, y) => {
              setFolderPicker({ x, y });
            },
          },
          ...(vaultUnlocked
            ? [
                {
                  label: t('row_import'),
                  // 資料夾連同子樹一起移入，只有「一個書籤都沒勾到」才無事可做
                  disabled: selectedLinkCount === 0,
                  title: selectedNodes.some((node) => node.kind === 'folder')
                    ? t('row_import_folder_hint')
                    : undefined,
                  onPick: (x: number, y: number) => {
                    setPendingMove({ nodes: selectedNodes, x, y });
                  },
                },
              ]
            : []),
        ];
  const gridStyle = { '--card-min': `${String(size)}px` } as CSSProperties;

  if (error !== null) {
    return (
      <div className="gallery">
        <div className="notice notice--error">
          <p>{t('bookmarks_read_failed', error)}</p>
          <button type="button" onClick={reload}>
            {t('action_retry')}
          </button>
        </div>
      </div>
    );
  }

  /*
   * 隱私空間的兩種卡片各自的畫法。
   *
   * 抽成函式是因為虛擬滾動之後兩者必須在同一次 map 裡畫出來（切片的索引橫跨
   * 資料夾與書籤），把兩段 JSX 直接塞進一個三元運算會難以閱讀。
   */
  const vaultFolderCard = (folder: PrivateFolder) => (
    // 多選中點卡片是勾選，巡覽移到角落的箭頭（與側邊欄同一套規則）
    <div
      key={folder.id}
      className={`card-wrap${vaultSelectedIds.has(folder.id) ? ' card-wrap--selected' : ''}`}
    >
      <button
        type="button"
        className="card card--folder"
        data-nav=""
        onClick={() => {
          if (vaultSelecting) {
            toggleVaultSelect(folder.id);
            return;
          }
          go({ mode: 'vault', folderId: folder.id });
        }}
        {...contextMenuHandlers(({ x, y }) => {
          setVaultMenu({ kind: 'folder', folder, x, y });
        })}
      >
        <span className="card__folder-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h9A1.5 1.5 0 0 1 21 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
          </svg>
        </span>
        <span className="card__title">{folder.name || t('folder_untitled_folder')}</span>
        <span className="card__meta">{tn('unit_bookmarks', vaultCountIn.get(folder.id) ?? 0)}</span>
      </button>
      {vaultSelecting ? (
        <>
          <span
            className={`card__check${vaultSelectedIds.has(folder.id) ? ' card__check--on' : ''}`}
            aria-hidden="true"
          >
            {vaultSelectedIds.has(folder.id) ? '✓' : ''}
          </span>
          <button
            type="button"
            className="card__enter"
            title={t('row_open_folder')}
            aria-label={t('row_open_folder_named', folder.name || t('folder_untitled'))}
            onClick={() => {
              go({ mode: 'vault', folderId: folder.id });
            }}
          >
            ›
          </button>
        </>
      ) : null}
    </div>
  );

  const vaultBookmarkCard = (record: PrivateBookmark) =>
    vaultSelecting ? (
      <button
        key={record.id}
        type="button"
        className={`card card--select${vaultSelectedIds.has(record.id) ? ' card--selected' : ''}`}
        data-nav=""
        role="checkbox"
        aria-checked={vaultSelectedIds.has(record.id)}
        title={record.url}
        onClick={() => {
          toggleVaultSelect(record.id);
        }}
        {...contextMenuHandlers(({ x, y }) => {
          setVaultMenu({ kind: 'bookmark', record, x, y });
        })}
      >
        <span className="card__thumb">
          <VaultThumb id={record.id} hostname={hostnameOf(record.url)} />
          <span
            className={`card__check${vaultSelectedIds.has(record.id) ? ' card__check--on' : ''}`}
            aria-hidden="true"
          >
            {vaultSelectedIds.has(record.id) ? '✓' : ''}
          </span>
        </span>
        <span className="card__title">{record.title || hostnameOf(record.url)}</span>
        <span className="card__meta">{hostnameOf(record.url)}</span>
      </button>
    ) : (
      <a
        key={record.id}
        className="card"
        data-nav=""
        href={record.url}
        title={record.url}
        onClick={(event) => {
          event.preventDefault();
          open(record.url, event.ctrlKey || event.metaKey);
        }}
        {...contextMenuHandlers(({ x, y }) => {
          setVaultMenu({ kind: 'bookmark', record, x, y });
        })}
      >
        <span className="card__thumb">
          <VaultThumb id={record.id} hostname={hostnameOf(record.url)} />
        </span>
        <span className="card__title">{record.title || hostnameOf(record.url)}</span>
        <span className="card__meta">{hostnameOf(record.url)}</span>
      </a>
    );

  return (
    <div className="gallery">
      {/*
        兩個模式共用同一組列，位置固定：
          1. 標題 / 搜尋 / 卡片大小 / 更多選項
          2. 範圍切換 / 選取 / 該模式專屬的動作
          3. 多選列（只在多選時出現）
        原本「選取」在書籤模式放第一列、在隱私空間放第二列，兩個模式長得不一樣。
      */}
      <header className="gallery__head">
        <h1 className="gallery__title">{t('extension_name')}</h1>
        <input
          className="gallery__search"
          type="search"
          value={query}
          placeholder={t('search_placeholder')}
          aria-label={t('search_label')}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            handleQueryChange(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setQuery('');
            }
          }}
        />
        <div className="segmented" role="group" aria-label={t('gallery_card_size')}>
          {COLUMN_CHOICES.map((choice) => (
            <button
              key={choice}
              type="button"
              className={`segmented__item${size === choice ? ' segmented__item--active' : ''}`}
              aria-pressed={size === choice}
              onClick={() => {
                setSize(choice);
              }}
            >
              {SIZE_LABEL[choice]}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="toolbar__action toolbar__action--icon"
          title={t('toolbar_more')}
          aria-label={t('toolbar_more')}
          aria-haspopup="true"
          aria-expanded={optionsMenu !== null}
          onClick={(event) => {
            if (optionsMenu !== null) {
              setOptionsMenu(null);
              return;
            }
            const rect = event.currentTarget.getBoundingClientRect();
            setOptionsMenu({ x: rect.right - 200, y: rect.bottom + 6 });
          }}
        >
          <svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor" aria-hidden="true">
            <circle cx="4" cy="10" r="1.5" />
            <circle cx="10" cy="10" r="1.5" />
            <circle cx="16" cy="10" r="1.5" />
          </svg>
        </button>
      </header>

      {backfill.status !== null ? <p className="gallery__status">{backfill.status}</p> : null}

      <div className="gallery__modes">
        {showModes ? (
          <div className="segmented" role="group" aria-label={t('gallery_scope')}>
            <button
              type="button"
              className={`segmented__item${mode === 'bookmarks' ? ' segmented__item--active' : ''}`}
              aria-pressed={mode === 'bookmarks'}
              onClick={() => {
                exitSelection();
                // 表單開著時一併關掉：它建在「目前模式的目前資料夾」，
                // 帶著它切換空間會建到另一邊去
                setCreatingFolder(false);
                go({ mode: 'bookmarks', folderId });
              }}
            >
              {t('tab_bookmarks')}
            </button>
            <button
              type="button"
              className={`segmented__item${mode === 'vault' ? ' segmented__item--active' : ''}`}
              aria-pressed={mode === 'vault'}
              onClick={() => {
                // 先退出多選：勾選的是「書籤」那邊的項目，帶著它切過來只會
                // 留下一排在隱私空間無處可用的動作按鈕
                exitSelection();
                setCreatingFolder(false);
                go({ mode: 'vault', folderId: vaultFolderId });
              }}
            >
              {t('tab_vault')}
            </button>
          </div>
        ) : null}

        <button
          type="button"
          className="toolbar__action"
          title={t('gallery_select_hint')}
          onClick={() => {
            if (activeSelecting) {
              exitSelection();
              return;
            }
            if (mode === 'vault') {
              setVaultSelecting(true);
              return;
            }
            setSelecting(true);
          }}
        >
          {activeSelecting ? t('action_deselect') : t('toolbar_select')}
        </button>

        {/* 兩個模式都有：它建在「目前這個資料夾」裡，與模式無關 */}
        <button
          type="button"
          className="toolbar__action"
          title={
            mode === 'bookmarks' && folderId === null
              ? t('new_folder_hint_root')
              : t('new_folder_hint_nested')
          }
          onClick={() => {
            setCreatingFolder(true);
          }}
        >
          {t('action_new_folder')}
        </button>

        {mode === 'vault' ? (
          <button
            type="button"
            className="toolbar__action"
            onClick={() => {
              void vault.lock();
            }}
          >
            {t('vault_lock_now')}
          </button>
        ) : null}
      </div>

      {activeSelecting ? (
        <div className="gallery__selection">
          <span className="toolbar__count">{tn('toolbar_selected', activeSelectedCount)}</span>
          <button type="button" className="toolbar__action" onClick={selectAllInView}>
            {t('action_select_all')}
          </button>
          {selectionActions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={`toolbar__action${action.primary === true ? ' toolbar__action--primary' : ''}`}
              disabled={activeSelectedCount === 0 || action.disabled === true}
              title={action.title}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                action.onPick(rect.left, rect.bottom + 4);
              }}
            >
              {action.label}
            </button>
          ))}
          <button type="button" className="toolbar__action" onClick={exitSelection}>
            {t('action_cancel')}
          </button>
        </div>
      ) : null}


      {vault.error !== null ? (
        <div className="notice notice--error">
          <p>{vault.error}</p>
          <button type="button" onClick={vault.clearError}>
            {t('action_close')}
          </button>
        </div>
      ) : null}

      {notice !== null ? (
        <div className="notice notice--info">
          <p>{notice}</p>
          <button
            type="button"
            onClick={() => {
              setNotice(null);
            }}
          >
            {t('action_close')}
          </button>
        </div>
      ) : null}

      {creatingFolder ? (
        <NewFolderForm
          hint={
            mode === 'bookmarks' && folderId === null
              ? t('new_folder_root_note')
              : undefined
          }
          onCancel={() => {
            setCreatingFolder(false);
          }}
          onCreate={(name) => {
            setCreatingFolder(false);
            if (mode === 'vault') {
              void vault.createFolder(name, vaultFolderId);
              return;
            }
            void request('bookmarks/folder-create', {
              ...(folderId === null ? {} : { parentId: folderId }),
              title: name,
            }).then(reload, (cause: unknown) => {
              setNotice(cause instanceof Error ? cause.message : String(cause));
            });
          }}
        />
      ) : null}

      <div className="gallery__crumbs">
        {mode === 'vault' ? (
          <Breadcrumb
            path={vaultPathTo(vault.folders, vaultFolderId)}
            onNavigate={(id) => {
              go({ mode: 'vault', folderId: id });
            }}
            onUp={upVault}
          />
        ) : search === null ? (
          <Breadcrumb
            path={
              currentFolder === undefined
                ? []
                : pathTo(index, currentFolder.id).map((folder) => ({
                    id: folder.id,
                    title: folder.title,
                  }))
            }
            onNavigate={(id) => {
              go({ mode: 'bookmarks', folderId: id });
            }}
            onUp={upBookmarks}
          />
        ) : (
          <p className="gallery__hint">
            {tn('search_results', search.links.length)}
            {search.truncated ? t('search_truncated') : ''}
          </p>
        )}
      </div>

      {mode === 'vault' ? (
        vaultFolders.length === 0 && vaultBookmarks.length === 0 ? (
          <p className="empty">
            {vaultFolderId === null
              ? t('gallery_vault_empty_hint')
              : t('folder_empty')}
          </p>
        ) : (
          <div
            ref={vaultGridRef}
            onKeyDown={vaultNav.onKeyDown}
            className="grid"
            style={{ ...gridStyle, paddingTop: vaultGrid.padTop, paddingBottom: vaultGrid.padBottom }}
          >
            {vaultRows
              .slice(vaultGrid.start, vaultGrid.end)
              .map((row) =>
                row.kind === 'folder' ? vaultFolderCard(row.folder) : vaultBookmarkCard(row.record),
              )}
          </div>
        )
      ) : roots === null ? (
        <p className="empty">{t('bookmarks_loading')}</p>
      ) : nodes.length === 0 ? (
        <p className="empty">{search !== null ? t('search_no_match') : t('folder_no_bookmarks')}</p>
      ) : (
        <div
          ref={gridRef}
          onKeyDown={nav.onKeyDown}
          className="grid"
          // 墊高用 padding：網格用空 div 佔位還得跨滿整列，padding 沒有這個問題
          style={{ ...gridStyle, paddingTop: gridRows.padTop, paddingBottom: gridRows.padBottom }}
        >
          {nodes.slice(gridRows.start, gridRows.end).map((node) =>
            node.kind === 'folder' ? (
              // 多選中點卡片是勾選（與書籤卡片一致），巡覽移到角落的箭頭。
              // 兩個動作各有自己的目標：資料夾不能點進去就沒得跨資料夾挑選，
              // 但「點資料夾卻只是進去、選不到它」也同樣不合直覺。
              <div
                key={node.id}
                className={`card-wrap${selecting && selectedIds.has(node.id) ? ' card-wrap--selected' : ''}`}
              >
                <button
                  type="button"
                  className="card card--folder"
                  data-nav=""
                  {...(selecting
                    ? { role: 'checkbox', 'aria-checked': selectedIds.has(node.id) }
                    : {})}
                  onClick={() => {
                    if (selecting) {
                      toggleSelect(node.id);
                      return;
                    }
                    go({ mode: 'bookmarks', folderId: node.id });
                    setQuery('');
                  }}
                  {...contextMenuHandlers(({ x, y }) => {
                    setMenu({ node, x, y });
                  })}
                >
                  <span className="card__folder-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="1.6">
                      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h9A1.5 1.5 0 0 1 21 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
                    </svg>
                  </span>
                  <span className="card__title">{node.title || t('folder_untitled_folder')}</span>
                  <span className="card__meta">{tn('unit_bookmarks', countLinks(node.children))}</span>
                </button>
                {selecting ? (
                  <>
                    <span
                      className={`card__check${selectedIds.has(node.id) ? ' card__check--on' : ''}`}
                      aria-hidden="true"
                    >
                      {selectedIds.has(node.id) ? '✓' : ''}
                    </span>
                    <button
                      type="button"
                      className="card__enter"
                      title={t('row_open_folder')}
                      aria-label={t('row_open_folder_named', node.title || t('folder_untitled'))}
                      onClick={() => {
                        go({ mode: 'bookmarks', folderId: node.id });
                        setQuery('');
                      }}
                    >
                      ›
                    </button>
                  </>
                ) : null}
              </div>
            ) : selecting ? (
              // 多選中整張卡片是勾選觸發區。維持成 <a> 會讓「點擊等於開啟」
              // 與「點擊等於勾選」衝突，所以換成 button。
              <button
                key={node.id}
                type="button"
                className={`card card--select${selectedIds.has(node.id) ? ' card--selected' : ''}`}
                data-nav=""
                role="checkbox"
                aria-checked={selectedIds.has(node.id)}
                title={node.url}
                onClick={() => {
                  toggleSelect(node.id);
                }}
                // 多選中的書籤卡片原本沒有右鍵選單（資料夾與隱私空間那邊都有），
                // 表現成「同一批卡片有些能按右鍵、有些不能」
                {...contextMenuHandlers(({ x, y }) => {
                  setMenu({ node, x, y });
                })}
              >
                <span className="card__thumb">
                  <Thumb url={node.url} hostname={hostnameOf(node.url)} />
                  <span
                    className={`card__check${selectedIds.has(node.id) ? ' card__check--on' : ''}`}
                    aria-hidden="true"
                  >
                    {selectedIds.has(node.id) ? '✓' : ''}
                  </span>
                </span>
                <span className="card__title">{node.title || hostnameOf(node.url)}</span>
                <span className="card__meta">{hostnameOf(node.url)}</span>
              </button>
            ) : (
              <a
                key={node.id}
                className="card"
                data-nav=""
                href={node.url}
                title={node.url}
                onClick={(event) => {
                  event.preventDefault();
                  open(node.url, event.ctrlKey || event.metaKey);
                }}
                {...contextMenuHandlers(({ x, y }) => {
                  setMenu({ node, x, y });
                })}
              >
                <span className="card__thumb">
                  <Thumb url={node.url} hostname={hostnameOf(node.url)} />
                </span>
                <span className="card__title">{node.title || hostnameOf(node.url)}</span>
                <span className="card__meta">{hostnameOf(node.url)}</span>
              </a>
            ),
          )}
        </div>
      )}

      {menu !== null ? (
        <RowMenu
          target={menu}
          // 「移入隱私空間」需要金鑰，所以解鎖後才提供
          canMoveToVault={vaultUnlocked && !showingRoots}
          onClose={() => {
            setMenu(null);
          }}
          onOpen={(url, newTab) => {
            open(url, !newTab);
          }}
          onMoveToVault={(node) => {
            setPendingMove({ nodes: [node], x: menu.x, y: menu.y });
          }}
          onChanged={reload}
          onNotice={setNotice}
        />
      ) : null}

      {folderPicker !== null ? (
        <FolderPicker
          x={folderPicker.x}
          y={folderPicker.y}
          heading={tn('picker_move_many', selectedNodes.length)}
          onClose={() => {
            setFolderPicker(null);
          }}
          onPick={(parentId) => {
            const ids = selectedNodes.map((node) => node.id);
            setFolderPicker(null);
            exitSelection();
            void request('bookmarks/move-many', { ids, parentId }).then(
              (report) => {
                setNotice(
                  report.failed === 0
                    ? t('moved_bookmarks', tn('unit_bookmarks', report.moved))
                    : t('moved_bookmarks_with_failures', tn('unit_bookmarks', report.moved), tn('unit_failed', report.failed)),
                );
                reload();
              },
              (cause: unknown) => {
                setNotice(cause instanceof Error ? cause.message : String(cause));
              },
            );
          }}
        />
      ) : null}

      {optionsMenu !== null && settings !== null ? (
        <PreviewOptionsMenu
          x={optionsMenu.x}
          y={optionsMenu.y}
          previewSource={settings.previewSource}
          onPreviewSourceChange={(previewSource) => {
            update({ previewSource });
          }}
          canBackfill={permissionGranted}
          backfillBusy={backfill.busy}
          // 站在隱私空間要抓的是隱私書籤（加密寫入），不是一般書籤
          backfillKind={mode === 'vault' ? 'vault/backfill' : 'thumbs/backfill'}
          onBackfill={backfill.start}
          onClose={() => {
            setOptionsMenu(null);
          }}
        />
      ) : null}

      {vaultFolderPicker !== null ? (
        <VaultFolderPicker
          x={vaultFolderPicker.x}
          y={vaultFolderPicker.y}
          folders={vault.folders}
          heading={tn('picker_move_many', vaultSelectedIds.size)}
          // 勾選中的資料夾（連同子樹）不是合法目標：搬進自己的子樹會造成環狀
          excludeIds={[...vaultSelectedIds].filter((id) =>
            vault.folders.some((folder) => folder.id === id),
          )}
          onClose={() => {
            setVaultFolderPicker(null);
          }}
          onPick={(folderId) => {
            const ids = [...vaultSelectedIds];
            setVaultFolderPicker(null);
            exitSelection();
            void request('vault/move-many', { ids, folderId }).then(
              (report) => {
                setNotice(
                  report.failed === 0
                    ? t('moved_items', tn('unit_items', report.done))
                    : t('moved_items_with_failures', tn('unit_items', report.done), tn('unit_failed', report.failed)),
                );
                void vault.reload();
              },
              (cause: unknown) => {
                setNotice(cause instanceof Error ? cause.message : String(cause));
              },
            );
          }}
        />
      ) : null}

      {exportPicker !== null ? (
        <FolderPicker
          x={exportPicker.x}
          y={exportPicker.y}
          heading={tn('picker_export_many', exportPicker.ids.length)}
          onClose={() => {
            setExportPicker(null);
          }}
          onPick={(parentId) => {
            const ids = exportPicker.ids;
            setExportPicker(null);
            exitSelection();
            void request('vault/export-many', { ids, parentId }).then(
              (report) => {
                setNotice(
                  // 「項目」而不是「書籤」：一個項目可能是整個資料夾（連同子樹）
                  report.failed === 0
                    ? t('exported_items', tn('unit_items', report.done))
                    : t('exported_items_with_failures', tn('unit_items', report.done), tn('unit_failed', report.failed)),
                );
                reload();
              },
              (cause: unknown) => {
                setNotice(cause instanceof Error ? cause.message : String(cause));
              },
            );
          }}
        />
      ) : null}

      {pendingMove !== null ? (
        <MoveInPrompt
          nodes={pendingMove.nodes}
          x={pendingMove.x}
          y={pendingMove.y}
          onCancel={() => {
            setPendingMove(null);
          }}
          onConfirm={(purgeHistory) => {
            const ids = pendingMove.nodes.map((node) => node.id);
            setPendingMove(null);
            exitSelection();
            const first = ids[0];
            if (ids.length === 1 && first !== undefined) {
              void vault.moveIn(first, purgeHistory).then(setNotice);
              return;
            }
            void vault.moveInMany(ids, purgeHistory).then(setNotice);
          }}
        />
      ) : null}

      {vaultPrompt ? (
        <VaultPrompt
          state={vault.state ?? { status: 'absent' }}
          error={vault.error}
          onClose={() => {
            setVaultPrompt(false);
            vault.clearError();
          }}
          onCreate={vault.create}
          onCreated={() => {
            setVaultPrompt(false);
            go({ mode: 'vault', folderId: vaultFolderId });
          }}
          onUnlockWithRecoveryKey={(code) => {
            void vault.unlockWithRecoveryKey(code).then((ok) => {
              if (ok) {
                setVaultPrompt(false);
                go({ mode: 'vault', folderId: vaultFolderId });
              }
            });
          }}
          onUnlock={(password) => {
            void vault.unlock(password).then((ok) => {
              if (ok) {
                setVaultPrompt(false);
                go({ mode: 'vault', folderId: vaultFolderId });
              }
            });
          }}
        />
      ) : null}

      {vaultMenu !== null ? (
        <VaultRowMenu
          target={vaultMenu}
          folders={vault.folders}
          onClose={() => {
            setVaultMenu(null);
          }}
          onOpen={(url, newTab) => {
            open(url, !newTab);
          }}
          onMoveOut={(id) => {
            void vault.moveOut(id);
          }}
          onExportTo={(id, x, y) => {
            setExportPicker({ x, y, ids: [id] });
          }}
          onRemove={(id) => {
            void vault.remove(id);
          }}
          onMoveToFolder={(id, target) => {
            void vault.moveToFolder(id, target);
          }}
          onMoveFolder={(id, parentId) => {
            void vault.moveFolder(id, parentId);
          }}
          onRenameFolder={(id, name) => {
            void vault.renameFolder(id, name);
          }}
          onDeleteFolder={(id) => {
            void vault.deleteFolder(id);
          }}
          onChanged={() => {
            void vault.reload();
          }}
          onNotice={setNotice}
        />
      ) : null}

    </div>
  );
}
