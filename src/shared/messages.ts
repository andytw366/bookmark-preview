/**
 * 背景頁 ↔ 擴充套件頁面 的訊息協定。
 *
 * 設計要點：
 * 1. Protocol / EventMap 同時約束呼叫端與處理端 —— 新增訊息時只要改這裡，
 *    背景頁少實作一個 handler 會直接編譯失敗。
 * 2. 例外用 Result 包起來傳遞。Error 物件無法通過 structured clone，
 *    直接 throw 會讓呼叫端只收到 undefined，看不到原因。
 * 3. request 與 event 走不同 channel，因為兩邊都掛在 runtime.onMessage 上，
 *    必須能明確區分「這則訊息不是給我的」而回傳 undefined 不佔用回應。
 */
import { t } from './i18n';
import type {
  BookmarkFolder,
  OpenTarget,
  PrivateBookmark,
  PrivateFolder,
  Settings,
  ThumbSource,
  VaultState,
} from './types';
import type { GroupInfo } from './groups';
import type { GridOp } from './board';
import type { VaultLayout } from './vault-layout';
import type { MergeReport } from './vault-merge';

export interface OpenBookmarkRequest {
  url: string;
  where: OpenTarget;
}

export interface ThumbUsageReport {
  count: number;
  bytes: number;
}

export interface RefreshReport {
  ok: boolean;
  detail: string;
}

export interface BackfillReport {
  total: number;
  ok: number;
}

export interface ImportReport {
  state: VaultState;
  /** 移入的書籤數。移入的是資料夾時會大於 1 */
  bookmarks: number;
  /** 一併建立的隱私資料夾數。單筆書籤是 0 */
  folders: number;
  /** 實際清掉瀏覽記錄的筆數 */
  historyPurged: number;
  /** 使用者要求清除瀏覽記錄，但缺少 history 權限而沒清成 */
  historyUnavailable: boolean;
}

export interface BatchImportReport {
  state: VaultState;
  /** 移入的書籤數（不是處理了幾個項目 —— 一個資料夾可能帶進上百筆） */
  imported: number;
  /** 一併建立的隱私資料夾數 */
  folders: number;
  failed: number;
  /** 實際清掉瀏覽記錄的筆數 */
  historyPurged: number;
  /** 有任何一筆因為缺少 history 權限而沒清成 */
  historyUnavailable: boolean;
}

/** 供「移動到…」使用的扁平資料夾清單，depth 用於縮排顯示。 */
export interface FolderChoice {
  id: string;
  title: string;
  depth: number;
}

export interface VaultThumbPayload {
  bytes: ArrayBuffer;
  mime: string;
  width: number;
  height: number;
  source: ThumbSource;
}

/** 明文縮圖的位元組。形狀與 VaultThumbPayload 相同，但不經過解密。 */
export type ThumbPayload = VaultThumbPayload;

export interface VaultBackupFile {
  /** 建議的檔名（含日期），由背景頁決定讓兩個 UI 不必各自拼一份 */
  filename: string;
  json: string;
}

export interface VaultBackupImportReport {
  state: VaultState;
  /** true 代表本機原本沒有隱私空間，整份備份被直接採用 */
  adopted: boolean;
  report: MergeReport;
}

/**
 * 一次同步實際的結果。
 *
 * 定義在這裡而不是背景頁那一側，因為 UI 要靠它決定訊息文字，而 UI 不該
 * import 背景頁的模組。
 */
export type SyncOutcome =
  | 'synced'
  | 'unavailable'
  | 'disabled'
  | 'no-vault'
  | 'busy'
  | 'locked'
  | 'waiting'
  | 'deleted-elsewhere'
  | 'failed';

/**
 * 同步狀態。
 *
 * 刻意不含「Firefox Sync 是否啟用」—— 擴充套件拿不到那個資訊（沒有 API，
 * 未登入時 `storage.sync` 的寫入照樣成功、只是不會傳出去）。與其顯示一個猜的
 * 值，不如把 `remoteUpdatedAt` 攤出來讓使用者自己判斷同步有沒有在動。
 */
export interface VaultSyncStatus {
  enabled: boolean;
  /** 這個 Firefox 有沒有可用的 storage.sync */
  available: boolean;
  /** 雲端副本的狀態：沒有／還在傳（或新舊塊混雜）／完整 */
  remote: 'absent' | 'partial' | 'ok';
  remoteUpdatedAt: number | null;
  /** 雲端那份與本機是不是同一個隱私空間（salt 相同）。無從比較時為 null */
  sameVault: boolean | null;
  bytes: number;
  quota: number;
  /** 本機這份塞得進配額嗎。false 時同步會停在上一份副本 */
  wouldFit: boolean;
  hasLocalVault: boolean;
  /** 另一台裝置刪除了整個隱私空間，同步已暫停等使用者決定 */
  deletedElsewhere: boolean;
  lastError: string | null;
  lastSyncedAt: number | null;
  /**
   * 上一次同步實際做了什麼。
   *
   * 必須攤給 UI：同步在「上鎖」「還沒建立」「遠端傳輸中」時都會安靜地什麼都不做，
   * 一律回報「同步完成」會讓使用者以為資料已經上去了。
   */
  lastOutcome: SyncOutcome | null;
}

