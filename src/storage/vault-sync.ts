import { fromChunks } from '@/crypto/chunk';
import type { VaultMeta } from '@/shared/types';
import { textDigest } from '@/shared/vault-merge';

/**
 * `storage.sync` 上那份加密副本的讀寫。
 *
 * 版面配置：
 *
 * ```
 * vaultSync       中介資料（明文）：salt / iterations / 兩份金鑰包裹 / 塊數 / 指紋
 * vaultSyncC0     加密 base64 的第 0 塊
 * vaultSyncC1     ...
 * vaultSyncGone   刪除標記：某台裝置刪掉了整個隱私空間
 * ```
 *
 * **整份 `VaultMeta` 明文放在這裡**（salt、KDF 參數、兩個包裹）。這不是疏漏：換一台
 * 裝置時得先派生出金鑰才能解開任何東西，而那些欄位本身不是秘密 —— 包裹是密文，
 * salt 的作用只是讓同一組密碼在不同 vault 產出不同金鑰。代價要講清楚：能讀到這個
 * Firefox 帳號的人可以離線暴力猜密碼 —— 這是設定頁必須說明的事。
 *
 * 存的是**整個物件**而不是逐個欄位複製。欄位一多，「同步這邊少帶一個」就會變成
 * 換裝置後打不開，而那種錯誤只在換裝置時才看得到。
 *
 * 中介資料帶兩個指紋，各解決一個具體的失敗：
 *
 * - `digest`：整份密文的雜湊。storage.sync 是**逐筆**傳播的，另一台裝置很可能在
 *   塊還沒到齊時就收到 meta，甚至同時持有「新的 meta + 新舊混雜的塊」。只比長度
 *   擋不住混雜（兩代密文長度常常一樣），拿去解密會得到看不懂的驗證失敗。
 * - `tag`：**內容**的指紋（與加密無關）。用來判斷「本機與雲端內容是否已相同」，
 *   密文做不到這件事，見 `contentTag` 的說明。
 *
 * 寫入順序是**先塊、後 meta**：meta 帶著塊數與指紋，等於「這份副本完整了」的
 * 認可標記。反過來寫的話，中途失敗會留下一份指向舊塊數的 meta 配新內容的塊。
 */
export const SYNC_META_KEY = 'vaultSync';
export const SYNC_CHUNK_PREFIX = 'vaultSyncC';
export const SYNC_GONE_KEY = 'vaultSyncGone';
const DEVICE_KEY = 'vaultSyncDeviceId';

export interface SyncMeta {
  version: 1;
  /** 那個隱私空間的中介資料，原樣搬過來 */
  vault: VaultMeta;
  chunks: number;
  /** 整份密文的雜湊，用於判斷塊是否湊齊且屬於同一代 */
  digest: string;
  /** 內容指紋（與加密無關），用於判斷本機與雲端內容是否相同 */
  tag: string;
  updatedAt: number;
  /** 寫入者的裝置 id，讓 onChanged 能跳過自己寫的那次 */
  deviceId: string;
}

/** 「某台裝置刪掉了整個隱私空間」的標記。 */
export interface SyncGone {
  at: number;
  deviceId: string;
}

export type SyncRead =
  | { kind: 'absent' }
  /**
   * 雲端有東西但現在還用不了：塊沒到齊、新舊混雜，或連 meta 都還沒到。
   * 稍後會自己好，不要當成損毀、更不要覆蓋它。`meta` 為 null 代表 meta 還沒到。
   */
  | { kind: 'partial'; meta: SyncMeta | null }
  | { kind: 'ok'; meta: SyncMeta; blob: string };

/**
 * `storage.sync` 是否可用。
 *
 * 與 `captureVisibleTab` 同樣的教訓：檢查函式本身而不只是「有沒有這個屬性」。
 * 企業政策關掉同步時 `browser.storage.sync` 仍可能存在但不能用。
 */
export function syncAvailable(): boolean {
  const area = (browser.storage as { sync?: { set?: unknown } }).sync;
  return typeof area?.set === 'function';
}

