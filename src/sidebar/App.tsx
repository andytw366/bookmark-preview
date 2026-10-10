import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildBoard, searchBoard, type GridOp } from '@/shared/board';
import { tagQuery } from '@/shared/groups';
import { request } from '@/shared/messages';
import type { BookmarkNode, Density, OpenTarget, PreviewSource } from '@/shared/types';
import { matchesVaultTrigger } from '@/shared/vault-entry';
import { vaultChildId, vaultChildren, vaultGroupOf, vaultGroups } from '@/shared/vault-layout';
import { useGridDrag } from '../gallery/useGridDrag';
import { Button, IconButton } from '../ui/Button';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Toast } from '../ui/Toast';
import { BookmarkList } from './components/BookmarkList';
import { Breadcrumb, UpButton } from './components/Breadcrumb';
import { FolderPicker } from './components/FolderPicker';
import { MoveInPrompt } from './components/MoveInPrompt';
import { NewFolderForm } from './components/NewFolderForm';
import { PermissionNotice } from './components/PermissionNotice';
import { RowMenu, type MenuTarget } from './components/RowMenu';
import { SearchBar } from './components/SearchBar';
import { SelectAllRow } from './components/SelectAllRow';
import { Toolbar } from './components/Toolbar';
import { VaultGate } from './components/VaultGate';
import { VaultFolderPicker } from './components/VaultFolderPicker';
import { VaultPrompt } from './components/VaultPrompt';
import { VaultRowMenu, type VaultMenuTarget } from './components/VaultRowMenu';
import { VaultView } from './components/VaultView';
import { useBackfill } from './hooks/useBackfill';
import { useBookmarkGrid } from './hooks/useBookmarkGrid';
import { useBookmarks } from './hooks/useBookmarks';
import { useHostPermission } from './hooks/useHostPermission';
import { useListBoard } from './hooks/useListBoard';
import { useSettings } from './hooks/useSettings';
import { useTagSearch } from './hooks/useTagSearch';
import { useVault } from './hooks/useVault';
import { buildIndex, countLinks, pathTo, searchTree, type TreeIndex } from './lib/tree';
import { searchVault, vaultTagHits } from './lib/vault-tree';
import { t, tn } from '@/shared/i18n';

type Tab = 'bookmarks' | 'vault';

const NO_SELECTION: ReadonlySet<string> = new Set();

/** 補抓完的「查看缺的」：只列出這次試過還是沒有預覽圖的（一般書籤是網址，隱私書籤是 id） */
interface MissingFilter {
  tab: Tab;
  keys: ReadonlySet<string>;
}

/** 整棵樹裡網址在 `urls` 裡的書籤，照樹的順序 */
function linksWithUrls(index: TreeIndex, urls: ReadonlySet<string>): BookmarkNode[] {
  return [...index.byId.values()].filter((node) => node.kind === 'link' && urls.has(node.url));
}

