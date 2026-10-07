import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { request } from '@/shared/messages';
import type { BookmarkNode, PrivateBookmark, PrivateFolder } from '@/shared/types';
import {
  folderColumns,
  vaultChildId,
  vaultChildren,
  vaultGroupOf,
  vaultGroups,
  type VaultChild,
} from '@/shared/vault-layout';
import { buildBoard, labelCell, labels, membersInOrder, type Board, type GridOp } from '@/shared/board';
import { MAX_COLUMNS, MIN_COLUMNS, navCell, outlineEdges, stepCell, type Direction } from '@/shared/grid';
import type { GroupInfo } from '@/shared/groups';
import { hostnameOf } from '@/shared/url';
import { matchesVaultTrigger } from '@/shared/vault-entry';
import { Breadcrumb } from '../sidebar/components/Breadcrumb';
import { FolderPicker } from '../sidebar/components/FolderPicker';
import { MergeMenu } from '../sidebar/components/MergeMenu';
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
import { useGridDrag } from './useGridDrag';
import { GroupTag } from './GroupTag';
import { GroupMenu } from './GroupMenu';
import { TagPrompt } from '../sidebar/components/TagItems';
import { useBookmarkGrid } from '../sidebar/hooks/useBookmarkGrid';

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

/** 隱私空間的資料夾與書籤在畫面上是同一份清單（順序由版面決定，見 `vaultChildren`） */
type VaultGridRow = VaultChild<PrivateFolder, PrivateBookmark>;

const NO_SELECTION: ReadonlySet<string> = new Set();

/** Ctrl+Shift+方向鍵 → 格子的方向（挪卡片、或在標籤上整組挪） */
const DIRECTION: Partial<Record<string, Direction>> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

/** 挪動之後要把焦點放回去的那個元素（卡片或標籤），與它挪動前所在的格子 */
interface Refocus {
  selector: string;
  from: number;
  until: number;
}

interface GroupMenuState {
  space: Mode;
  group: GroupInfo;
  x: number;
  y: number;
}

interface TagPromptState {
  space: Mode;
  ids: string[];
  current: string;
  x: number;
  y: number;
}

