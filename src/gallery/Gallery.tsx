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
import {
  buildBoard,
  displayColors,
  labelCell,
  labels,
  layoutGrid,
  membersInOrder,
  orderIndexAt,
  searchBoard,
  type Board,
  type GridOp,
} from '@/shared/board';
import { MAX_COLUMNS, MIN_COLUMNS, navCell, stepCell, type Direction, type Grid } from '@/shared/grid';
import { GROUP_COLORS, type GroupInfo } from '@/shared/groups';
import { hostnameOf } from '@/shared/url';
import { matchesVaultTrigger } from '@/shared/vault-entry';
import { FolderPicker } from '../sidebar/components/FolderPicker';
import { MergeMenu } from '../sidebar/components/MergeMenu';
import { MoveInPrompt } from '../sidebar/components/MoveInPrompt';
import { NewFolderForm } from '../sidebar/components/NewFolderForm';
import { RowMenu, type MenuTarget } from '../sidebar/components/RowMenu';
import { SearchBar } from '../sidebar/components/SearchBar';
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
import { buildIndex, countLinks, pathTo, searchTree, type TreeIndex } from '../sidebar/lib/tree';
import { searchVault, vaultPathTo, vaultTagHits } from '../sidebar/lib/vault-tree';
import { t, tn } from '@/shared/i18n';
import { useGridDrag } from './useGridDrag';
import { GroupOutlines } from './GroupOutlines';
import { GroupHead } from './GroupTag';
import { Button, IconButton } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { SegmentedControl } from '../ui/SegmentedControl';
import { CheckMark } from '../ui/Toggles';
import { Toast } from '../ui/Toast';
import { GroupMenu } from './GroupMenu';
import { TagPrompt } from '../sidebar/components/TagItems';
import { useBookmarkGrid } from '../sidebar/hooks/useBookmarkGrid';
import { useTagSearch } from '../sidebar/hooks/useTagSearch';

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

const SIZE_OPTIONS = COLUMN_CHOICES.map((value) => ({
  value,
  label: value === 140 ? t('size_small') : value === 200 ? t('size_medium') : t('size_large'),
}));

/** 補抓完的「查看缺的」：一般書籤是網址，隱私書籤是 id */
interface MissingFilter {
  mode: 'bookmarks' | 'vault';
  keys: ReadonlySet<string>;
}

function linksWithUrls(index: TreeIndex, urls: ReadonlySet<string>): BookmarkNode[] {
  return [...index.byId.values()].filter((node) => node.kind === 'link' && urls.has(node.url));
}

/** 資料夾卡片的 2×2 預覽：裡面前 4 個書籤 */
const MOSAIC = 4;

type Mode = 'bookmarks' | 'vault';

/** 與 gallery.css 的 `.grid { gap: 16px }` 一致 —— 欄數是照這個算的 */
const GRID_GAP = 16;

/**
 * 一張卡片大概多高（還沒量到的列用這個估）。
 *
 * 底板是卡片寬度的 4:3（約 `--card-min * 0.75`），其餘是標題、網域、內距與列間距。只影響捲軸
 * 長度與第一次要畫幾列，量到之後就以實際值為準。
 */
