import type { WrappedKey } from '@/crypto/keyring';

export type { WrappedKey };

/**
 * 書籤的統一呈現型別。
 *
 * `source` 只會是 'native'。原本預留了 'vault'，設想隱私書籤會走同一個形狀進側邊欄；
 * 實際做出來不是這樣 —— 隱私書籤有自己的型別與自己的渲染路徑（`PrivateBookmark`），
 * 那個分支從來沒有人產生、也沒有人判斷過，所以拿掉了。
 */
export type BookmarkSource = 'native';

interface BookmarkBase {
  id: string;
  parentId: string | null;
  title: string;
  dateAdded: number | null;
  source: BookmarkSource;
}

export interface BookmarkFolder extends BookmarkBase {
  kind: 'folder';
  children: BookmarkNode[];
}

export interface BookmarkLink extends BookmarkBase {
  kind: 'link';
  url: string;
}

export type BookmarkNode = BookmarkFolder | BookmarkLink;

export type OpenTarget = 'current' | 'newTab' | 'newTabBackground';

// ── 預覽縮圖 ──────────────────────────────────────────────────────────

/**
 * 縮圖來源。
 *
 * - `cover`：頁面的內容封面圖（漫畫／書籍封面、影片縮圖）。維持原始長寬比。
 * - `capture`：網頁畫面截圖，統一裁切成 16:9。
 * - `og`：手動補抓時從伺服器端解析出的 og:image。
 * - `icon`：網站圖示。書籤是「入口網址」（`isEntryUrl`）而且設定 `entryIcons` 開著時才會有，
 *   畫成素色方塊正中間一個圖示，見 `src/background/site-icon.ts`。
 */
export type ThumbSource = 'cover' | 'capture' | 'og' | 'icon';

/** 有封面圖時優先用封面，還是優先用網頁截圖。 */
export type PreviewSource = 'cover-first' | 'screenshot-first';

export interface ThumbRecord {
  /** SHA-256(正規化後的網址) */
  key: string;
  /** 圖片位元組。隱私書籤的縮圖存的是 AES-GCM 密文。 */
  bytes: ArrayBuffer;
  /** 密文的 MIME 型別在解密後才知道，因此一併記下。 */
  mime: string;
  source: ThumbSource;
  capturedAt: number;
  width: number;
  height: number;
  /** true 時 bytes 為密文，需以主密碼解密後才能顯示。 */
  encrypted: boolean;
  /** AES-GCM 的 IV，未加密時為 null。 */
  iv: Uint8Array | null;
}

// ── 隱私空間 ──────────────────────────────────────────────────────────

/**
 * 隱私書籤。
 *
 * 帶 updatedAt 與 deleted 墓碑是為了 M4 的跨裝置合併：storage.sync 的
 * 同步週期是 10 分鐘，兩台裝置並行編輯時整塊覆蓋會掉資料，必須能逐筆合併。
 * 墓碑保留 30 天後才實體清除，否則刪除會在下次同步時「復活」。
 */
export interface PrivateBookmark {
  id: string;
  url: string;
  title: string;
  folderId: string | null;
  createdAt: number;
  updatedAt: number;
  deleted?: true;
}

export interface PrivateFolder {
  id: string;
  name: string;
  parentId: string | null;
  updatedAt: number;
  deleted?: true;
}

export interface VaultPayload {
  version: 1;
  bookmarks: PrivateBookmark[];
  folders: PrivateFolder[];
}

/**
 * 明文儲存的隱私空間中介資料。
 *
 * salt 與兩個包裹都必須是明文，否則換裝置後無法從主密碼（或救援金鑰）派生出金鑰 ——
 * 那份加密資料就永遠打不開了。包裹本身是密文，明文放著不洩漏任何東西。
 *
 * 沒有「驗證器」欄位：解不開 `passwordWrap` 本身就是「密碼錯誤」的答案，
 * 而且比解整包書籤便宜得多。少一個欄位就少一個會與實際金鑰不同步的地方。
 */