/** 合併選單：兩張卡片疊在一起之後要問的事 */
interface PendingMerge {
  space: Mode;
  targetId: string;
  ids: string[];
  x: number;
  y: number;
}

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
  const [merge, setMerge] = useState<PendingMerge | null>(null);
  const [groupMenu, setGroupMenu] = useState<GroupMenuState | null>(null);
  const [tagPrompt, setTagPrompt] = useState<TagPromptState | null>(null);
  const liveGrid = useBookmarkGrid(folderId);
  /** 拖拽中。拖拽期間資料凍結（見下面的 `frozen`） */
  const [dragging, setDragging] = useState(false);
  const [pendingMove, setPendingMove] = useState<{
    nodes: BookmarkNode[];
    x: number;
    y: number;
  } | null>(null);

  // 兩個網格的容器。由元件持有而不是各自的 hook 建，因為欄數與虛擬滾動
  // 要量同一個元素，而欄數又是虛擬滾動的輸入
  const gridRef = useRef<HTMLDivElement>(null);
  const vaultGridRef = useRef<HTMLDivElement>(null);
  // 欄數量的是外面那層橫向捲動的容器：定下來的格子比視窗寬時，網格本身會比它寬
  const gridScrollRef = useRef<HTMLDivElement>(null);
  const vaultScrollRef = useRef<HTMLDivElement>(null);

  /*
   * 拖拽期間畫面用的是**開始拖之前**的資料。
   *
   * 書籤或隱私空間在拖拽中途變動（另一個分頁、同步合併）會讓網格重繪，被拖的那張卡片
   * 可能因此被拆掉 —— 那之後 drop／dragend 都送不到，拖拽卡在半空。放開之後才換成
   * 最新的資料，中間錯過的變動一次補上。
   */
  const frozen = useRef({
    roots,
    grid: liveGrid,
    bookmarks: vault.bookmarks,
    folders: vault.folders,
    layout: vault.layout,
  });
  if (!dragging) {
    frozen.current = {
      roots,
      grid: liveGrid,
      bookmarks: vault.bookmarks,
      folders: vault.folders,
      layout: vault.layout,
    };
  }
  const view = frozen.current;
  const viewRoots = view.roots;

  const index = useMemo(() => buildIndex(viewRoots ?? []), [viewRoots]);
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
  const search = trimmed === '' ? null : searchLinks(viewRoots ?? [], trimmed);
  const nodes: BookmarkNode[] =
    search !== null ? search.links : (currentFolder?.children ?? viewRoots ?? []);

  // 勾選跨資料夾保留，所以要從整棵樹的索引還原成節點，並濾掉已不存在的 id
  const selectedNodes: BookmarkNode[] = [...selectedIds]
    .map((id) => index.byId.get(id))
    .filter((node): node is BookmarkNode => node !== undefined);

  // 資料夾整棵一起移入，所以送的是 selectedNodes；這個數字只用來判斷有沒有東西可移
  const selectedLinkCount = countLinks(selectedNodes);

  const vaultFolders: PrivateFolder[] = view.folders.filter(
    (folder) => folder.parentId === vaultFolderId,
  );
  const vaultBookmarks: PrivateBookmark[] = view.bookmarks.filter(
    (record) => record.folderId === vaultFolderId,
  );

  /*
   * 隱私空間的資料夾與書籤合成一份陣列 —— 虛擬滾動的切片索引要橫跨兩者。
   */
  /* 每個隱私資料夾直接裝了幾個書籤，掃一次建表 —— 原本是每張卡片各自
     filter 整份清單，也就是「資料夾數 × 書籤數」次比對，而且每次重繪都重算 */
  const vaultCountIn = new Map<string, number>();
  for (const record of view.bookmarks) {
    if (record.folderId !== null) {
      vaultCountIn.set(record.folderId, (vaultCountIn.get(record.folderId) ?? 0) + 1);
    }
  }

  const vaultRows: VaultGridRow[] = vaultChildren(view.folders, view.bookmarks, vaultFolderId, view.layout);

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

  /*
   * 版面（第 3 期改版）。每個資料夾的版面是一個 `Board`（`shared/board.ts`）：卡片緊密排列，
   * 欄數跟著視窗，除非使用者按 − / + 定下來。群組是順序上連續的一段，畫成框。
   * 搜尋結果與最上層（Firefox 的永久資料夾）沒有群組，只是照順序排。
   *
   * 能拖的畫面在最後一張之後多畫一個空位，當作「放到最後」的落點。
   */
  const inFolderView = search === null && currentFolder !== undefined;
  const columns = useGridColumns(gridScrollRef, size, GRID_GAP);
  const bookmarkGroupOf = new Map(
    (view.grid ?? null)?.groups.flatMap((group) => group.members.map((member) => [member, group.id] as const)) ?? [],
  );
  const bookmarkBoard: Board = buildBoard({
    stored:
      inFolderView && view.grid != null && view.grid.columns > 0
        ? { columns: view.grid.columns, cells: nodes.map((node) => node.id) }
        : null,
    fixed: inFolderView && (view.grid?.columns ?? 0) > 0,
    children: nodes.map((node) => node.id),
    autoColumns: columns,
    groups: inFolderView ? (view.grid?.groups ?? []).map(({ id, name, color }) => ({ id, name, color })) : [],
    groupOf: (id) => bookmarkGroupOf.get(id) ?? null,
  });
  // 版面還在讀：先不畫，免得先畫一次沒有群組、欄數不對的再跳一下
  const bookmarkGridLoading = inFolderView && view.grid === undefined;
  const bookmarkCols = bookmarkBoard.grid.columns;
  const bookmarkCellCount = bookmarkBoard.grid.cells.length + (inFolderView ? 1 : 0);
  const gridRows = useVirtualRows({
    count: bookmarkCellCount,
    columns: bookmarkCols,
    estimate: cardEstimate(size),
    resetKey: `${listKey}/${String(size)}/${String(selecting)}/${String(bookmarkCols)}`,
    ref: gridRef,
    item: '.cell',
  });
  const nav = useListNav(
    {
      onLeave: upBookmarks,
      virtual: {
        start: gridRows.start,
        count: bookmarkCellCount,
        columns: bookmarkCols,
        scrollToIndex: gridRows.scrollToIndex,
        cells: { nav: (key, at) => navCell(bookmarkBoard.grid, at, key) },
      },
    },
    gridRef,
  );

  const vaultColumns = useGridColumns(vaultScrollRef, size, GRID_GAP);
  const vaultBoard: Board = buildBoard({
    stored: (() => {
      const fixed = folderColumns(view.layout, vaultFolderId);
      return fixed === null ? null : { columns: fixed, cells: vaultRows.map(vaultChildId) };
    })(),
    fixed: folderColumns(view.layout, vaultFolderId) !== null,
    children: vaultRows.map(vaultChildId),
    autoColumns: vaultColumns,
    groups: vaultGroups(view.layout, vaultFolderId),
    groupOf: vaultGroupOf(view.layout),
  });
  const vaultCols = vaultBoard.grid.columns;
  const vaultCellCount = vaultBoard.grid.cells.length + 1;
  const vaultGrid = useVirtualRows({
    count: vaultCellCount,
    columns: vaultCols,
    estimate: cardEstimate(size),
    resetKey: `${vaultFolderId ?? 'root'}/${String(size)}/${String(vaultSelecting)}/${String(vaultCols)}`,
    ref: vaultGridRef,
    item: '.cell',
  });
  const vaultNav = useListNav(
    {
      onLeave: upVault,
      virtual: {
        start: vaultGrid.start,
        count: vaultCellCount,
        columns: vaultCols,
        scrollToIndex: vaultGrid.scrollToIndex,
        cells: { nav: (key, at) => navCell(vaultBoard.grid, at, key) },
      },
    },
    vaultGridRef,
  );

  // 隱密模式下只有解鎖後才顯示切換，否則這個頁面完全沒有隱私空間的痕跡
  const showModes = settings?.vaultEntry === 'tab' || vaultUnlocked;
  // 根層列的是 Firefox 內建的永久資料夾，移入對它們一定失敗（理由同側邊欄）
  const showingRoots = search === null && currentFolder === undefined;

  /*
   * 拖拽與版面操作（兩個網格各一份）。
   *
   * 書籤這邊：搜尋結果的順序沒有意義、最上層是 Firefox 的永久資料夾，兩者都不能拖。
   * 落點一律是格子的索引；怎麼擠、誰加入哪個群組由背景頁照 `shared/board.ts` 算 ——
   * 畫面送的是「做什麼」，不是算好的結果，背景頁那邊的資料才是最新的。
   */
  const canDragBookmarks = inFolderView;
  const vaultRowById = new Map(vaultRows.map((row) => [vaultChildId(row), row]));

  const reportFailure = (cause: unknown): void => {
    setNotice(cause instanceof Error ? cause.message : String(cause));
  };

  /** 書籤這邊的一連串請求做完再重讀；任一步失敗就停下並說出來 */
  const applyBookmarks = (work: () => Promise<void>): void => {
    void work().then(reload, (cause: unknown) => {
      reportFailure(cause);
      reload();
    });
  };

  /** 拖進資料夾或麵包屑。整批搬完就退出多選（與「移動到…」一致） */
  const moveBookmarks = (ids: string[], parentId: string): void => {
    if (ids.length > 1) {
      exitSelection();
    }
    applyBookmarks(async () => {
      const report = await request('bookmarks/reorder', { ids, parentId, beforeId: null });
      if (report.failed > 0) {
        setNotice(
          t('moved_bookmarks_with_failures', tn('unit_bookmarks', report.moved), tn('unit_failed', report.failed)),
        );
      }
    });
  };

  const moveVault = (ids: string[], target: string | null): void => {
    if (ids.length > 1) {
      exitSelection();
    }
    void vault.reorder(ids, target, null);
  };

  const boardOf = (space: Mode): Board => (space === 'vault' ? vaultBoard : bookmarkBoard);

  /** 一個版面操作。`columns` 是畫面現在的欄數：還沒定下來的資料夾就用它定下來 */
  const gridOp = (space: Mode, op: GridOp): void => {
    if (space === 'vault') {
      void vault.gridApply(vaultFolderId, vaultColumns, op);
      return;
    }
    if (currentFolder === undefined) {
      return;
    }
    const parentId = currentFolder.id;
    applyBookmarks(async () => {
      await request('grid/apply', { folderId: parentId, columns, op });
    });
  };

  /** 兩個網格共用的那一半拖拽回呼 */
  const dragSpace = (space: Mode) => ({
    cells: boardOf(space).grid.cells,
    onDragChange: setDragging,
    onPlace: (ids: string[], at: number, aimed: string | null) => {
      if (ids.length > 1) {
        exitSelection();
      }
      gridOp(space, { kind: 'place', ids, at, aimed });
    },
    onMerge: (targetId: string, ids: string[], x: number, y: number) => {
      const board = boardOf(space);
      const at = board.grid.cells.indexOf(targetId);
      if (board.memberOf.has(targetId) && at !== -1) {
        // 疊到已在群組裡的卡片 = 放到它旁邊、加入那個群組，不跳選單
        gridOp(space, {
          kind: 'place',
          ids,
          at: at + 1,
          aimed: targetId,
        });
        return;
      }
      setMerge({ space, targetId, ids, x, y });
    },
    onMoveGroup: (groupId: string, at: number) => {
      gridOp(space, { kind: 'move-group', groupId, at });
    },
  });

  const bookmarkDrag = useGridDrag({
    ...dragSpace('bookmarks'),
    enabled: canDragBookmarks && !bookmarkGridLoading,
    kindOf: (id) => {
      const node = index.byId.get(id);
      return node === undefined ? undefined : node.kind === 'folder' ? 'folder' : 'bookmark';
    },
    selected: selecting ? selectedIds : NO_SELECTION,
    linkOf: (id) => {
      const node = index.byId.get(id);
      return node?.kind === 'link' ? { url: node.url, title: node.title } : null;
    },
    onInto: (ids, target) => {
      // 原生書籤的最上層只能放 Firefox 的永久資料夾，麵包屑的「全部」不接受拖放
      if (target === null || currentFolder === undefined || target === currentFolder.id) {
        return;
      }
      moveBookmarks(ids, target);
    },
    onGroupInto: (groupId, target) => {
      if (target === null || currentFolder === undefined || target === currentFolder.id) {
        return;
      }
      const fromFolderId = currentFolder.id;
      applyBookmarks(async () => {
        await request('groups/move', { fromFolderId, groupId, toFolderId: target, columns });
      });
    },
  });

  const vaultDrag = useGridDrag({
    ...dragSpace('vault'),
    enabled: mode === 'vault',
    kindOf: (id) => vaultRowById.get(id)?.kind,
    selected: vaultSelecting ? vaultSelectedIds : NO_SELECTION,
    // 隱私書籤永遠不帶網址：拖到分頁列會在一般視窗打開、寫進瀏覽記錄
    linkOf: () => null,
    onInto: (ids, target) => {
      if (target !== vaultFolderId) {
        moveVault(ids, target);
      }
    },
    onGroupInto: (groupId, target) => {
      if (target !== vaultFolderId) {
        void vault.groupMove(groupId, target, vaultColumns);
      }
    },
  });

  /*
   * 鍵盤挪動（拖拽做得到的事鍵盤也要做得到）：卡片往某個方向挪一格（目標空就放、有卡片就互換），
   * 標籤上是整組挪一格。卡片的 DOM 換了位置焦點會掉，所以記下要放回去的元素，等它真的
   * 換到別的格子之後再聚焦（見下面的 effect）。
   */
  const refocusRef = useRef<Refocus | null>(null);
  useEffect(() => {
    const pending = refocusRef.current;
    if (pending === null) {
      return;
    }
    if (Date.now() > pending.until) {
      refocusRef.current = null;
      return;
    }
    const element = document.querySelector<HTMLElement>(pending.selector);
    const cell = element?.closest<HTMLElement>('[data-cell]');
    if (element !== null && cell !== null && cell !== undefined && Number(cell.dataset.cell) !== pending.from) {
      refocusRef.current = null;
      element.focus();
    }
  });

  const cardSelector = (id: string): string => {
    const key = CSS.escape(id);
    return `[data-drag-id="${key}"][data-nav], [data-drag-id="${key}"] [data-nav]`;
  };

  /** 卡片往某個方向挪一格。null = 這個方向出界了、或這個畫面不能排 */
  const nudger = (space: Mode, id: string, direction: Direction): (() => void) | null => {
    if (space === 'bookmarks' && !canDragBookmarks) {
      return null;
    }
    const board = boardOf(space);
    const at = board.grid.cells.indexOf(id);
    if (at === -1 || stepCell(board.grid, at, direction) === null) {
      return null;
    }
    return () => {
      refocusRef.current = { selector: cardSelector(id), from: at, until: Date.now() + 3000 };
      gridOp(space, { kind: 'nudge', id, direction });
    };
  };

  /** 標籤上：整段往前／往後挪（跨過一張、或跨過整個相鄰的群組），上下是跨一列 */
  const groupNudger = (space: Mode, groupId: string, direction: Direction): (() => void) | null => {
    const board = boardOf(space);
    const at = labelCell(board, groupId);
    const members = membersInOrder(board, groupId);
    const last = at + members.length - 1;
    const blocked =
      direction === 'left' || direction === 'up' ? at <= 0 : last >= board.grid.cells.length - 1;
    if (at === -1 || blocked) {
      return null;
    }
    return () => {
      refocusRef.current = {
        selector: `[data-group-label="${CSS.escape(groupId)}"]`,
        from: at,
        until: Date.now() + 3000,
      };
      gridOp(space, { kind: 'nudge-group', groupId, direction });
    };
  };

  /** Ctrl+Shift+方向鍵挪動焦點所在的卡片或群組；其餘的鍵交給方向鍵巡覽 */
  const gridKeys =
    (space: Mode, fallback: (event: ReactKeyboardEvent<HTMLDivElement>) => void) =>
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      const direction = DIRECTION[event.key];
      if (event.ctrlKey && event.shiftKey && direction !== undefined) {
        event.preventDefault();
        const target = event.target as HTMLElement;
        const label = target.closest<HTMLElement>('[data-group-label]')?.dataset.groupLabel;
        if (label !== undefined) {
          groupNudger(space, label, direction)?.();
          return;
        }
        const id = target.closest<HTMLElement>('[data-drag-id]')?.dataset.dragId;
        if (id !== undefined) {
          nudger(space, id, direction)?.();
        }
        return;
      }
      fallback(event);
    };

  // 合併選單貼著卡片；捲動之後那張卡片已經不在原處（甚至被虛擬滾動卸載了），就關掉
  useEffect(() => {
    if (merge === null) {
      return;
    }
    const close = (): void => {
      setMerge(null);
    };
    window.addEventListener('scroll', close, { passive: true });
    return () => {
      window.removeEventListener('scroll', close);
    };
  }, [merge]);

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

  /**
   * 多選之後「框成群組」：勾的要是這個資料夾裡上下左右相連的書籤（不相連時背景頁拒絕並說明）。
   * 別的資料夾勾的不算在內 —— 群組綁在資料夾上。
   */
  const frameAction = (space: Mode, picked: ReadonlySet<string>): SelectionAction => {
    const board = boardOf(space);
    const ids = board.grid.cells.filter((id) => picked.has(id));
    return {
      label: t('grid_frame'),
      title: t('grid_frame_hint'),
      disabled: ids.length === 0 || (space === 'bookmarks' && !canDragBookmarks),
      onPick: () => {
        exitSelection();
        gridOp(space, { kind: 'frame', ids });
      },
    };
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
          frameAction('vault', vaultSelectedIds),
        ]
      : [
          {
            label: t('action_move_to'),
            primary: true,
            onPick: (x, y) => {
              setFolderPicker({ x, y });
            },
          },
          ...(canDragBookmarks ? [frameAction('bookmarks', selectedIds)] : []),
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
  /** 工具列的欄數控制看的是哪一份版面（搜尋結果與最上層沒有） */
  const layoutBoard: Board | null = mode === 'vault' ? vaultBoard : canDragBookmarks ? bookmarkBoard : null;
  // 定下來的格子：固定欄數、卡片固定寬度（放不下就橫向捲動）
  const gridStyleFor = (board: Board): CSSProperties =>
    board.fixed ? ({ ...gridStyle, '--grid-cols': String(board.grid.columns) } as CSSProperties) : gridStyle;
  const gridClass = (board: Board): string =>
    `grid${board.fixed ? ' grid--fixed' : ''}${dragging ? ' grid--dragging' : ''}`;

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
  const bookmarkCard = (node: BookmarkNode) =>
    node.kind === 'folder' ? (
      // 多選中點卡片是勾選（與書籤卡片一致），巡覽移到角落的箭頭。
      // 兩個動作各有自己的目標：資料夾不能點進去就沒得跨資料夾挑選，
      // 但「點資料夾卻只是進去、選不到它」也同樣不合直覺。
      <div
        key={node.id}
        className={`card-wrap${selecting && selectedIds.has(node.id) ? ' card-wrap--selected' : ''}`}
        {...bookmarkDrag.cardProps(node.id)}
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
        {...bookmarkDrag.cardProps(node.id)}
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
        className={`card`}
        {...bookmarkDrag.cardProps(node.id)}
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
    );

  /** 群組標籤選單的動作，兩個空間各接各的訊息 */
  const groupCall = (
    space: Mode,
    groupId: string,
    action: { kind: 'update'; name?: string; color?: number } | { kind: 'dissolve' } | { kind: 'to-folder' },
  ): void => {
    if (action.kind === 'update') {
      gridOp(space, {
        kind: 'group-update',
        groupId,
        ...(action.name === undefined ? {} : { name: action.name }),
        ...(action.color === undefined ? {} : { color: action.color }),
      });
      return;
    }
    if (action.kind === 'dissolve') {
      gridOp(space, { kind: 'dissolve', groupId });
      return;
    }
    if (space === 'vault') {
      void vault.groupToFolder(groupId, vaultColumns);
      return;
    }
    if (currentFolder === undefined) {
      return;
    }
    const parentId = currentFolder.id;
    applyBookmarks(async () => {
      await request('groups/to-folder', { folderId: parentId, groupId, columns });
    });
  };

  /** 右鍵選單的「設定 tag…」「移出群組」 */
  const tagActions = (space: Mode, id: string) => {
    const board = boardOf(space);
    const groupId = board.memberOf.get(id) ?? null;
    const name = board.groups.find((group) => group.id === groupId)?.name ?? '';
    return {
      onSetTag: (x: number, y: number) => {
        setTagPrompt({ space, ids: [id], current: name, x, y });
      },
      onLeave:
        groupId === null
          ? null
          : () => {
              gridOp(space, { kind: 'untag', ids: [id] });
            },
    };
  };

  const bookmarkTagActions = (node: BookmarkNode) => ({
    ...tagActions('bookmarks', node.id),
    // 「攤平成群組」：子資料夾裡還有資料夾時不提供（那些資料夾沒有地方放）
    onFlatten:
      node.kind !== 'folder'
        ? undefined
        : node.children.some((child) => child.kind === 'folder')
          ? null
          : () => {
              applyBookmarks(async () => {
                await request('groups/flatten', { folderId: node.id, columns });
              });
            },
  });

  const vaultTagActions = (target: VaultMenuTarget) => {
    if (target.kind === 'folder') {
      const folder = target.folder;
      return {
        onSetTag: () => undefined,
        onLeave: null,
        onFlatten: view.folders.some((candidate) => candidate.parentId === folder.id)
          ? null
          : () => {
              void vault.groupFlatten(folder.id, vaultColumns);
            },
      };
    }
    return tagActions('vault', target.record.id);
  };

  /**
   * 畫出虛擬滾動範圍內的格子。
   *
   * 每一格是一個 `.cell`（`data-cell` = 格子索引，拖拽與方向鍵都認它）。群組的框線畫在格子上
   * （`cell--g` + 要畫的那幾邊 `e-t/r/b/l`，見 `outlineEdges`），名稱標籤放在第一個成員那一格。
   */
  const gridCells = (
    space: Mode,
    board: Board,
    win: { start: number; end: number },
    render: (id: string) => ReactNode,
  ): ReactNode[] => {
    const drag = space === 'vault' ? vaultDrag : bookmarkDrag;
    const edges = outlineEdges(board.grid, (id) => board.memberOf.get(id) ?? null);
    const groupById = new Map(board.groups.map((group) => [group.id, group]));
    const tags = labels(board);
    const out: ReactNode[] = [];
    for (let at = win.start; at < win.end; at += 1) {
      const id = board.grid.cells[at];
      if (id === undefined) {
        out.push(<div key={`slot:${String(at)}`} className={`cell cell--empty${drag.dropClass(at)}`} data-cell={at} />);
        continue;
      }
      const edge = edges.get(at);
      const group = groupById.get(board.memberOf.get(id) ?? '');
      const outline =
        edge === undefined || group === undefined
          ? ''
          : ` cell--g group-c${String(group.color)}${edge.top ? ' e-t' : ''}${edge.right ? ' e-r' : ''}${edge.bottom ? ' e-b' : ''}${edge.left ? ' e-l' : ''}`;
      const tag = tags.get(at);
      out.push(
        <div key={id} className={`cell${outline}${drag.dropClass(at)}`} data-cell={at}>
          {render(id)}
          {tag !== undefined ? (
            <GroupTag
              group={tag}
              drag={drag.labelProps(tag.id)}
              onMenu={(x, y) => {
                setGroupMenu({ space, group: tag, x, y });
              }}
            />
          ) : null}
        </div>,
      );
    }
    return out;
  };

  const vaultFolderCard = (folder: PrivateFolder) => (
    // 多選中點卡片是勾選，巡覽移到角落的箭頭（與側邊欄同一套規則）
    <div
      key={folder.id}
      className={`card-wrap${vaultSelectedIds.has(folder.id) ? ' card-wrap--selected' : ''}`}
      {...vaultDrag.cardProps(folder.id)}
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
        {...vaultDrag.cardProps(record.id)}
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
        className={`card`}
        {...vaultDrag.cardProps(record.id)}
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

        {layoutBoard !== null ? (
          // 欄數：平常跟著視窗（自動）；按 − / + 就定下來，「恢復自動排列」放開
          <div className="grid-cols" role="group" aria-label={t('grid_columns')}>
            <button
              type="button"
              className="toolbar__action toolbar__action--icon"
              aria-label={t('grid_columns_less')}
              title={t('grid_columns_less')}
              disabled={layoutBoard.grid.columns <= MIN_COLUMNS}
              onClick={() => {
                gridOp(mode, { kind: 'columns', columns: layoutBoard.grid.columns - 1 });
              }}
            >
              −
            </button>
            <span className="grid-cols__value">
              {layoutBoard.fixed
                ? t('grid_columns_n', String(layoutBoard.grid.columns))
                : t('grid_columns_auto', String(layoutBoard.grid.columns))}
            </span>
            <button
              type="button"
              className="toolbar__action toolbar__action--icon"
              aria-label={t('grid_columns_more')}
              title={t('grid_columns_more')}
              disabled={layoutBoard.grid.columns >= MAX_COLUMNS}
              onClick={() => {
                gridOp(mode, { kind: 'columns', columns: layoutBoard.grid.columns + 1 });
              }}
            >
              +
            </button>
            {layoutBoard.fixed ? (
              <button
                type="button"
                className="toolbar__action"
                title={t('grid_auto_hint')}
                onClick={() => {
                  gridOp(mode, { kind: 'auto' });
                }}
              >
                {t('grid_auto')}
              </button>
            ) : null}
          </div>
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
            drop={{ props: (id) => vaultDrag.crumbProps(id, true), className: vaultDrag.crumbClass }}
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
            drop={
              canDragBookmarks
                ? {
                    // 「全部」那一層只能放 Firefox 的永久資料夾，不接受拖放
                    props: (id) => bookmarkDrag.crumbProps(id, id !== null),
                    className: bookmarkDrag.crumbClass,
                  }
                : undefined
            }
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
          <div className="grid-scroll" ref={vaultScrollRef}>
            <div
              ref={vaultGridRef}
              onKeyDown={gridKeys('vault', vaultNav.onKeyDown)}
              {...vaultDrag.gridProps}
              className={gridClass(vaultBoard)}
              style={{ ...gridStyleFor(vaultBoard), paddingTop: vaultGrid.padTop, paddingBottom: vaultGrid.padBottom }}
            >
              {gridCells('vault', vaultBoard, vaultGrid, (id) => {
                const row = vaultRowById.get(id);
                return row === undefined
                  ? null
                  : row.kind === 'folder'
                    ? vaultFolderCard(row.folder)
                    : vaultBookmarkCard(row.record);
              })}
            </div>
          </div>
        )
      ) : roots === null ? (
        <p className="empty">{t('bookmarks_loading')}</p>
      ) : nodes.length === 0 ? (
        <p className="empty">{search !== null ? t('search_no_match') : t('folder_no_bookmarks')}</p>
      ) : (
        <div className="grid-scroll" ref={gridScrollRef}>
          {bookmarkGridLoading ? null : (
            <div
              ref={gridRef}
              onKeyDown={gridKeys('bookmarks', nav.onKeyDown)}
              {...bookmarkDrag.gridProps}
              className={gridClass(bookmarkBoard)}
              // 墊高用 padding：網格用空 div 佔位還得跨滿整列，padding 沒有這個問題
              style={{ ...gridStyleFor(bookmarkBoard), paddingTop: gridRows.padTop, paddingBottom: gridRows.padBottom }}
            >
              {gridCells('bookmarks', bookmarkBoard, gridRows, (id) => {
                const node = index.byId.get(id);
                return node === undefined ? null : bookmarkCard(node);
              })}
            </div>
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
          reorder={
            canDragBookmarks
              ? { earlier: nudger('bookmarks', menu.node.id, 'left'), later: nudger('bookmarks', menu.node.id, 'right') }
              : undefined
          }
          tag={canDragBookmarks ? bookmarkTagActions(menu.node) : undefined}
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

      {groupMenu !== null ? (
        <GroupMenu
          group={groupMenu.group}
          x={groupMenu.x}
          y={groupMenu.y}
          reorder={{
            earlier: groupNudger(groupMenu.space, groupMenu.group.id, 'left'),
            later: groupNudger(groupMenu.space, groupMenu.group.id, 'right'),
          }}
          onClose={() => {
            setGroupMenu(null);
          }}
          onRename={(name) => {
            groupCall(groupMenu.space, groupMenu.group.id, { kind: 'update', name });
          }}
          onColor={(color) => {
            groupCall(groupMenu.space, groupMenu.group.id, { kind: 'update', color });
          }}
          onDissolve={() => {
            groupCall(groupMenu.space, groupMenu.group.id, { kind: 'dissolve' });
          }}
          onToFolder={() => {
            groupCall(groupMenu.space, groupMenu.group.id, { kind: 'to-folder' });
          }}
        />
      ) : null}

      {tagPrompt !== null ? (
        <TagPrompt
          x={tagPrompt.x}
          y={tagPrompt.y}
          current={tagPrompt.current}
          names={boardOf(tagPrompt.space)
            .groups.map((group) => group.name)
            .filter((name) => name !== '')}
          onClose={() => {
            setTagPrompt(null);
          }}
          onSubmit={(name) => {
            gridOp(tagPrompt.space, { kind: 'tag', ids: tagPrompt.ids, name });
          }}
        />
      ) : null}

      {merge !== null ? (
        <MergeMenu
          x={merge.x}
          y={merge.y}
          onClose={() => {
            setMerge(null);
          }}
          onCreateGroup={
            // 群組是「一段書籤」：拖的或被疊上去的是資料夾時只能建資料夾
            [merge.targetId, ...merge.ids].every((id) =>
              merge.space === 'vault' ? vaultRowById.get(id)?.kind === 'bookmark' : index.byId.get(id)?.kind === 'link',
            )
              ? () => {
                  const { space, targetId, ids } = merge;
                  if (ids.length > 1) {
                    exitSelection();
                  }
                  gridOp(space, { kind: 'merge-group', targetId, ids });
                }
              : undefined
          }
          onCreateFolder={(name) => {
            const { space, targetId, ids } = merge;
            if (ids.length > 1) {
              exitSelection();
            }
            if (space === 'vault') {
              void vault.mergeIntoFolder(targetId, ids, name);
              return;
            }
            void request('bookmarks/merge-folder', { targetId, ids, title: name }).then(
              reload,
              reportFailure,
            );
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
          reorder={(() => {
            const id = vaultMenu.kind === 'bookmark' ? vaultMenu.record.id : vaultMenu.folder.id;
            return { earlier: nudger('vault', id, 'left'), later: nudger('vault', id, 'right') };
          })()}
          tag={vaultTagActions(vaultMenu)}
        />
      ) : null}

    </div>
  );
}