const cardEstimate = (size: ColumnSize): number => size * 0.75 + 72;

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
  align: 'start' | 'end' | undefined;
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
  const [missing, setMissing] = useState<MissingFilter | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
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
    // 換到另一個空間就清掉搜尋字：兩邊各搜各的，隱私空間的搜尋字也不該留到書籤那邊
    if (place.mode !== mode) {
      setQuery('');
    }
    setMissing(null);
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
      setQuery('');
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
    setMissing(null);
  };

  // `/` 聚焦搜尋框（焦點已經在輸入框裡時不攔，那是要打字）
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typing = target !== null && target.closest('input, textarea, select, [contenteditable="true"]') !== null;
      if (event.key === '/' && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

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
  const tagHits = useTagSearch(mode === 'bookmarks' ? trimmed : '', index);
  const search = trimmed === '' ? null : searchTree(viewRoots ?? [], trimmed, tagHits);
  // 「查看缺的」：和搜尋一樣是一份跨資料夾的清單，不能排、沒有群組
  const missingNodes =
    mode === 'bookmarks' && search === null && missing?.mode === 'bookmarks' ? linksWithUrls(index, missing.keys) : null;
  const nodes: BookmarkNode[] =
    missingNodes ?? (search !== null ? search.nodes : (currentFolder?.children ?? viewRoots ?? []));
  /** 隱私空間的搜尋（全在記憶體裡做，規則與書籤那邊一樣）。null = 沒在搜尋 */
  const vaultSearch =
    mode === 'vault' && trimmed !== ''
      ? searchVault(view.folders, view.bookmarks, view.layout, trimmed)
      : mode === 'vault' && missing?.mode === 'vault'
        ? view.bookmarks
            .filter((record) => missing.keys.has(record.id))
            .map((record) => ({ kind: 'bookmark' as const, record }))
        : null;

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

  const vaultRows: VaultGridRow[] =
    vaultSearch ?? vaultChildren(view.folders, view.bookmarks, vaultFolderId, view.layout);

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
    search !== null || missingNodes !== null || currentFolder === undefined
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

  const listKey =
    missingNodes !== null ? 'missing' : search === null ? (folderId ?? 'root') : `search:${trimmed}`;

  /*
   * 版面（第 3 期改版）。每個資料夾的版面是一個 `Board`（`shared/board.ts`）：卡片緊密排列，
   * 欄數跟著視窗，除非使用者按 − / + 定下來。群組是順序上連續的一段，畫成框。
   * 搜尋結果與最上層（Firefox 的永久資料夾）沒有群組，只是照順序排。
   *
   * 能拖的畫面在最後一張之後多畫一個空位，當作「放到最後」的落點。
   */
  const inFolderView = search === null && missingNodes === null && currentFolder !== undefined;
  const columns = useGridColumns(gridScrollRef, size, GRID_GAP);
  const bookmarkGroupOf = new Map(
    (view.grid ?? null)?.groups.flatMap((group) => group.members.map((member) => [member, group.id] as const)) ?? [],
  );
  // `#名稱` 的搜尋結果裡群組照樣畫出來（只是不能排；點標籤跳到那個資料夾）
  const bookmarkTagResults = search !== null && tagHits !== null;
  const bookmarkBoard: Board = search !== null && tagHits !== null
    ? searchBoard(nodes.map((node) => node.id), tagHits, columns)
    : buildBoard({
    stored:
      inFolderView && view.grid != null && view.grid.columns > 0
        ? { columns: view.grid.columns, cells: nodes.map((node) => node.id) }
        : null,
    fixed: inFolderView && (view.grid?.columns ?? 0) > 0,
    children: nodes.map((node) => node.id),
    autoColumns: columns,
    groups: inFolderView ? (view.grid?.groups ?? []).map(({ members: _members, ...group }) => group) : [],
    groupOf: (id) => bookmarkGroupOf.get(id) ?? null,
  });
  // 版面還在讀：先不畫，免得先畫一次沒有群組、欄數不對的再跳一下
  const bookmarkGridLoading = inFolderView && view.grid === undefined;
  const bookmarkCols = bookmarkBoard.grid.columns;
  // 畫面的擺法（群組繞著擺成一整塊）：格子、拖拽落點、方向鍵、框線都照它
  const bookmarkShown: Grid = layoutGrid(bookmarkBoard);
  const bookmarkCellCount = bookmarkShown.cells.length + (inFolderView ? 1 : 0);
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
        cells: { nav: (key, at) => navCell(bookmarkShown, at, key) },
      },
    },
    gridRef,
  );

  const vaultColumns = useGridColumns(vaultScrollRef, size, GRID_GAP);
  // 搜尋結果與書籤那邊一樣：照順序排、沒有群組、不能拖
  const vaultFixed = vaultSearch === null ? folderColumns(view.layout, vaultFolderId) : null;
  const vaultHits = vaultSearch === null || trimmed === '' ? [] : vaultTagHits(view.bookmarks, view.layout, trimmed);
  const vaultBoard: Board =
    vaultSearch !== null
      ? searchBoard(vaultRows.map(vaultChildId), vaultHits, vaultColumns)
      : buildBoard({
          stored: vaultFixed === null ? null : { columns: vaultFixed, cells: vaultRows.map(vaultChildId) },
          fixed: vaultFixed !== null,
          children: vaultRows.map(vaultChildId),
          autoColumns: vaultColumns,
          groups: vaultGroups(view.layout, vaultFolderId),
          groupOf: vaultGroupOf(view.layout),
        });
  const vaultCols = vaultBoard.grid.columns;
  const vaultShown: Grid = layoutGrid(vaultBoard);
  const canDragVault = mode === 'vault' && vaultSearch === null;
  const vaultCellCount = vaultShown.cells.length + (canDragVault ? 1 : 0);
  const vaultGrid = useVirtualRows({
    count: vaultCellCount,
    columns: vaultCols,
    estimate: cardEstimate(size),
    resetKey: `${vaultSearch === null ? (vaultFolderId ?? 'root') : `search:${trimmed}:${String(missing !== null)}`}/${String(size)}/${String(vaultSelecting)}/${String(vaultCols)}`,
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
        cells: { nav: (key, at) => navCell(vaultShown, at, key) },
      },
    },
    vaultGridRef,
  );

  // 隱密模式下只有解鎖後才顯示切換，否則這個頁面完全沒有隱私空間的痕跡
  const showModes = settings?.vaultEntry === 'tab' || vaultUnlocked;
  // 根層列的是 Firefox 內建的永久資料夾，移入對它們一定失敗（理由同側邊欄）
  const showingRoots = search === null && missingNodes === null && currentFolder === undefined;

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
  const shownOf = (space: Mode): Grid => (space === 'vault' ? vaultShown : bookmarkShown);
  const bookmarkColors = displayColors(bookmarkBoard, bookmarkShown, GROUP_COLORS);
  const vaultColors = displayColors(vaultBoard, vaultShown, GROUP_COLORS);
  const colorsOf = (space: Mode): ReadonlyMap<string, number> => (space === 'vault' ? vaultColors : bookmarkColors);

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
    cells: shownOf(space).cells,
    onDragChange: setDragging,
    onPlace: (ids: string[], cell: number, aimed: string | null, after: boolean) => {
      if (ids.length > 1) {
        exitSelection();
      }
      const at = orderIndexAt(boardOf(space), shownOf(space), cell, aimed, after);
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
    onMoveGroup: (groupId: string, cell: number, aimed: string | null, after: boolean) => {
      const at = orderIndexAt(boardOf(space), shownOf(space), cell, aimed, after);
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
    enabled: canDragVault,
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
    if (space === 'bookmarks' ? !canDragBookmarks : !canDragVault) {
      return null;
    }
    // 方向是畫面上的方向：群組繞著擺時，上下左右的鄰居不等於順序上的前後
    const shown = shownOf(space);
    const at = shown.cells.indexOf(id);
    const to = at === -1 ? null : stepCell(shown, at, direction);
    if (to === null || (shown.cells[to] ?? '') === '') {
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
        from: shownOf(space).cells.indexOf(members[0] ?? ''),
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
      disabled: ids.length === 0 || (space === 'bookmarks' ? !canDragBookmarks : !canDragVault),
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
  const layoutBoard: Board | null =
    mode === 'vault' ? (canDragVault ? vaultBoard : null) : canDragBookmarks ? bookmarkBoard : null;
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
   * 卡片的畫法。
   *
   * 書籤卡片：底板（16:9）＋標題＋網域；滑鼠移上去時右上角出現 ⋯（右鍵選單的另一個入口，
   * 它是卡片的兄弟元素 —— 卡片本身是 <a> 或 <button>，裡面不能再放按鈕）。
   * 資料夾卡片：底板裡用 2×2 拼出前 4 個書籤的小預覽。
   * 多選中整張卡片是勾選觸發區，左上角一個勾選框；資料夾的巡覽移到右上角的箭頭。
   */
  const locationOf = (node: BookmarkNode): string => {
    const parent = index.byId.get(index.parentOf.get(node.id) ?? '');
    return parent === undefined ? '' : parent.title || t('folder_untitled');
  };

  const quickMenu = (label: string, open: (x: number, y: number) => void) => (
    <IconButton
      icon="more"
      className="gcard__quick"
      label={t('card_more_named', label)}
      hint={t('toolbar_more')}
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        open(rect.left, rect.bottom + 4);
      }}
    />
  );

  const cardClass = (id: string, picked: boolean, active: boolean): string =>
    ['gcard', picked ? 'gcard--selected' : '', active ? 'gcard--ctx' : ''].filter(Boolean).join(' ');

  const folderMosaic = (tiles: ReactNode[]) => (
    <span className="thumb gcard__mosaic" aria-hidden="true">
      {/* 設定成只畫資料夾圖示、或裡面一個書籤都沒有：底板中間一個大資料夾 */}
      {tiles.length === 0 || settings?.folderPreviews === false ? (
        <Icon name="folder" className="gcard__mosaic-empty" />
      ) : (
        Array.from({ length: MOSAIC }, (_, at) => (
          <span key={at} className="gcard__tile">
            {tiles[at] ?? null}
          </span>
        ))
      )}
    </span>
  );

  const folderText = (name: string, meta: string) => (
    <span className="gcard__text">
      <span className="gcard__title">
        <Icon name="folder" />
        <span>{name}</span>
      </span>
      <span className="gcard__meta">{meta}</span>
    </span>
  );

  const linkText = (title: string, hostname: string) => (
    <span className="gcard__text">
      <span className="gcard__title">
        <span>{title}</span>
      </span>
      <span className="gcard__meta">{hostname}</span>
    </span>
  );

  const bookmarkCard = (node: BookmarkNode): ReactNode => {
    const picked = selecting && selectedIds.has(node.id);
    const active = menu?.node.id === node.id;
    const openMenu = (x: number, y: number): void => {
      setMenu({ node, x, y });
    };
    if (node.kind === 'folder') {
      const name = node.title || t('folder_untitled_folder');
      const tiles = node.children
        .filter((child) => child.kind === 'link')
        .slice(0, MOSAIC)
        .map((child) => (child.kind === 'link' ? <Thumb key={child.id} url={child.url} hostname={hostnameOf(child.url)} /> : null));
      return (
        <>
          <button
            type="button"
            className={cardClass(node.id, picked, active)}
            {...bookmarkDrag.cardProps(node.id)}
            data-nav=""
            {...(selecting ? { role: 'checkbox', 'aria-checked': picked } : {})}
            onClick={() => {
              if (selecting) {
                toggleSelect(node.id);
                return;
              }
              go({ mode: 'bookmarks', folderId: node.id });
              setQuery('');
            }}
            {...contextMenuHandlers(({ x, y }) => {
              openMenu(x, y);
            })}
          >
            {folderMosaic(tiles)}
            {folderText(name, tn('unit_bookmarks', countLinks(node.children)))}
            {selecting ? <CheckMark state={picked} size="lg" /> : null}
          </button>
          {selecting ? (
            <IconButton
              icon="chevron"
              className="gcard__enter"
              label={t('row_open_folder_named', node.title || t('folder_untitled'))}
              hint={t('row_open_folder')}
              onClick={() => {
                go({ mode: 'bookmarks', folderId: node.id });
                setQuery('');
              }}
            />
          ) : (
            quickMenu(name, openMenu)
          )}
        </>
      );
    }
    const hostname = hostnameOf(node.url);
    const title = node.title || hostname;
    if (selecting) {
      // 多選中整張卡片是勾選觸發區。維持成 <a> 會讓「點擊等於開啟」與「點擊等於勾選」衝突
      return (
        <button
          type="button"
          className={cardClass(node.id, picked, active)}
          {...bookmarkDrag.cardProps(node.id)}
          data-nav=""
          role="checkbox"
          aria-checked={picked}
          title={node.url}
          onClick={() => {
            toggleSelect(node.id);
          }}
          {...contextMenuHandlers(({ x, y }) => {
            openMenu(x, y);
          })}
        >
          <Thumb url={node.url} hostname={hostname} />
          {linkText(title, hostname)}
          <CheckMark state={picked} size="lg" />
        </button>
      );
    }
    return (
      <>
        <a
          className={cardClass(node.id, false, active)}
          {...bookmarkDrag.cardProps(node.id)}
          data-nav=""
          href={node.url}
          title={node.url}
          onClick={(event) => {
            event.preventDefault();
            open(node.url, event.ctrlKey || event.metaKey);
          }}
          {...contextMenuHandlers(({ x, y }) => {
            openMenu(x, y);
          })}
        >
          <Thumb url={node.url} hostname={hostname} />
          {linkText(title, search !== null || missingNodes !== null ? `${hostname} · ${locationOf(node)}` : hostname)}
        </a>
        {quickMenu(title, openMenu)}
      </>
    );
  };

  /** 這個空間現在畫的是 `#名稱` 的搜尋結果（標籤點了是跳到資料夾） */
  const searchTag = (space: Mode): boolean => (space === 'vault' ? vaultSearch !== null : bookmarkTagResults);

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
   * 每一格是一個 `.cell`（`data-cell` = 畫面上的格子索引，拖拽與方向鍵都認它）。群組的框線不畫在格子上，
   * 是墊在底下的一層 SVG（`GroupOutlines`）；名稱標籤放在第一個成員那一格。
   */
  const gridCells = (
    space: Mode,
    board: Board,
    win: { start: number; end: number },
    render: (id: string) => ReactNode,
  ): ReactNode[] => {
    const drag = space === 'vault' ? vaultDrag : bookmarkDrag;
    const shown = shownOf(space);
    // 相鄰的群組不同色（使用者挑過的不動），標籤與選單也用這個顏色
    const colors = colorsOf(space);
    const groupById = new Map(
      board.groups.map((group) => [group.id, { ...group, color: colors.get(group.id) ?? group.color }]),
    );
    const tags = labels(board, shown);
    const out: ReactNode[] = [];
    for (let at = win.start; at < win.end; at += 1) {
      const id = shown.cells[at];
      if (id === undefined || id === '') {
        out.push(<div key={`slot:${String(at)}`} className={`cell cell--empty${drag.dropClass(at)}`} data-cell={at} />);
        continue;
      }
      const tagged = tags.get(at);
      const tag = tagged === undefined ? undefined : groupById.get(tagged.id);
      out.push(
        <div key={id} className={`cell${drag.dropClass(at)}`} data-cell={at}>
          {render(id)}
          {tag !== undefined ? (
            <GroupHead
              group={tag}
              count={membersInOrder(board, tag.id).length}
              drag={drag.labelProps(tag.id)}
              hint={searchTag(space) ? t('group_tag_search_hint') : undefined}
              menuOpen={groupMenu?.group.id === tag.id}
              onMenu={(x, y, align) => {
                // 搜尋結果跨資料夾，選單的操作沒有對象：點標籤是跳到那個群組所在的資料夾
                if (space === 'vault' && vaultSearch !== null) {
                  go({ mode: 'vault', folderId: vaultHits.find((hit) => hit.group.id === tag.id)?.folderId ?? null });
                  setQuery('');
                  return;
                }
                if (space === 'bookmarks' && bookmarkTagResults) {
                  const folder = tagHits?.find((hit) => hit.group.id === tag.id)?.folderId;
                  if (folder != null) {
                    go({ mode: 'bookmarks', folderId: folder });
                    setQuery('');
                  }
                  return;
                }
                setGroupMenu({ space, group: tag, x, y, align });
              }}
            />
          ) : null}
        </div>,
      );
    }
    return out;
  };

  const vaultFolderCard = (folder: PrivateFolder): ReactNode => {
    const picked = vaultSelecting && vaultSelectedIds.has(folder.id);
    const active = vaultMenu?.kind === 'folder' && vaultMenu.folder.id === folder.id;
    const name = folder.name || t('folder_untitled_folder');
    const openMenu = (x: number, y: number): void => {
      setVaultMenu({ kind: 'folder', folder, x, y });
    };
    const tiles = view.bookmarks
      .filter((record) => record.folderId === folder.id)
      .slice(0, MOSAIC)
      .map((record) => <VaultThumb key={record.id} id={record.id} hostname={hostnameOf(record.url)} />);
    return (
      <>
        <button
          type="button"
          className={cardClass(folder.id, picked, active)}
          {...vaultDrag.cardProps(folder.id)}
          data-nav=""
          {...(vaultSelecting ? { role: 'checkbox', 'aria-checked': picked } : {})}
          onClick={() => {
            if (vaultSelecting) {
              toggleVaultSelect(folder.id);
              return;
            }
            go({ mode: 'vault', folderId: folder.id });
            setQuery('');
          }}
          {...contextMenuHandlers(({ x, y }) => {
            openMenu(x, y);
          })}
        >
          {folderMosaic(tiles)}
          {folderText(name, tn('unit_bookmarks', vaultCountIn.get(folder.id) ?? 0))}
          {vaultSelecting ? <CheckMark state={picked} size="lg" /> : null}
        </button>
        {vaultSelecting ? (
          <IconButton
            icon="chevron"
            className="gcard__enter"
            label={t('row_open_folder_named', folder.name || t('folder_untitled'))}
            hint={t('row_open_folder')}
            onClick={() => {
              go({ mode: 'vault', folderId: folder.id });
              setQuery('');
            }}
          />
        ) : (
          quickMenu(name, openMenu)
        )}
      </>
    );
  };

  const vaultBookmarkCard = (record: PrivateBookmark): ReactNode => {
    const picked = vaultSelecting && vaultSelectedIds.has(record.id);
    const active = vaultMenu?.kind === 'bookmark' && vaultMenu.record.id === record.id;
    const hostname = hostnameOf(record.url);
    const title = record.title || hostname;
    const openMenu = (x: number, y: number): void => {
      setVaultMenu({ kind: 'bookmark', record, x, y });
    };
    if (vaultSelecting) {
      return (
        <button
          type="button"
          className={cardClass(record.id, picked, active)}
          {...vaultDrag.cardProps(record.id)}
          data-nav=""
          role="checkbox"
          aria-checked={picked}
          title={record.url}
          onClick={() => {
            toggleVaultSelect(record.id);
          }}
          {...contextMenuHandlers(({ x, y }) => {
            openMenu(x, y);
          })}
        >
          <VaultThumb id={record.id} hostname={hostname} />
          {linkText(title, hostname)}
          <CheckMark state={picked} size="lg" />
        </button>
      );
    }
    return (
      <>
        <a
          className={cardClass(record.id, false, active)}
          {...vaultDrag.cardProps(record.id)}
          data-nav=""
          href={record.url}
          title={record.url}
          onClick={(event) => {
            event.preventDefault();
            open(record.url, event.ctrlKey || event.metaKey);
          }}
          {...contextMenuHandlers(({ x, y }) => {
            openMenu(x, y);
          })}
        >
          <VaultThumb id={record.id} hostname={hostname} />
          {linkText(title, hostname)}
        </a>
        {quickMenu(title, openMenu)}
      </>
    );
  };

  /*
   * 頁首：小字麵包屑（上一層＋祖先）、大標題、數量，右邊是這一層的動作。
   * 多選時整條換成選取列（不再同時多出一條、還有重複的「取消選取」）。
   */
  const vaultCrumbs = vaultPathTo(vault.folders, vaultFolderId);
  const bookmarkCrumbs =
    currentFolder === undefined
      ? []
      : pathTo(index, currentFolder.id).map((folder) => ({ id: folder.id, title: folder.title }));
  const crumbTrail = mode === 'vault' ? vaultCrumbs.slice(0, -1) : bookmarkCrumbs.slice(0, -1);
  const searching = mode === 'vault' ? vaultSearch !== null && trimmed !== '' : search !== null;
  const showingMissing = mode === 'vault' ? missing?.mode === 'vault' && trimmed === '' : missingNodes !== null;
  const heading = searching
    ? t('gallery_search_heading')
    : showingMissing
      ? t('gallery_missing_heading')
      : mode === 'vault'
        ? vaultFolderId === null
          ? t('tab_vault')
          : (vaultCrumbs[vaultCrumbs.length - 1]?.title ?? '') || t('folder_untitled')
        : currentFolder === undefined
          ? t('crumbs_all_bookmarks')
          : currentFolder.title || t('folder_untitled');
  const countText = (folderCount: number, linkCount: number): string =>
    [folderCount > 0 ? tn('unit_folders', folderCount) : '', linkCount > 0 || folderCount === 0 ? tn('unit_bookmarks', linkCount) : '']
      .filter(Boolean)
      .join(' · ');
  const subheading = searching
    ? mode === 'vault'
      ? tn('search_results', vaultSearch?.length ?? 0)
      : `${tn('search_found_all', search?.nodes.length ?? 0)}${search?.truncated === true ? t('search_truncated') : ''}`
    : showingMissing
      ? tn('missing_previews', mode === 'vault' ? (vaultSearch?.length ?? 0) : (missingNodes?.length ?? 0))
      : mode === 'vault'
        ? vaultFolderId === null && vault.state?.status === 'unlocked'
          ? `${tn('unit_bookmarks', vault.state.bookmarkCount)} · ${tn('gallery_autolock', settings?.autoLockMinutes ?? 0)}`
          : countText(vaultFolders.length, vaultBookmarks.length)
        : countText(
            nodes.filter((node) => node.kind === 'folder').length,
            nodes.filter((node) => node.kind === 'link').length,
          );
  const upHere = mode === 'vault' ? (vaultSearch === null ? upVault : undefined) : upBookmarks;
  const crumbDrop =
    mode === 'vault'
      ? { props: (id: string | null) => vaultDrag.crumbProps(id, true), className: vaultDrag.crumbClass }
      : canDragBookmarks
        ? {
            // 「全部」那一層只能放 Firefox 的永久資料夾，不接受拖放
            props: (id: string | null) => bookmarkDrag.crumbProps(id, id !== null),
            className: bookmarkDrag.crumbClass,
          }
        : undefined;
  const folderName = mode === 'vault' ? heading : currentFolder === undefined ? heading : currentFolder.title;
  const [primaryAction, ...otherActions] = selectionActions;
  const allInView = mode === 'vault' ? vaultFolders.length + vaultBookmarks.length : nodes.length;
  const backfillResult = backfill.result;
  const progress = backfill.progress;

  return (
    <div className="gallery">
      <header className={mode === 'vault' ? 'gbar gbar--vault' : 'gbar'}>
        <div className="gbar__left">
          <div className="gbar__brand">{t('extension_name')}</div>
          {showModes ? (
            <SegmentedControl
              role="tablist"
              size="lg"
              label={t('gallery_scope')}
              options={[
                { value: 'bookmarks' as Mode, label: t('tab_bookmarks') },
                { value: 'vault' as Mode, label: t('tab_vault_short') },
              ]}
              value={mode}
              onChange={(next) => {
                // 先退出多選：勾選的是另一邊的項目，帶著它切過去只會留下一排無處可用的動作按鈕。
                // 表單開著時一併關掉：它建在「目前模式的目前資料夾」，帶著它切換會建到另一邊去
                exitSelection();
                setCreatingFolder(false);
                go(next === 'vault' ? { mode: 'vault', folderId: vaultFolderId } : { mode: 'bookmarks', folderId });
              }}
            />
          ) : null}
        </div>
        <SearchBar
          ref={searchRef}
          className="gbar__search"
          size="lg"
          shortcut="/"
          autoFocus={false}
          value={query}
          placeholder={mode === 'vault' ? t('vault_search_placeholder') : t('search_placeholder')}
          onChange={handleQueryChange}
        />
        <div className="gbar__controls">
          <SegmentedControl size="lg" label={t('gallery_card_size')} options={SIZE_OPTIONS} value={size} onChange={setSize} />
          {layoutBoard !== null ? (
            // 欄數：平常跟著視窗（自動）；按 − / + 就定下來，「自動」放開
            <div className="stepper" role="group" aria-label={t('grid_columns')}>
              <IconButton
                icon="minus"
                label={t('grid_columns_less')}
                disabled={layoutBoard.grid.columns <= MIN_COLUMNS}
                onClick={() => {
                  gridOp(mode, { kind: 'columns', columns: layoutBoard.grid.columns - 1 });
                }}
              />
              <span className="stepper__value">
                {layoutBoard.fixed
                  ? t('grid_columns_n', String(layoutBoard.grid.columns))
                  : t('grid_columns_auto', String(layoutBoard.grid.columns))}
              </span>
              <IconButton
                icon="plus"
                label={t('grid_columns_more')}
                disabled={layoutBoard.grid.columns >= MAX_COLUMNS}
                onClick={() => {
                  gridOp(mode, { kind: 'columns', columns: layoutBoard.grid.columns + 1 });
                }}
              />
              {layoutBoard.fixed ? (
                <button
                  type="button"
                  className="stepper__auto"
                  title={t('grid_auto_hint')}
                  onClick={() => {
                    gridOp(mode, { kind: 'auto' });
                  }}
                >
                  {t('grid_auto_short')}
                </button>
              ) : null}
            </div>
          ) : null}
          {mode === 'vault' ? (
            <Button
              size="lg"
              icon="lock"
              onClick={() => {
                void vault.lock();
              }}
            >
              {t('vault_lock_short')}
            </Button>
          ) : null}
          <IconButton
            icon="more"
            size="lg"
            label={t('toolbar_more')}
            aria-haspopup="true"
            aria-expanded={optionsMenu !== null}
            on={optionsMenu !== null}
            onClick={(event) => {
              if (optionsMenu !== null) {
                setOptionsMenu(null);
                return;
              }
              const rect = event.currentTarget.getBoundingClientRect();
              setOptionsMenu({ x: rect.right, y: rect.bottom + 6 });
            }}
          />
        </div>
        {progress === null ? null : (
          <span
            className="gbar__progress"
            role="progressbar"
            aria-label={t('backfill_running')}
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.done}
            style={{ width: `${String(Math.round((progress.done / progress.total) * 100))}%` }}
          />
        )}
      </header>

      {activeSelecting ? (
        <div className="selbar" role="toolbar" aria-label={t('selection_toolbar')}>
          <IconButton icon="close" size="lg" label={t('selection_exit')} onClick={exitSelection} />
          <span className="selbar__count" aria-live="polite">
            {tn('toolbar_selected', activeSelectedCount)}
          </span>
          {searching || showingMissing ? null : (
            <span className="selbar__where">{t('selection_in_folder', folderName || t('folder_untitled'))}</span>
          )}
          <Button variant="ghost" size="lg" className="selbar__all" onClick={selectAllInView}>
            {t('select_all_n', allInView)}
          </Button>
          <span className="gbar__spacer" />
          {otherActions.map((action) => (
            <Button
              key={action.label}
              variant="outline"
              size="lg"
              icon={action.label === t('grid_frame') ? 'frame' : action.label === t('row_import') ? 'move-in' : 'move-out'}
              disabled={activeSelectedCount === 0 || action.disabled === true}
              title={action.title}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                action.onPick(rect.left, rect.bottom + 4);
              }}
            >
              {action.label}
            </Button>
          ))}
          {primaryAction === undefined ? null : (
            <Button
              variant="primary"
              size="lg"
              icon="folder-move"
              disabled={activeSelectedCount === 0 || primaryAction.disabled === true}
              title={primaryAction.title}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                primaryAction.onPick(rect.left, rect.bottom + 4);
              }}
            >
              {primaryAction.label}
            </Button>
          )}
        </div>
      ) : (
        <div className="ph">
          <div className="ph__title">
            {upHere !== undefined || crumbTrail.length > 0 ? (
              <nav className="ph__crumbs" aria-label={t('crumbs_label')}>
                {upHere === undefined ? null : <IconButton icon="back" className="ph__up" label={t('crumbs_up')} onClick={upHere} />}
                <button
                  type="button"
                  className={`ph__crumb${crumbDrop?.className(null) ?? ''}`}
                  {...crumbDrop?.props(null)}
                  onClick={() => {
                    go({ mode, folderId: null });
                  }}
                >
                  {mode === 'vault' ? t('tab_vault') : t('crumbs_all')}
                </button>
                <span className="ph__sep">/</span>
                {crumbTrail.map((crumb) => (
                  <span key={crumb.id} className="ph__crumbgroup">
                    <button
                      type="button"
                      className={`ph__crumb${crumbDrop?.className(crumb.id) ?? ''}`}
                      {...crumbDrop?.props(crumb.id)}
                      onClick={() => {
                        go({ mode, folderId: crumb.id });
                      }}
                    >
                      {crumb.title || t('folder_untitled')}
                    </button>
                    <span className="ph__sep">/</span>
                  </span>
                ))}
              </nav>
            ) : null}
            <div className="ph__heading">
              <h1>{heading}</h1>
              <span className="ph__meta">{subheading}</span>
              {showingMissing ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setMissing(null);
                  }}
                >
                  {t('missing_previews_clear')}
                </Button>
              ) : null}
            </div>
          </div>
          <span className="gbar__spacer" />
          <div className="ph__actions">
            {searching || showingMissing ? null : (
              <Button
                size="lg"
                icon="folder-plus"
                title={mode === 'bookmarks' && folderId === null ? t('new_folder_hint_root') : t('new_folder_hint_nested')}
                onClick={() => {
                  setCreatingFolder(true);
                }}
              >
                {t('action_new_folder')}
              </Button>
            )}
            <Button
              size="lg"
              icon="select"
              title={showModes ? t('toolbar_select_hint') : t('gallery_select_hint')}
              onClick={() => {
                if (mode === 'vault') {
                  setVaultSelecting(true);
                  return;
                }
                setSelecting(true);
              }}
            >
              {t('toolbar_select')}
            </Button>
          </div>
        </div>
      )}

      {vault.error !== null && !vaultPrompt ? (
        <div className="notice notice--error">
          <p>{vault.error}</p>
          <Button variant="ghost" onClick={vault.clearError}>
            {t('action_close')}
          </Button>
        </div>
      ) : null}

      {creatingFolder ? (
        <div className="gallery__newfolder">
          <NewFolderForm
            hint={mode === 'bookmarks' && folderId === null ? t('new_folder_root_note') : undefined}
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
        </div>
      ) : null}

      {mode === 'vault' ? (
        vaultSearch !== null && vaultSearch.length === 0 ? (
          <p className="empty">{t('search_no_match')}</p>
        ) : vaultSearch === null && vaultFolders.length === 0 && vaultBookmarks.length === 0 ? (
          <p className="empty">{vaultFolderId === null ? t('gallery_vault_empty_hint') : t('folder_empty')}</p>
        ) : (
          <div className="grid-scroll" ref={vaultScrollRef}>
            <div
              ref={vaultGridRef}
              onKeyDown={gridKeys('vault', vaultNav.onKeyDown)}
              {...vaultDrag.gridProps}
              className={gridClass(vaultBoard)}
              style={{ ...gridStyleFor(vaultBoard), paddingTop: vaultGrid.padTop, paddingBottom: vaultGrid.padBottom }}
            >
              <GroupOutlines gridRef={vaultGridRef} board={vaultBoard} shown={vaultShown} colors={vaultColors} />
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
        <p className="empty">
          {search !== null || missingNodes !== null ? t('search_no_match') : t('folder_no_bookmarks')}
        </p>
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
              <GroupOutlines gridRef={gridRef} board={bookmarkBoard} shown={bookmarkShown} colors={bookmarkColors} />
              {gridCells('bookmarks', bookmarkBoard, gridRows, (id) => {
                const node = index.byId.get(id);
                return node === undefined ? null : bookmarkCard(node);
              })}
            </div>
          )}
        </div>
      )}

      {notice !== null || backfillResult !== null ? (
        <div className="gallery__toasts">
          {notice !== null ? (
            <Toast
              timeout={10_000}
              onClose={() => {
                setNotice(null);
              }}
            >
              {notice}
            </Toast>
          ) : null}
          {backfillResult !== null ? (
            <Toast
              timeout={3_000}
              onClose={backfill.dismissResult}
              action={
                backfillResult.missing.length === 0
                  ? undefined
                  : {
                      label: t('backfill_show_missing'),
                      onClick: () => {
                        const target: Mode = backfillResult.kind === 'vault/backfill' ? 'vault' : 'bookmarks';
                        if (target !== mode) {
                          exitSelection();
                          go(target === 'vault' ? { mode: 'vault', folderId: vaultFolderId } : { mode: 'bookmarks', folderId });
                        }
                        // 放在 go 後面：它會清掉篩選，同一次更新裡以最後一次為準
                        setMissing({ mode: target, keys: new Set(backfillResult.missing) });
                        setQuery('');
                        backfill.dismissResult();
                      },
                    }
              }
            >
              {backfillResult.text}
            </Toast>
          ) : null}
        </div>
      ) : null}

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
          entryIcons={settings.entryIcons}
          onEntryIconsChange={(entryIcons) => {
            update({ entryIcons });
          }}
          folderPreviews={{
            on: settings.folderPreviews,
            onChange: (folderPreviews) => {
              update({ folderPreviews });
            },
          }}
          align="end"
          canBackfill={permissionGranted}
          backfillBusy={backfill.busy}
          backfillProgress={backfill.progress}
          // 站在隱私空間要抓的是隱私書籤（加密寫入），不是一般書籤
          backfillKind={mode === 'vault' ? 'vault/backfill' : 'thumbs/backfill'}
          onBackfill={backfill.start}
          captureNote={backfill.captureNote}
          destroyVault={
            mode === 'vault' && vault.state?.status === 'unlocked'
              ? {
                  count: vault.state.bookmarkCount,
                  onConfirm: () => {
                    void vault.destroy();
                  },
                }
              : undefined
          }
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
          align={groupMenu.align}
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
          tag={canDragVault ? vaultTagActions(vaultMenu) : undefined}
        />
      ) : null}

    </div>
  );
}