export interface VaultMeta {
  /** 格式版本。1 是「密碼直接加密資料」的舊格式，已不支援 */
  version: 2;
  /** base64 的 KDF salt */
  salt: string;
  /** 記下 KDF 參數，日後調高迭代次數時舊資料仍能開啟 */
  iterations: number;
  /** 資料金鑰被「主密碼派生的金鑰」包起來的那一份 */
  passwordWrap: WrappedKey;
  /** 資料金鑰被「救援金鑰派生的金鑰」包起來的那一份 */
  recoveryWrap: WrappedKey;
  /**
   * 救援金鑰本身，以資料金鑰加密。
   *
   * 為了讓使用者事後還能再看一次那串碼（抄錯、抄丟都很常見）。這不會削弱什麼：
   * 要解開它得先有資料金鑰，而有資料金鑰的人本來就已經看得到全部內容了。
   */
  recoveryCodeSealed: WrappedKey;
  /**
   * 這份中介資料上次被改動的時間（更改主密碼、重新產生救援金鑰）。
   *
   * 同步需要它才能決定「誰的包裹比較新」。少了它，在 A 改的密碼永遠到不了 B ——
   * B 只在「自己完全沒有隱私空間」時才會採用雲端的中介資料，於是 B 會一直只認舊密碼。
   */
  metaUpdatedAt: number;
  createdAt: number;
}

export type VaultState =
  | { status: 'absent' }
  | { status: 'locked' }
  | { status: 'unlocked'; bookmarkCount: number }
  /** 舊格式（version 1）的隱私空間。已不支援，只能刪除後重建 */
  | { status: 'legacy' };

// ── 設定 ──────────────────────────────────────────────────────────────

export type Density = 'card' | 'row' | 'text';

/**
 * 隱私空間的入口方式。
 *
 * 預設 hidden：側邊欄完全不顯示任何跟隱私空間有關的東西。要進去就在搜尋框
 * 輸入主密碼再按 Enter —— 密碼錯誤時的反應與「搜尋不到東西」一模一樣，
 * 從外觀上看不出這個擴充套件有隱私空間。
 *
 * 一個看得見的「隱私空間」分頁本身就洩漏了「這個人有東西要藏」，
 * 那違背了整個功能的目的。
 */
export type VaultEntry = 'hidden' | 'tab';

export interface Settings {
  /** 瀏覽已加入書籤的頁面時自動擷取縮圖 */
  captureEnabled: boolean;
  /**
   * 預設 cover-first：對漫畫、影片、商品這類「內容頁」，站方或頁面上的封面圖
   * 比網頁截圖更能代表這個書籤。找不到封面才退回截圖。
   */
  previewSource: PreviewSource;
  /**
   * 書籤指的是「一個網站」而不是「一則內容」時（`isEntryUrl`：路徑最多一層、沒有 query），
   * 預覽改用網站圖示。預設開。
   *
   * 關掉時不主動把既有的圖示換回來，要等過期或手動「重新抓預覽圖」。
   */
  entryIcons: boolean;
  /** 不擷取的網域樣式（子字串比對主機名稱） */
  captureBlocklist: string[];
  /** 縮圖多久後視為過期而重新擷取 */
  thumbMaxAgeDays: number;
  density: Density;
  autoLockMinutes: number;
  vaultEntry: VaultEntry;
  /**
   * 在搜尋框打這段字就跳出隱私空間的密碼畫面。
   *
   * 可調整不只是方便：預設值是公開的，知道它的人打一次就能看出這台機器有沒有
   * 隱私空間。改成只有自己知道的字串，那個推測就無從下手。空字串等於停用。
   */
  vaultTrigger: string;
  /**
   * 移出隱私空間時的預設目標資料夾（原生書籤 ID）。
   *
   * null 代表交給 Firefox 的預設位置（其他書籤）。這個資料夾可能被使用者
   * 事後刪掉，所以移出時建立失敗要退回預設位置，不能整個失敗。
   */
  vaultExportFolderId: string | null;
  /**
   * 把一份加密副本放進 `storage.sync`，讓其他裝置能取得。
   *
   * **預設關閉，而且必須是使用者自己打開的。** 開啟等於把加密後的書籤交給
   * Mozilla 的同步伺服器保管 —— 內容仍然只有主密碼能解開，但「資料完全不離開
   * 這台裝置」這個性質就不再成立了，那不該由預設值替使用者決定。
   */
  vaultSyncEnabled: boolean;
  /**
   * 書籤的排列與群組（固定格子）跟著 `storage.sync` 到其他裝置。
   *
   * **預設打開**：群組名稱與排列本來就是明文書籤的一部分，不像隱私空間那樣需要使用者
   * 自己決定。固定佔 20 KB（見 `storage/grid-sync.ts`）。
   */
  syncGrid: boolean;
}