/** 原生書籤的群組。成員照閱讀順序（見 `background/bookmark-grid.ts`） */
export interface StoredGroup extends GroupInfo {
  members: string[];
}

/** 原生書籤一個資料夾的版面（`grid:<資料夾>`）：欄數（0 = 跟著視窗）與群組。順序就是原生順序 */
export interface BookmarkGrid {
  columns: number;
  groups: StoredGroup[];
}

/** 設定頁「同步書籤的排列與群組」那一區要顯示的 */
export interface GridSyncStatus {
  available: boolean;
  enabled: boolean;
  /** 合計超過預算：整個停止同步排列 */
  over: boolean;
  /** 要同步的那幾份合計多大（不含只存本機的） */
  total: number;
  budget: number;
  /** 大到放不進單筆上限、只存本機的資料夾；超過預算時則是佔最多的那幾個 */
  folders: { title: string; bytes: number; localOnly: boolean }[];
}

export type Protocol = {
  'health/ping': { request: void; response: { version: string } };
  'bookmarks/roots': { request: void; response: BookmarkFolder[] };
  'bookmarks/open': { request: OpenBookmarkRequest; response: void };
  'bookmarks/rename': { request: { id: string; title: string }; response: void };
  'bookmarks/delete': { request: { id: string }; response: void };
  'bookmarks/move': { request: { id: string; parentId: string }; response: void };
  'bookmarks/move-many': {
    request: { ids: string[]; parentId: string };
    response: { moved: number; failed: number };
  };
  /**
   * 拖拽排序：把 `ids` 依序放到 `parentId` 裡 `beforeId` 那一筆的前面（null = 最後）。
   * 不在 `parentId` 裡的會先搬過來，所以「拖進資料夾」也是這一則。
   */
  'bookmarks/reorder': {
    request: { ids: string[]; parentId: string; beforeId: string | null };
    response: { moved: number; failed: number };
  };
  /** 兩張卡片疊在一起 →「建立資料夾」：建在 `targetId` 的位置，兩者（與其餘 `ids`）搬進去 */
  'bookmarks/merge-folder': {
    request: { targetId: string; ids: string[]; title: string };
    response: { id: string };
  };
  'grid/get': { request: { folderId: string }; response: BookmarkGrid | null };
  /**
   * 一個版面操作（見 `shared/board.ts` 的 `GridOp`）。`columns` 是畫面現在的欄數：
   * 自動排列的資料夾用它換算「上下」的位置，按 − / + 時也從它開始算。
   */
  'grid/apply': { request: { folderId: string; columns: number; op: GridOp }; response: void };
  'grid/sync-status': { request: void; response: GridSyncStatus };
  'groups/to-folder': { request: { folderId: string; groupId: string; columns: number }; response: { id: string } };
  /** 子資料夾攤平成上層的一個同名群組，放在子資料夾原本的位置 */
  'groups/flatten': { request: { folderId: string; columns: number }; response: void };
  /** 拖群組的標籤到資料夾：整組照順序接在那邊最後 */
  'groups/move': {
    request: { fromFolderId: string; groupId: string; toFolderId: string; columns: number };
    response: void;
  };
  /** 搜尋的 `#名稱`：所有資料夾裡名稱相符的群組成員（`folderId` 是群組所在的資料夾） */
  'groups/find': { request: { name: string }; response: { folderId: string; id: string }[] };
  'bookmarks/folders': { request: void; response: FolderChoice[] };
  /**
   * 新增資料夾。
   *
   * `parentId` 省略時交給 Firefox 的預設位置（其他書籤）—— 原生書籤的最上層
   * 不能直接建資料夾，而寫死 `unfiled_____` 這類內部 id 比省略它更脆弱。
   */
  'bookmarks/folder-create': { request: { parentId?: string; title: string }; response: void };
  'settings/get': { request: void; response: Settings };
  'settings/patch': { request: Partial<Settings>; response: Settings };
  'thumbs/backfill': { request: void; response: BackfillReport };
  'thumbs/refresh': { request: { url: string }; response: RefreshReport };
  /**
   * 取明文縮圖的位元組。
   *
   * 一般情況側邊欄直接讀 IndexedDB（省掉每張圖的序列化來回），但**無痕視窗
   * 的擴充套件頁面拿到的是另一個、空的 IndexedDB** —— 那時只能向背景頁索取。
   */
  'thumbs/get': { request: { key: string }; response: ThumbPayload | null };
  'thumbs/usage': { request: void; response: ThumbUsageReport };
  'thumbs/clear': { request: void; response: { removed: number } };
  'site-stats/clear': { request: void; response: void };
  'vault/state': { request: void; response: VaultState };
  /** 建立隱私空間，回傳**只會顯示這一次**的救援金鑰 */
  'vault/create': { request: { password: string }; response: { state: VaultState; recoveryKey: string } };
  'vault/unlock': { request: { password: string }; response: VaultState };
  /** 用救援金鑰解鎖（忘記主密碼時唯一的出路） */
  'vault/unlock-recovery': { request: { recoveryKey: string }; response: VaultState };
  'vault/change-password': { request: { current: string; next: string }; response: void };
  /** 重新產生救援金鑰，舊的立刻失效 */
  'vault/regenerate-recovery': { request: { password: string }; response: { recoveryKey: string } };
  /** 再看一次救援金鑰（需已解鎖） */
  'vault/reveal-recovery': { request: void; response: { recoveryKey: string } };
  /** 放棄這台裝置上的隱私空間，不需要先解鎖。雲端副本不動 */
  'vault/forget': { request: void; response: VaultState };
  'vault/lock': { request: void; response: VaultState };
  'vault/list': { request: void; response: PrivateBookmark[] };
  'vault/import': { request: { bookmarkId: string; purgeHistory: boolean }; response: ImportReport };
  'vault/import-many': {
    request: { bookmarkIds: string[]; purgeHistory: boolean };
    response: BatchImportReport;
  };
  'vault/rename': { request: { id: string; title: string }; response: VaultState };
  'vault/folders': { request: void; response: PrivateFolder[] };
  'vault/folder-create': { request: { name: string; parentId: string | null }; response: void };
  'vault/folder-rename': { request: { id: string; name: string }; response: void };
  'vault/folder-delete': { request: { id: string }; response: void };
  /**
   * 搬移**資料夾**本身。
   *
   * 與 `vault/move`（搬書籤）分開而不是共用：兩者的 id 空間不同，而且資料夾多一條
   * 「不能搬進自己的子樹」的規則。少了這一條訊息時，UI 對資料夾送的是 `vault/move`，
   * 於是必定回「找不到該隱私書籤」—— 功能看起來存在，實際上永遠失敗。
   */
  'vault/folder-move': { request: { id: string; parentId: string | null }; response: void };
  'vault/move': { request: { id: string; folderId: string | null }; response: void };
  /** 版面（排列順序）。畫面與背景頁要用同一份才算得出同一個順序 */
  'vault/layout': { request: void; response: VaultLayout };
  /** 拖拽排序，語意同 `bookmarks/reorder`；`folderId: null` 是隱私空間最上層 */
  'vault/reorder': {
    request: { ids: string[]; folderId: string | null; beforeId: string | null };
    response: VaultState;
  };
  'vault/merge-folder': {
    request: { targetId: string; ids: string[]; name: string };
    response: { id: string };
  };
  /** 隱私空間的版面操作，語意與 `grid/apply` 相同；資料在加密的版面文件裡 */
  'vault/grid-apply': { request: { folderId: string | null; columns: number; op: GridOp }; response: void };
  'vault/group-to-folder': { request: { groupId: string; columns: number }; response: { id: string } };
  'vault/group-flatten': { request: { folderId: string; columns: number }; response: void };
  'vault/group-move': {
    request: { groupId: string; toFolderId: string | null; columns: number };
    response: void;
  };
  'vault/refresh-thumb': { request: { id: string }; response: RefreshReport };
  'vault/backfill': { request: void; response: BackfillReport };
  'vault/export': { request: { id: string; parentId?: string }; response: VaultState };
  'vault/export-many': {
    request: { ids: string[]; parentId?: string };
    response: { state: VaultState; done: number; failed: number };
  };
  'vault/move-many': {
    request: { ids: string[]; folderId: string | null };
    response: { done: number; failed: number };
  };
  'vault/remove': { request: { id: string }; response: VaultState };
  'vault/destroy': { request: void; response: VaultState };
  'vault/thumb': { request: { id: string }; response: VaultThumbPayload | null };
  'vault/backup-export': { request: void; response: VaultBackupFile };
  'vault/backup-import': {
    request: { json: string; secret: string; viaRecoveryKey: boolean };
    response: VaultBackupImportReport;
  };
  'vault/sync-status': { request: void; response: VaultSyncStatus };
  /** 立刻拉遠端、合併、推回去 */
  'vault/sync-now': { request: void; response: VaultSyncStatus };
  /** 以本機那份覆蓋雲端（salt 不同時唯一的出路，會讓另一台裝置的資料無法取回） */
  'vault/sync-overwrite': { request: void; response: VaultSyncStatus };
  /** 把雲端那份落到這台裝置（本機還沒有隱私空間時用） */
  'vault/sync-adopt': { request: void; response: VaultState };
  /** 移除雲端副本並關閉同步，本機資料不動 */
  'vault/sync-clear': { request: void; response: VaultSyncStatus };
  /** 清掉「另一台裝置刪除了隱私空間」的標記，重新開始同步 */
  'vault/sync-resume': { request: void; response: VaultSyncStatus };
};