function chunkKeys(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${SYNC_CHUNK_PREFIX}${String(index)}`);
}

function isSyncMeta(value: unknown): value is SyncMeta {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const meta = value as Partial<SyncMeta>;
  const vault = meta.vault as Partial<VaultMeta> | undefined;
  return (
    meta.version === 1 &&
    typeof vault?.salt === 'string' &&
    vault.salt !== '' &&
    typeof vault.iterations === 'number' &&
    typeof vault.passwordWrap?.ct === 'string' &&
    typeof vault.recoveryWrap?.ct === 'string' &&
    typeof meta.chunks === 'number' &&
    meta.chunks > 0 &&
    typeof meta.digest === 'string' &&
    typeof meta.tag === 'string' &&
    typeof meta.updatedAt === 'number' &&
    typeof meta.deviceId === 'string'
  );
}

export async function readSyncMeta(): Promise<SyncMeta | null> {
  if (!syncAvailable()) {
    return null;
  }
  const stored = await browser.storage.sync.get(SYNC_META_KEY);
  const value = stored[SYNC_META_KEY];
  return isSyncMeta(value) ? value : null;
}

/**
 * 雲端上有沒有一份（哪怕還不完整的）副本。
 *
 * **不能只看 meta。** 寫入順序是先塊後 meta，所以「塊已經到了、meta 還沒到」是
 * 正常的傳播中狀態；未來版本寫的 meta 被 `isSyncMeta` 判為不認識也會落到同一個
 * 情況。那個空窗期若判定成「雲端什麼都沒有」，使用者會看到建立畫面、建出一個
 * 新 salt 的 vault，接著把雲端那份唯一的副本覆蓋掉。
 */
export async function syncEnvelopePresent(): Promise<boolean> {
  if (!syncAvailable()) {
    return false;
  }
  if ((await readSyncMeta()) !== null) {
    return true;
  }
  const all = await browser.storage.sync.get(null);
  return Object.keys(all).some((key) => key.startsWith(SYNC_CHUNK_PREFIX));
}

export async function readSyncEnvelope(): Promise<SyncRead> {
  const meta = await readSyncMeta();
  if (meta === null) {
    // 沒有可用的 meta 但塊還在：那是傳播中（或未來版本寫的），絕對不能當成「雲端是空的」
    return (await syncEnvelopePresent()) ? { kind: 'partial', meta: null } : { kind: 'absent' };
  }
  const keys = chunkKeys(meta.chunks);
  const stored = await browser.storage.sync.get(keys);
  const parts: string[] = [];
  for (const key of keys) {
    const part = stored[key];
    if (typeof part !== 'string') {
      return { kind: 'partial', meta };
    }
    parts.push(part);
  }
  const blob = fromChunks(parts);
  // 指紋不合就是還沒傳完或新舊混雜。這時**絕對不要**拿去解密或覆蓋
  if ((await textDigest(blob)) !== meta.digest) {
    return { kind: 'partial', meta };
  }
  return { kind: 'ok', meta, blob };
}

export interface SyncIdentity {
  vault: VaultMeta;
  /** 內容指紋；還沒算過時傳空字串代表「未知」 */
  tag: string;
  deviceId: string;
}

export async function writeSyncEnvelope(
  identity: SyncIdentity,
  chunks: readonly string[],
): Promise<SyncMeta> {
  const items: Record<string, string> = {};
  chunks.forEach((chunk, index) => {
    items[`${SYNC_CHUNK_PREFIX}${String(index)}`] = chunk;
  });
  await browser.storage.sync.set(items);

  const blob = fromChunks(chunks);
  const meta: SyncMeta = {
    version: 1,
    vault: identity.vault,
    chunks: chunks.length,
    digest: await textDigest(blob),
    tag: identity.tag,
    updatedAt: Date.now(),
    deviceId: identity.deviceId,
  };
  await browser.storage.sync.set({ [SYNC_META_KEY]: meta });

  await removeStaleChunks(chunks.length);
  /*
   * 一份完整的新副本取代了刪除標記。
   *
   * 少了這一行，「A 刪掉隱私空間 → A 重新建立 → A 上傳」之後，B 會永遠停在
   * 「另一台裝置刪除了隱私空間」，而那句話已經不是事實，B 也永遠不會去合併
   * 雲端上那份確實存在的副本。
   */
  await clearSyncGone();
  return meta;
}

/**
 * 清掉塊號 >= `keep` 的殘塊。
 *
 * 直接列出 sync 上實際存在的鍵，而不是依賴「上一份 meta 說有幾塊」——
 * meta 可能被刪掉或還沒傳到，那時殘塊就會永遠留著佔配額，最後表現成
 * 「資料明明放得進去，同步卻回報超過額度」。
 */
async function removeStaleChunks(keep: number): Promise<void> {
  const all = await browser.storage.sync.get(null);
  const stale = Object.keys(all).filter((key) => {
    if (!key.startsWith(SYNC_CHUNK_PREFIX)) {
      return false;
    }
    const index = Number(key.slice(SYNC_CHUNK_PREFIX.length));
    return Number.isInteger(index) && index >= keep;
  });
  if (stale.length > 0) {
    await browser.storage.sync.remove(stale);
  }
}

export async function clearSyncEnvelope(): Promise<void> {
  if (!syncAvailable()) {
    return;
  }
  // meta 先移除：即使接著清塊時失敗，也不會留下一份指向殘塊的認可標記
  await browser.storage.sync.remove(SYNC_META_KEY);
  await removeStaleChunks(0);
}

// ── 刪除標記 ──────────────────────────────────────────────────────────

/**
 * 記下「隱私空間已被刪除」。
 *
 * 沒有這個標記的話，刪除會被其他裝置復原：A 刪掉隱私空間並清空雲端副本，B 收到
 * 「雲端沒有副本」就把自己那份推上去，A 下次同步又把整個隱私空間拉回來 ——
 * 使用者按了刪除，資料卻自己回來了。
 *
 * 標記只讓其他裝置**停下來並詢問**，不會自動刪掉它們的資料：遠端的一個旗標不該
 * 有權銷毀本機資料。帶 deviceId 是為了讓寫下標記的那台裝置忽略自己的標記
 * （否則它之後重新建立隱私空間時會被自己擋住）。
 */
export async function writeSyncGone(deviceId: string): Promise<void> {
  if (!syncAvailable()) {
    return;
  }
  const marker: SyncGone = { at: Date.now(), deviceId };
  await browser.storage.sync.set({ [SYNC_GONE_KEY]: marker });
}

export async function readSyncGone(): Promise<SyncGone | null> {
  if (!syncAvailable()) {
    return null;
  }
  const stored = await browser.storage.sync.get(SYNC_GONE_KEY);
  const value = stored[SYNC_GONE_KEY] as Partial<SyncGone> | undefined;
  if (typeof value?.at !== 'number' || typeof value.deviceId !== 'string') {
    return null;
  }
  return { at: value.at, deviceId: value.deviceId };
}

export async function clearSyncGone(): Promise<void> {
  if (!syncAvailable()) {
    return;
  }
  await browser.storage.sync.remove(SYNC_GONE_KEY);
}

/** 這份副本目前佔用的配額。拿不到精確值時用 meta 回推估算。 */
export async function syncBytesInUse(): Promise<number> {
  if (!syncAvailable()) {
    return 0;
  }
  const area = browser.storage.sync as unknown as {
    getBytesInUse?: (keys?: string | string[] | null) => Promise<number>;
  };
  if (typeof area.getBytesInUse === 'function') {
    try {
      return await area.getBytesInUse(null);
    } catch {
      // 落到下面的估算
    }
  }
  const meta = await readSyncMeta();
  if (meta === null) {
    return 0;
  }
  return meta.chunks * (7_500 + SYNC_CHUNK_PREFIX.length) + 256;
}

/**
 * 這台裝置的識別碼。
 *
 * 只有一個用途：`storage.onChanged` 對自己寫進 sync 的內容也會觸發，靠 deviceId
 * 才能分辨「遠端有新東西」與「這是我剛寫的」。用旗標變數不行 —— MV3 事件頁隨時
 * 被卸載，旗標活不過那個空檔。
 */
export async function deviceId(): Promise<string> {
  const stored = await browser.storage.local.get(DEVICE_KEY);
  const existing = stored[DEVICE_KEY];
  if (typeof existing === 'string' && existing !== '') {
    return existing;
  }
  const fresh = crypto.randomUUID();
  await browser.storage.local.set({ [DEVICE_KEY]: fresh });
  return fresh;
}