export function App() {
  const { roots, error, reload } = useBookmarks();
  const { settings, update } = useSettings();
  const permission = useHostPermission();

  const [tab, setTab] = useState<Tab>('bookmarks');
  // vaultInView 讓 useVault 知道要不要把使用者的操作算成「還在用隱私空間」
  const vault = useVault({ vaultInView: tab === 'vault' });
  const [folderId, setFolderId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [openError, setOpenError] = useState<string | null>(null);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const [moveResult, setMoveResult] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [vaultMenu, setVaultMenu] = useState<VaultMenuTarget | null>(null);
  const [vaultPrompt, setVaultPrompt] = useState(false);
  const [newFolder, setNewFolder] = useState(false);
  /** 批量搬移的資料夾選擇器，座標讓它貼著觸發按鈕跳出 */
  const [folderPicker, setFolderPicker] = useState<{ x: number; y: number } | null>(null);
  /** 隱私空間內的批量搬移（目標是 vault 資料夾） */
  const [vaultFolderPicker, setVaultFolderPicker] = useState<{ x: number; y: number } | null>(null);
  /** 批量移出：要選一個原生資料夾當落點 */
  const [exportPicker, setExportPicker] = useState<{
    x: number;
    y: number;
    ids: string[];
  } | null>(null);

  /** 移入確認：要移入哪些項目（書籤或資料夾），以及提示要貼在哪裡 */
  const [pendingMove, setPendingMove] = useState<{
    nodes: BookmarkNode[];
    x: number;
    y: number;
  } | null>(null);

  const [selecting, setSelecting] = useState(false);
  // 勾選狀態跨資料夾巡覽保留，所以存 id 而不是節點
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  /** 隱私空間的巡覽與勾選。與書籤那邊分開，兩者的 id 空間不同 */
  const [vaultFolderId, setVaultFolderId] = useState<string | null>(null);
  const [vaultSelecting, setVaultSelecting] = useState(false);
  const [vaultSelectedIds, setVaultSelectedIds] = useState<ReadonlySet<string>>(new Set());
  /** 隱私空間的搜尋字。只在記憶體裡，上鎖時清掉 */
  const [vaultQuery, setVaultQuery] = useState('');
  const [missing, setMissing] = useState<MissingFilter | null>(null);
  const backfill = useBackfill();
  const liveGrid = useBookmarkGrid(folderId);
  /** 拖拽中。拖拽期間資料凍結（見下面的 `frozen`） */
  const [dragging, setDragging] = useState(false);

  /*
   * 拖拽期間畫面用的是**開始拖之前**的資料（理由同全頁瀏覽：中途重繪會把被拖的那一列拆掉，
   * 之後 drop／dragend 都送不到）。放開之後才換成最新的。
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

  const index = useMemo(() => buildIndex(view.roots ?? []), [view.roots]);

  // 目前所在的資料夾若被刪除或改名搬移，退回根層而不是卡在空畫面
  useEffect(() => {
    if (folderId !== null && !index.byId.has(folderId)) {
      setFolderId(null);
    }
  }, [index, folderId]);

  // 上鎖後若停在隱私空間分頁，退回書籤（隱密模式下更要如此，
  // 否則會留下一個解鎖畫面暴露隱私空間的存在）
  const vaultStatus = vault.state?.status;
  useEffect(() => {
    if (vaultStatus !== 'unlocked' && tab === 'vault' && settings?.vaultEntry === 'hidden') {
      setTab('bookmarks');
    }
  }, [vaultStatus, tab, settings?.vaultEntry]);

  /*
   * 上鎖時清掉隱私空間側的巡覽與勾選狀態 —— 那些 id 指向的是已經無法解密的資料。
   *
   * 書籤那邊的多選**不清**：它現在有「移動到…」這個不需要金鑰的動作，
   * 上鎖不該讓使用者正在挑的一批東西消失。
   */
  useEffect(() => {
    if (vaultStatus !== 'unlocked') {
      setVaultSelecting(false);
      setVaultSelectedIds(new Set());
      setVaultFolderId(null);
      setVaultQuery('');
    }
  }, [vaultStatus]);

  /*
   * 通知訊息幾秒後自己消失。
   *
   * 原本只能手動按「關閉」，於是一小時前那句「已移入 3 個書籤。」會一直跟著
   * 使用者，還會在切到別的分頁時重新出現 —— 看起來像剛剛才發生的事。
   * 保留關閉鈕（想立刻收掉），但不強迫每則都要按一次。
   */
  useEffect(() => {
    if (moveResult === null) {
      return;
    }
    const timer = setTimeout(() => {
      setMoveResult(null);
    }, 10_000);
    return () => {
      clearTimeout(timer);
    };
  }, [moveResult]);

  const exitSelection = useCallback(() => {
    setSelecting(false);
    setSelectedIds(new Set());
  }, []);

  const exitVaultSelection = useCallback(() => {
    setVaultSelecting(false);
    setVaultSelectedIds(new Set());
  }, []);

  const toggleVaultSelect = useCallback((id: string) => {
    setVaultSelectedIds((current) => {
      const next = new Set(current);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });
  }, []);

  const toggleSelect = useCallback((node: BookmarkNode) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (!next.delete(node.id)) {
        next.add(node.id);
      }
      return next;
    });
  }, []);

  const openLink = useCallback((url: string, where: OpenTarget) => {
    request('bookmarks/open', { url, where }).catch((cause: unknown) => {
      setOpenError(cause instanceof Error ? cause.message : String(cause));
    });
  }, []);

  /**
   * 搜尋框的輸入。
   *
   * 打中觸發字串就把它清掉並跳出密碼畫面 —— 觸發字串本身不留在搜尋狀態裡，
   * 也不會短暫顯示成一次搜不到東西的搜尋。
   */
  const handleQueryChange = useCallback(
    (value: string) => {
      if (settings !== null && matchesVaultTrigger(value, settings.vaultTrigger)) {
        setQuery('');
        /*
         * 向背景頁問一次現在的狀態，不要相信快取的 `vault.state`。
         *
         * 事件頁被卸載時金鑰會無聲消失（沒有任何廣播），快取可能還停在
         * 「已解鎖」——那時候直接跳進隱私空間會看到一個空的、什麼都做不了的畫面。
         * 背景頁是唯一的權威來源，而這裡本來就要跨一次訊息，成本可以忽略。
         *
         * 已解鎖就直接切過去：`VaultGate` 只處理 locked，其他狀態一律落到
         * 「建立」表單，解鎖時叫出密碼畫面會變成「建立隱私空間」。
         */
        void vault.refreshState().then((fresh) => {
          if (fresh?.status === 'unlocked') {
            setTab('vault');
            return;
          }
          setVaultPrompt(true);
        });
        return;
      }
      setQuery(value);
      setMissing(null);
    },
    [settings, vault],
  );

  const trimmed = query.trim();
  const currentNode = folderId === null ? undefined : index.byId.get(folderId);
  const currentFolder = currentNode?.kind === 'folder' ? currentNode : undefined;

  const tagHits = useTagSearch(trimmed, index);
  const search = trimmed === '' ? null : searchTree(view.roots ?? [], trimmed, tagHits);
  // 「查看缺的」：和搜尋一樣是一份跨資料夾的清單，不能排、沒有群組
  const missingNodes =
    search === null && missing !== null && missing.tab === 'bookmarks' ? linksWithUrls(index, missing.keys) : null;
  const folderNodes: BookmarkNode[] = currentFolder?.children ?? view.roots ?? [];

  // 勾選是跨資料夾保留的，所以要從整棵樹的索引還原成節點，而不是只看目前這一層。
  // 順帶濾掉已經不存在的 id（書籤在勾選後被刪掉）。
  const selectedNodes: BookmarkNode[] = [...selectedIds]
    .map((id) => index.byId.get(id))
    .filter((node): node is BookmarkNode => node !== undefined);

  /**
   * 選取範圍裡實際會進到隱私空間的項目數（資料夾含子樹）。
   *
   * 資料夾現在可以整棵移入，所以送的是 `selectedNodes` 而不是只有連結；
   * 這個數字只是拿來判斷「有沒有東西可移」與顯示用。
   */
  const selectedLinkCount = countLinks(selectedNodes);

  /*
   * 滑鼠側鍵（「上一頁」那顆）當「上一層」。側邊欄沒有網址列、沒有歷史可回，
   * 但手已經習慣按那顆鍵往回走。兩個空間都接；搜尋結果與最上層沒有上一層。
   */
  const upOneLevel = (): void => {
    if (tab === 'vault') {
      if (vaultFolderId !== null) {
        setVaultFolderId(
          vault.folders.find((folder) => folder.id === vaultFolderId)?.parentId ?? null,
        );
      }
      return;
    }
    if (search === null && missingNodes === null && currentFolder !== undefined) {
      setFolderId(index.parentOf.get(currentFolder.id) ?? null);
    }
  };
  // 監聽器只綁一次，要讀到最新的所在位置得經過 ref
  const upOneLevelRef = useRef(upOneLevel);
  upOneLevelRef.current = upOneLevel;
  useEffect(() => {
    const onMouseUp = (event: MouseEvent): void => {
      if (event.button === 3) {
        event.preventDefault();
        upOneLevelRef.current();
      }
    };
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  /*
   * 群組與拖拽（第 4 期）。側邊欄只有一欄，版面就是順序本身：群組是連續的幾列。
   * 規則與全頁瀏覽完全一樣（`shared/board.ts`），送的也是同一組訊息，欄數一律報 1
   * （只影響還沒定欄數的資料夾怎麼算「上下」，側邊欄用不到）。
   * 搜尋結果與最上層（Firefox 的永久資料夾）不能排、沒有群組。
   */
  const inFolderView = search === null && missingNodes === null && currentFolder !== undefined;
  const bookmarkGroupOf = new Map(
    (inFolderView ? (view.grid?.groups ?? []) : []).flatMap((group) =>
      group.members.map((member) => [member, group.id] as const),
    ),
  );
  // `#名稱` 的搜尋結果裡群組照樣畫出來（只是不能排；點標籤跳到那個資料夾）
  const tagResults = search !== null && tagHits !== null;
  const bookmarkBoard =
    search !== null && tagHits !== null
      ? searchBoard(
          search.nodes.map((node) => node.id),
          tagHits,
          1,
        )
      : buildBoard({
          stored: null,
          fixed: false,
          children: folderNodes.map((node) => node.id),
          autoColumns: 1,
          groups: inFolderView ? (view.grid?.groups ?? []).map(({ members: _members, ...group }) => group) : [],
          groupOf: (id) => bookmarkGroupOf.get(id) ?? null,
        });
  // 版面還在讀（undefined）時先不讓拖：落點會算在還沒有群組的順序上
  const canArrange = inFolderView && view.grid !== undefined;
  const nodes: BookmarkNode[] =
    missingNodes !== null
      ? missingNodes
      : search !== null && !tagResults
      ? search.nodes
      : bookmarkBoard.grid.cells.flatMap((id) => {
          const node = index.byId.get(id);
          return node === undefined ? [] : [node];
        });

  /** 書籤這邊的請求做完就重讀；失敗就說出來（也重讀，畫面才不會停在半路） */
  const applyBookmarks = (work: () => Promise<unknown>): void => {
    void work().then(reload, (cause: unknown) => {
      setMoveResult(cause instanceof Error ? cause.message : String(cause));
      reload();
    });
  };
  const bookmarkGridOp = (op: GridOp): void => {
    if (currentFolder === undefined) {
      return;
    }
    const parentId = currentFolder.id;
    applyBookmarks(() => request('grid/apply', { folderId: parentId, columns: 1, op }));
  };
  const bookmarkList = useListBoard({
    board: bookmarkBoard,
    enabled: canArrange,
    apply: bookmarkGridOp,
    toFolder: (groupId) => {
      if (currentFolder !== undefined) {
        const parentId = currentFolder.id;
        applyBookmarks(() => request('groups/to-folder', { folderId: parentId, groupId, columns: 1 }));
      }
    },
    mergeFolder: (targetId, ids, title) => {
      applyBookmarks(() => request('bookmarks/merge-folder', { targetId, ids, title }));
    },
    isLink: (id) => index.byId.get(id)?.kind === 'link',
    onBatch: exitSelection,
    onTag: tagResults
      ? (groupId) => {
          const hit = tagHits?.find((item) => item.group.id === groupId);
          if (hit?.folderId != null) {
            setFolderId(hit.folderId);
            setQuery('');
          }
        }
      : undefined,
  });
  const scroller = (): HTMLElement | null => document.querySelector<HTMLElement>('.body');
  const bookmarkDrag = useGridDrag({
    ...bookmarkList.dragHandlers,
    enabled: canArrange,
    cells: bookmarkBoard.grid.cells,
    axis: 'vertical',
    scroller,
    onDragChange: setDragging,
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
      if (ids.length > 1) {
        exitSelection();
      }
      applyBookmarks(async () => {
        const report = await request('bookmarks/reorder', { ids, parentId: target, beforeId: null });
        if (report.failed > 0) {
          setMoveResult(
            t('moved_bookmarks_with_failures', tn('unit_bookmarks', report.moved), tn('unit_failed', report.failed)),
          );
        }
      });
    },
    onGroupInto: (groupId, target) => {
      if (target === null || currentFolder === undefined || target === currentFolder.id) {
        return;
      }
      const fromFolderId = currentFolder.id;
      applyBookmarks(() => request('groups/move', { fromFolderId, groupId, toFolderId: target, columns: 1 }));
    },
  });

  /** 隱私空間這邊：同一套，資料在加密的版面文件裡（`useVault` 的那幾個方法） */
  const vaultSearching = vaultQuery.trim() !== '';
  const vaultRows = vaultSearching
    ? searchVault(view.folders, view.bookmarks, view.layout, vaultQuery)
    : vaultChildren(view.folders, view.bookmarks, vaultFolderId, view.layout);
  const vaultRowById = new Map(vaultRows.map((row) => [vaultChildId(row), row]));
  const vaultHits = vaultTagHits(view.bookmarks, view.layout, vaultQuery);
  // 一般的搜尋結果沒有群組；`#名稱` 的照樣畫出來
  const vaultTagResults = vaultSearching && tagQuery(vaultQuery) !== null;
  const vaultBoard = vaultSearching
    ? searchBoard(vaultRows.map(vaultChildId), vaultHits, 1)
    : buildBoard({
        stored: null,
        fixed: false,
        children: vaultRows.map(vaultChildId),
        autoColumns: 1,
        groups: vaultGroups(view.layout, vaultFolderId),
        groupOf: vaultGroupOf(view.layout),
      });
  const canArrangeVault = vaultStatus === 'unlocked' && !vaultSearching;
  const vaultList = useListBoard({
    board: vaultBoard,
    enabled: canArrangeVault,
    apply: (op) => {
      void vault.gridApply(vaultFolderId, 1, op);
    },
    toFolder: (groupId) => {
      void vault.groupToFolder(groupId, 1);
    },
    mergeFolder: (targetId, ids, name) => {
      void vault.mergeIntoFolder(targetId, ids, name);
    },
    isLink: (id) => vaultRowById.get(id)?.kind === 'bookmark',
    onBatch: exitVaultSelection,
    onTag: vaultTagResults
      ? (groupId) => {
          setVaultFolderId(vaultHits.find((hit) => hit.group.id === groupId)?.folderId ?? null);
          setVaultQuery('');
        }
      : undefined,
  });
  const vaultDrag = useGridDrag({
    ...vaultList.dragHandlers,
    enabled: canArrangeVault,
    cells: vaultBoard.grid.cells,
    axis: 'vertical',
    scroller,
    onDragChange: setDragging,
    kindOf: (id) => vaultRowById.get(id)?.kind,
    selected: vaultSelecting ? vaultSelectedIds : NO_SELECTION,
    // 隱私書籤永遠不帶網址：拖到分頁列會在一般視窗打開、寫進瀏覽記錄
    linkOf: () => null,
    onInto: (ids, target) => {
      if (target === vaultFolderId) {
        return;
      }
      if (ids.length > 1) {
        exitVaultSelection();
      }
      void vault.reorder(ids, target, null);
    },
    onGroupInto: (groupId, target) => {
      if (target !== vaultFolderId) {
        void vault.groupMove(groupId, target, 1);
      }
    },
  });

  if (error !== null) {
    return (
      <div className="shell">
        <div className="notice notice--error">
          <p>{t('bookmarks_read_failed', error)}</p>
          <Button onClick={reload}>{t('action_retry')}</Button>
        </div>
      </div>
    );
  }

  if (roots === null || settings === null || vault.state === null) {
    return (
      <div className="shell">
        <p className="empty">{t('bookmarks_loading')}</p>
      </div>
    );
  }

  const vaultUnlocked = vault.state.status === 'unlocked';
  // 根層列出的就是那幾個永久資料夾本身；進到任何一層之後就不會再出現它們
  const showingRoots = search === null && missingNodes === null && currentFolder === undefined;
  // 隱密模式下只有解鎖後才顯示分頁；否則側邊欄完全沒有隱私空間的痕跡（連提示文字都不能提）
  const showTabs = settings.vaultEntry === 'tab' || vaultUnlocked;

  const switchTab = (next: Tab): void => {
    // 切換分頁時先退出多選：勾選的是另一頁的項目，帶著它切過去只會留下一排無處可用的動作按鈕
    if (next === 'vault') {
      exitSelection();
    } else {
      exitVaultSelection();
    }
    setMissing(null);
    setTab(next);
  };

  const toolbarCommon = {
    density: settings.density,
    onDensityChange: (density: Density) => {
      update({ density });
    },
    previewSource: settings.previewSource,
    onPreviewSourceChange: (previewSource: PreviewSource) => {
      update({ previewSource });
    },
    entryIcons: settings.entryIcons,
    onEntryIconsChange: (entryIcons: boolean) => {
      update({ entryIcons });
    },
    backfill,
    canBackfill: permission.granted === true,
  };

  const backfillResult = backfill.result;
  const vaultMissing = missing !== null && missing.tab === 'vault' ? missing.keys : undefined;

  return (
    <div className="shell">
      {showTabs ? (
        <div className="head head--tabs">
          <div className="head__tabs">
            <SegmentedControl
              role="tablist"
              fill
              label={t('gallery_scope')}
              options={[
                { value: 'bookmarks', label: t('tab_bookmarks') },
                { value: 'vault', label: t('tab_vault_short') },
              ]}
              value={tab}
              onChange={switchTab}
            />
            {vaultUnlocked ? (
              <IconButton
                icon="lock"
                label={t('vault_lock_now')}
                onClick={() => {
                  void vault.lock();
                }}
              />
            ) : null}
          </div>
        </div>
      ) : null}

      {vault.error !== null && !vaultPrompt ? (
        <div className="notice notice--error">
          <p>{vault.error}</p>
          <Button variant="ghost" onClick={vault.clearError}>
            {t('action_close')}
          </Button>
        </div>
      ) : null}

      {tab === 'vault' ? (
        vault.state.status === 'unlocked' ? (
          <VaultView
            state={vault.state}
            bookmarks={view.bookmarks}
            folders={view.folders}
            layout={view.layout}
            density={settings.density}
            onOpenLink={openLink}
            onCreateFolder={(name, parentId) => {
              void vault.createFolder(name, parentId);
            }}
            onBookmarkMenu={(record, x, y) => {
              setVaultMenu({ kind: 'bookmark', record, x, y });
            }}
            onFolderMenu={(folder, x, y) => {
              setVaultMenu({ kind: 'folder', folder, x, y });
            }}
            folderId={vaultFolderId}
            onNavigate={(id) => {
              setVaultFolderId(id);
              setVaultQuery('');
              setMissing(null);
            }}
            selecting={vaultSelecting}
            selected={vaultSelectedIds}
            onToggleSelect={toggleVaultSelect}
            query={vaultQuery}
            onQueryChange={(value) => {
              setVaultQuery(value);
              setMissing(null);
            }}
            onlyIds={vaultMissing}
            onClearOnly={() => {
              setMissing(null);
            }}
            grouping={
              vaultMissing === undefined && (!vaultSearching || vaultTagResults)
                ? { board: vaultList, drag: vaultDrag }
                : undefined
            }
            activeId={
              vaultMenu === null ? null : vaultMenu.kind === 'bookmark' ? vaultMenu.record.id : vaultMenu.folder.id
            }
            selectAll={
              <SelectAllRow
                total={vaultRows.length}
                selected={vaultRows.filter((row) => vaultSelectedIds.has(vaultChildId(row))).length}
                onSelectAll={() => {
                  setVaultSelectedIds((current) => new Set([...current, ...vaultRows.map(vaultChildId)]));
                }}
                onClearAll={() => {
                  setVaultSelectedIds((current) => {
                    const next = new Set(current);
                    for (const row of vaultRows) {
                      next.delete(vaultChildId(row));
                    }
                    return next;
                  });
                }}
              />
            }
          />
        ) : (
          <main className="body">
            <VaultGate
              state={vault.state}
              onCreate={vault.create}
              onUnlock={(password) => {
                void vault.unlock(password);
              }}
              onUnlockWithRecoveryKey={(code) => {
                void vault.unlockWithRecoveryKey(code);
              }}
              onForget={() => {
                void vault.forget();
              }}
            />
          </main>
        )
      ) : (
        <>
          <header className="head">
            <SearchBar value={query} onChange={handleQueryChange} />
            <div className="nav">
              {search !== null ? (
                <p className="nav__info">
                  {tn('search_found_all', search.nodes.length)}
                  {search.truncated ? t('search_truncated') : ''}
                </p>
              ) : missingNodes !== null ? (
                <>
                  <p className="nav__info">{tn('missing_previews', missingNodes.length)}</p>
                  <IconButton
                    icon="close"
                    label={t('missing_previews_clear')}
                    onClick={() => {
                      setMissing(null);
                    }}
                  />
                </>
              ) : (
                <>
                  <UpButton
                    onUp={
                      currentFolder === undefined
                        ? undefined
                        : () => {
                            setFolderId(index.parentOf.get(currentFolder.id) ?? null);
                          }
                    }
                  />
                  <Breadcrumb
                    path={currentFolder === undefined ? [] : pathTo(index, currentFolder.id)}
                    onNavigate={setFolderId}
                    rootLabel={t('crumbs_all_bookmarks')}
                    drop={
                      canArrange
                        ? {
                            // 「全部」那一層只能放 Firefox 的永久資料夾，不接受拖放
                            props: (id) => bookmarkDrag.crumbProps(id, id !== null),
                            className: bookmarkDrag.crumbClass,
                          }
                        : undefined
                    }
                  />
                  {/* 放在麵包屑旁邊而不是底部工具列：它建在「目前這個資料夾」裡，
                      放在路徑旁邊才看得出那個「目前」是哪裡 */}
                  <IconButton
                    icon="folder-plus"
                    label={t('action_new_folder')}
                    hint={folderId === null ? t('new_folder_hint_root') : t('new_folder_hint_nested')}
                    onClick={() => {
                      setNewFolder(true);
                    }}
                  />
                </>
              )}
            </div>
            {newFolder ? (
              <NewFolderForm
                hint={folderId === null ? t('new_folder_root_note') : undefined}
                onCancel={() => {
                  setNewFolder(false);
                }}
                onCreate={(name) => {
                  setNewFolder(false);
                  void request('bookmarks/folder-create', {
                    ...(folderId === null ? {} : { parentId: folderId }),
                    title: name,
                  }).then(reload, (cause: unknown) => {
                    setMoveResult(cause instanceof Error ? cause.message : String(cause));
                  });
                }}
              />
            ) : null}
          </header>

          <main className="body">
            {permission.granted === false && !noticeDismissed ? (
              <PermissionNotice
                onGrant={permission.request}
                onDismiss={() => {
                  setNoticeDismissed(true);
                }}
              />
            ) : null}

            {openError !== null ? (
              <div className="notice notice--warn">
                <p>{t('bookmark_open_failed', openError)}</p>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setOpenError(null);
                  }}
                >
                  {t('action_close')}
                </Button>
              </div>
            ) : null}

            {selecting ? (
              <SelectAllRow
                total={nodes.length}
                selected={nodes.filter((node) => selectedIds.has(node.id)).length}
                onSelectAll={() => {
                  // 資料夾也一起選：批量搬移對資料夾同樣有效
                  setSelectedIds((current) => new Set([...current, ...nodes.map((node) => node.id)]));
                }}
                onClearAll={() => {
                  setSelectedIds((current) => {
                    const next = new Set(current);
                    for (const node of nodes) {
                      next.delete(node.id);
                    }
                    return next;
                  });
                }}
              />
            ) : null}

            <BookmarkList
              nodes={nodes}
              density={settings.density}
              emptyMessage={
                search !== null || missingNodes !== null ? t('search_no_match') : t('folder_no_bookmarks')
              }
              onOpenFolder={(id) => {
                setFolderId(id);
                setQuery('');
                setMissing(null);
              }}
              onOpenLink={openLink}
              // 只在隱私空間已解鎖時提供移入按鈕：加密需要金鑰，鎖著時做不到。
              // 根層也不提供 —— 那一層每一列都是 Firefox 內建的永久資料夾
              // （書籤選單／書籤工具列／其他書籤），`removeTree` 對它們會失敗。
              // 讓人按下去再看到錯誤，不如一開始就不要給那個入口。
              onMoveToVault={
                vaultUnlocked && !showingRoots
                  ? (node, x, y) => {
                      setPendingMove({ nodes: [node], x, y });
                    }
                  : undefined
              }
              onContextMenu={(node, x, y) => {
                setMenu({ node, x, y });
              }}
              selecting={selecting}
              selected={selectedIds}
              onToggleSelect={toggleSelect}
              activeId={menu?.node.id ?? null}
              highlight={search !== null ? trimmed : undefined}
              locationOf={
                search !== null || missingNodes !== null
                  ? (node) => {
                      const parent = index.byId.get(index.parentOf.get(node.id) ?? '');
                      return parent === undefined ? undefined : parent.title || t('folder_untitled');
                    }
                  : undefined
              }
              // 換資料夾或換搜尋字串時，虛擬滾動要把量到的列高丟掉
              listKey={
                search !== null ? `search:${trimmed}` : missingNodes !== null ? 'missing' : (folderId ?? 'root')
              }
              grouping={inFolderView || tagResults ? { board: bookmarkList, drag: bookmarkDrag } : undefined}
              // 搜尋結果沒有「上一層」可回，最上層也沒有 —— 兩者都不提供，
              // Backspace 於是不做事，而不是把人送到一個看起來像退格失效的地方
              onNavigateUp={
                search === null && missingNodes === null && currentFolder !== undefined
                  ? () => {
                      setFolderId(index.parentOf.get(currentFolder.id) ?? null);
                    }
                  : undefined
              }
            />
          </main>
        </>
      )}

      {/*
        提示浮在工具列上方，兩個分頁都看得到 —— 訊息要出現在**觸發它的那個畫面**上
        （從隱私空間觸發的「重新抓預覽圖」結果，不能只在書籤那一頁才看得到）。
      */}
      {moveResult !== null || backfillResult !== null ? (
        <div className="toast-slot">
          {moveResult !== null ? (
            <Toast
              timeout={10_000}
              onClose={() => {
                setMoveResult(null);
              }}
            >
              {moveResult}
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
                        const target: Tab = backfillResult.kind === 'vault/backfill' ? 'vault' : 'bookmarks';
                        if (target !== tab) {
                          switchTab(target);
                        }
                        // 放在 switchTab 後面：它會清掉篩選，同一次更新裡以最後一次為準
                        setMissing({ tab: target, keys: new Set(backfillResult.missing) });
                        setQuery('');
                        setVaultQuery('');
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

      {tab === 'vault' ? (
        /*
          隱私空間這一頁也要有底部工具列 —— 密度切換對這裡的清單同樣有效，
          而「全頁瀏覽」與偶爾用到的選項不該因為切到這一頁就消失。
        */
        <Toolbar
          {...toolbarCommon}
          // 站在隱私空間按補抓，要抓的是隱私書籤（加密寫入），不是一般書籤
          backfillKind="vault/backfill"
          canSelect={vaultUnlocked}
          selectHint={t('gallery_select_hint')}
          selecting={vaultSelecting}
          selectedCount={vaultSelectedIds.size}
          selectionActions={[
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
          ]}
          onToggleSelecting={() => {
            if (vaultSelecting) {
              exitVaultSelection();
              return;
            }
            setVaultSelecting(true);
          }}
          destroyVault={
            vault.state.status === 'unlocked'
              ? {
                  count: vault.state.bookmarkCount,
                  onConfirm: () => {
                    void vault.destroy();
                  },
                }
              : undefined
          }
        />
      ) : (
        <Toolbar
          {...toolbarCommon}
          backfillKind="thumbs/backfill"
          canSelect
          // 隱藏模式下提示文字也不能提到隱私空間
          selectHint={showTabs ? t('toolbar_select_hint') : t('gallery_select_hint')}
          selecting={selecting}
          selectedCount={selectedNodes.length}
          selectionActions={[
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
                    // 資料夾整棵一起移入，所以只有「勾到的東西裡一個書籤都沒有」才無事可做
                    disabled: selectedLinkCount === 0,
                    title: selectedNodes.some((node) => node.kind === 'folder') ? t('row_import_folder_hint') : undefined,
                    onPick: (x: number, y: number) => {
                      setPendingMove({ nodes: selectedNodes, x, y });
                    },
                  },
                ]
              : []),
          ]}
          onToggleSelecting={() => {
            if (selecting) {
              exitSelection();
              return;
            }
            setSelecting(true);
          }}
        />
      )}

      {menu !== null ? (
        <RowMenu
          target={menu}
          canMoveToVault={vaultUnlocked && !showingRoots}
          onClose={() => {
            setMenu(null);
          }}
          onOpen={(url, newTab) => {
            openLink(url, newTab ? 'newTab' : 'current');
          }}
          onMoveToVault={(node) => {
            if (node.kind === 'link') {
              setPendingMove({ nodes: [node], x: menu.x, y: menu.y });
            }
          }}
          onChanged={reload}
          onNotice={setMoveResult}
          reorder={bookmarkList.reorder(menu.node.id)}
          tag={(() => {
            const tag = bookmarkList.tagActions(menu.node.id);
            const node = menu.node;
            return tag === undefined
              ? undefined
              : {
                  ...tag,
                  // 「攤平成群組」：子資料夾裡還有資料夾時不提供（那些資料夾沒有地方放）
                  onFlatten:
                    node.kind !== 'folder'
                      ? undefined
                      : node.children.some((child) => child.kind === 'folder')
                        ? null
                        : () => {
                            applyBookmarks(() => request('groups/flatten', { folderId: node.id, columns: 1 }));
                          },
                };
          })()}
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
            openLink(url, newTab ? 'newTab' : 'current');
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
          onMoveToFolder={(id, folderId) => {
            void vault.moveToFolder(id, folderId);
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
          onNotice={setMoveResult}
          reorder={vaultList.reorder(vaultMenu.kind === 'bookmark' ? vaultMenu.record.id : vaultMenu.folder.id)}
          tag={(() => {
            if (!canArrangeVault) {
              return undefined;
            }
            if (vaultMenu.kind === 'folder') {
              const folder = vaultMenu.folder;
              return {
                onSetTag: () => undefined,
                onLeave: null,
                onFlatten: vault.folders.some((candidate) => candidate.parentId === folder.id)
                  ? null
                  : () => {
                      void vault.groupFlatten(folder.id, 1);
                    },
              };
            }
            return vaultList.tagActions(vaultMenu.record.id);
          })()}
        />
      ) : null}

      {tab === 'vault' ? vaultList.popovers : bookmarkList.popovers}

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
                setMoveResult(
                  report.failed === 0
                    ? t('moved_bookmarks', tn('unit_bookmarks', report.moved))
                    : t('moved_bookmarks_with_failures', tn('unit_bookmarks', report.moved), tn('unit_failed', report.failed)),
                );
                reload();
              },
              (cause: unknown) => {
                setMoveResult(cause instanceof Error ? cause.message : String(cause));
              },
            );
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
            exitVaultSelection();
            void request('vault/move-many', { ids, folderId }).then(
              (report) => {
                setMoveResult(
                  report.failed === 0
                    ? t('moved_items', tn('unit_items', report.done))
                    : t('moved_items_with_failures', tn('unit_items', report.done), tn('unit_failed', report.failed)),
                );
                void vault.reload();
              },
              (cause: unknown) => {
                setMoveResult(cause instanceof Error ? cause.message : String(cause));
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
            exitVaultSelection();
            void request('vault/export-many', { ids, parentId }).then(
              (report) => {
                setMoveResult(
                  // 「項目」而不是「書籤」：一個項目可能是整個資料夾（連同子樹）
                  report.failed === 0
                    ? t('exported_items', tn('unit_items', report.done))
                    : t('exported_items_with_failures', tn('unit_items', report.done), tn('unit_failed', report.failed)),
                );
                reload();
              },
              (cause: unknown) => {
                setMoveResult(cause instanceof Error ? cause.message : String(cause));
              },
            );
          }}
        />
      ) : null}

      {vaultPrompt ? (
        <VaultPrompt
          state={vault.state}
          error={vault.error}
          onClose={() => {
            setVaultPrompt(false);
            vault.clearError();
          }}
          // 建立成功不等於流程結束 —— 救援金鑰要先讓使用者抄下來，所以關畫面
          // 的時機交給 onCreated（那是使用者勾了「已抄下」之後）
          onCreate={vault.create}
          onCreated={() => {
            setVaultPrompt(false);
            setTab('vault');
          }}
          onUnlockWithRecoveryKey={(code) => {
            void vault.unlockWithRecoveryKey(code).then((ok) => {
              if (ok) {
                setVaultPrompt(false);
                setTab('vault');
              }
            });
          }}
          onUnlock={(password) => {
            // 失敗時畫面留著讓人重試，原因顯示在畫面內
            void vault.unlock(password).then((ok) => {
              if (ok) {
                setVaultPrompt(false);
                setTab('vault');
              }
            });
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
            const targets = pendingMove.nodes;
            setPendingMove(null);
            exitSelection();
            const ids = targets.map((node) => node.id);
            const first = ids[0];
            if (ids.length === 1 && first !== undefined) {
              void vault.moveIn(first, purgeHistory).then(setMoveResult);
              return;
            }
            void vault.moveInMany(ids, purgeHistory).then(setMoveResult);
          }}
        />
      ) : null}
    </div>
  );
}