export type EventMap = {
  'bookmarks/invalidated': void;
  /** 某個資料夾的群組變了（書籤那邊；隱私空間走 `vault/changed`） */
  'grid/changed': { folderId: string };
  'thumbs/updated': { key: string };
  /**
   * 全部的預覽圖都被清掉了（設定頁的「清除所有預覽圖」）。
   *
   * 不能用逐一 `thumbs/updated` 代替：那會是幾千則訊息。而少了這一則的話，開著的
   * 側邊欄會繼續顯示已經不存在的圖 —— `thumb-cache` 是記憶體裡的一份，IndexedDB
   * 清空不會動到它，使用者按了「清除」卻看不出有任何變化，要重開側邊欄才會消失。
   */
  'thumbs/cleared': void;
  'backfill/progress': { done: number; total: number; ok: number };
  'vault/changed': VaultState;
  /**
   * 同步狀態變了。
   *
   * 自動同步（寫入後、遠端變動、解鎖後）會在背景改動錯誤訊息與時間戳，而設定頁
   * 沒有別的方式知道 —— 少了這則廣播，一次失敗的自動同步在畫面上與「還沒同步過」
   * 完全一樣。
   */
  'vault/sync-changed': VaultSyncStatus;
};

export type RequestKind = keyof Protocol;
export type Req<K extends RequestKind> = Protocol[K]['request'];
export type Res<K extends RequestKind> = Protocol[K]['response'];
export type EventKind = keyof EventMap;

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

interface RequestEnvelope {
  channel: 'request';
  kind: RequestKind;
  payload: unknown;
}

interface EventEnvelope {
  channel: 'event';
  kind: EventKind;
  payload: unknown;
}

function isRequestEnvelope(value: unknown): value is RequestEnvelope {
  return typeof value === 'object' && value !== null && (value as RequestEnvelope).channel === 'request';
}

function isEventEnvelope(value: unknown): value is EventEnvelope {
  return typeof value === 'object' && value !== null && (value as EventEnvelope).channel === 'event';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── 呼叫端（側邊欄／設定頁）────────────────────────────────────────────

export async function request<K extends RequestKind>(kind: K, payload: Req<K>): Promise<Res<K>> {
  const envelope: RequestEnvelope = { channel: 'request', kind, payload };
  const result = (await browser.runtime.sendMessage(envelope)) as Result<Res<K>> | undefined;
  if (result === undefined) {
    throw new Error(t('msg_no_response', kind));
  }
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.data;
}

export function subscribe<K extends EventKind>(kind: K, onEvent: (payload: EventMap[K]) => void): () => void {
  const listener = (message: unknown): undefined => {
    if (isEventEnvelope(message) && message.kind === kind) {
      onEvent(message.payload as EventMap[K]);
    }
    return undefined;
  };
  browser.runtime.onMessage.addListener(listener);
  return () => {
    browser.runtime.onMessage.removeListener(listener);
  };
}

// ── 處理端（背景頁）────────────────────────────────────────────────────

export type Handlers = {
  [K in RequestKind]: (payload: Req<K>) => Promise<Res<K>>;
};

export function serve(handlers: Handlers): void {
  browser.runtime.onMessage.addListener((message: unknown) => {
    if (!isRequestEnvelope(message)) {
      // 不是請求（例如自己廣播的事件）→ 回傳 undefined，不佔用這則訊息的回應
      return undefined;
    }
    const handler = handlers[message.kind] as ((payload: unknown) => Promise<unknown>) | undefined;
    if (handler === undefined) {
      return Promise.resolve<Result<never>>({ ok: false, error: t('msg_unknown_kind', message.kind) });
    }
    return handler(message.payload).then(
      (data): Result<unknown> => ({ ok: true, data }),
      (error: unknown): Result<never> => ({ ok: false, error: describe(error) }),
    );
  });
}

export function broadcast<K extends EventKind>(kind: K, payload: EventMap[K]): void {
  const envelope: EventEnvelope = { channel: 'event', kind, payload };
  // 側邊欄關閉時沒有接收端，會 reject —— 這是預期狀況，忽略即可
  browser.runtime.sendMessage(envelope).catch(() => undefined);
}
