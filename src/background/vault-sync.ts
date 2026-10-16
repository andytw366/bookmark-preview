import { gridSyncReserve } from '@/storage/grid-sync';
import { toBase91 } from '@/crypto/base91';
import type { Bytes } from '@/crypto/bytes';
import { fitsInSync, SYNC_META_RESERVE, SYNC_TOTAL_BUDGET, toChunks } from '@/crypto/chunk';
import { isSyncFolderIdSync, removeSyncFolder } from '@/storage/bookmark-store';
import { broadcast } from '@/shared/messages';
import type { SyncOutcome, VaultSyncStatus } from '@/shared/messages';
import { getSettings, patchSettings } from '@/storage/settings';
import {
  clearSyncEnvelope,
  clearSyncGone,
  deviceId,
  readSyncEnvelope,
  readSyncGone,
  SYNC_CHUNK_PREFIX,
  SYNC_META_KEY,
  syncAvailable,
  syncBytesInUse,
  type SyncRead,
} from '@/storage/vault-sync';
import {
  clearLayoutEnvelope,
  LAYOUT_CHUNK_PREFIX,
  LAYOUT_META_KEY,
  readLayoutEnvelope,
} from '@/storage/layout-sync';
import {
  clearPackEnvelope,
  PACK_CHUNK_PREFIX,
  PACK_META_KEY,
  PACK_META_VERSION,
  PACK_META_VERSION_SYNC,
  packStoreOf,
  readPackEnvelope,
  readPackMeta,
  writePackEnvelope,
  type PackStore,
  type PackSyncMeta,
} from '@/storage/pack-sync';
import { readMeta } from '@/storage/vault-store';
import {
  adoptRemoteMeta,
  isUnlocked,
  mergeEncryptedBlob,
  mergeEncryptedLayout,
  mergeEncryptedPack,
  packedSnapshot,
  RemoteBlobUnreadable,
  setPersistHook,
  vaultState,
} from './vault';
import type { VaultMeta } from '@/shared/types';
import { t } from '@/shared/i18n';

/**
 * 跨裝置同步。
 *
 * 主儲存永遠是 `storage.local`（沒有實務上的容量上限），`storage.sync` 只放一份
 * 加密副本。100 KB 的額度因此只約束「能同步多少」，不約束「能存多少」。
 *
 * 四條核心決定，每一條都對應一個實際會弄丟資料的情境：
 *
 * 1. **只在解鎖時合併並上傳。** 合併必須解開遠端那份，而金鑰只在解鎖時存在。上鎖
 *    時把本機那份推上去會直接覆蓋另一台裝置新增的東西 —— 靜默的資料遺失，比
 *    「這次沒同步到」嚴重得多。
 * 2. **遠端「還沒傳完」時什麼都不做。** storage.sync 是逐筆傳播的，塊沒到齊時我們
 *    手上沒有完整的遠端內容，這時上傳就是覆蓋。這一條特別容易漏 —— 把關若只寫在
 *    「遠端完整」那個分支裡，最該保守的時刻反而變成無條件覆蓋。
 * 3. **salt 不同就停下來並回報。** salt 不同代表兩邊是各自建立的隱私空間，金鑰互不
 *    相通，沒有任何合併的可能。只能讓使用者明確選一邊，絕不自動決定。
 * 4. **用內容指紋而不是密文判斷「是否需要上傳」。** 每次加密都用新的 IV，同一份內容
 *    的密文永遠不同；用密文判斷會讓兩台裝置無止盡地互相覆蓋。
 *
 * 雲端的格式（1.3.0 之後）是書籤＋版面合成一份的精簡編碼（`storage/pack-sync`、
 * `shared/sync-pack`）。1.3.x 以前的兩份（`vaultSync*`、`vaultLayout*`）讀到就合併進來，
 * 推上新格式時刪掉 —— 兩種格式同時放會超過 100 KB。還沒更新的裝置看不懂新格式，會把
 * 自己那份用舊格式推回來；那也沒關係，下一輪合併後再刪一次，等它更新完就停了。
 * 精簡格式要有金鑰才編得出來，所以**上鎖時一律不推**（以前雲端沒有副本時上鎖也會推）。
 *
 * 雲端那份的塊可以放在 `storage.sync`（預設）或書籤裡（「改用書籤同步」，`storage/bookmark-store`）。
 * 放哪裡是**雲端 meta 的屬性**：推送一律照雲端 meta 的 `store` 寫回同一個地方，雲端還沒有 meta 時
 * 才看本機設定 `vaultSyncBookmarks`。換地方只有 `setSyncStore` 一條路。
 *
 * 已知限制（設定頁要照實說）：
 * - Firefox for Android 完全不同步 `storage.sync`（Mozilla bug 1625257）。
 * - 同步週期約 10 分鐘，不是即時。
 * - 主密碼不同步，每台裝置都要各自輸入一次。
 * - 擴充套件無法得知使用者是否已登入 Firefox 帳號，所以只能靠雲端那份的時間戳
 *   讓使用者自己判斷同步有沒有在動。
 */

/**
 * 寫入後的延遲。
 *
 * 批量移入會連續 persist 幾十次，每次都推上雲端等於浪費寫入配額。
 * 不能拉太長：MV3 事件頁閒置約 30 秒就卸載，等太久那次推送就消失了
 * （下一次寫入或解鎖會補上，所以不是永久遺失，只是延後）。
 */
const DEBOUNCE_MS = 2_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let lastError: string | null = null;
let lastSyncedAt: number | null = null;
let lastOutcome: SyncOutcome | null = null;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 兩份中介資料指的是不是同一個隱私空間（同一把金鑰派生得出來）。 */
function sameVault(remote: { vault: VaultMeta }, local: VaultMeta): boolean {
  return remote.vault.salt === local.salt && remote.vault.iterations === local.iterations;
}

/**
 * 中介資料的內容是否完全相同。
 *
 * 「內容指紋一樣」只代表**書籤**沒變，中介資料可能已經變了：更改主密碼與重新產生
 * 救援金鑰都只換掉包裹、完全不動書籤。少了這個比較，那兩個操作就不會被上傳 ——
 * 其他裝置會繼續只認舊密碼、或讓已經失效的舊救援金鑰照樣開得了。
 */
function sameMetaContent(remote: VaultMeta, local: VaultMeta): boolean {
  return (
    remote.salt === local.salt &&
    remote.iterations === local.iterations &&
    remote.passwordWrap.ct === local.passwordWrap.ct &&
    remote.recoveryWrap.ct === local.recoveryWrap.ct &&
    remote.recoveryCodeSealed.ct === local.recoveryCodeSealed.ct
  );
}

export function startVaultSync(): void {
  setPersistHook(() => {
    scheduleVaultSync();
  });

  if (!syncAvailable()) {
    return;
  }

  /*
   * 遠端有新東西就拉下來合併。
   *
   * 自己寫的那次也會觸發這個監聽器，靠 deviceId 分辨（旗標變數活不過事件頁
   * 被卸載的空檔，deviceId 存在 storage.local 才可靠）。
   */
  browser.storage.onChanged.addListener((changes, area) => {
    // 舊格式那兩份也要聽：還沒更新的裝置推上來的東西要合併進來（再刪掉）
    const changedKey = [PACK_META_KEY, SYNC_META_KEY, LAYOUT_META_KEY].find((name) => name in changes);
    if (area !== 'sync' || changedKey === undefined) {
      return;
    }
    const incoming = changes[changedKey]?.newValue as { deviceId?: unknown } | undefined;
    /*
     * 移除事件（`newValue` 不存在）不代表遠端有新資料。
     *
     * 少了這一條，「移除雲端副本」會立刻觸發一次同步、把副本原封不動地推回去 ——
     * 使用者按了移除，訊息說移除成功，副本卻還在雲端。
     */
    if (incoming === undefined) {
      return;
    }
    void deviceId().then(async (mine) => {
      if (incoming.deviceId === mine) {
        return;
      }
      await syncVault();
    }, () => undefined);
  });

  /*
   * 塊放在書籤裡時，書籤同步帶來的塊不會觸發 `storage.onChanged`。meta 常常比塊先到 ——
   * 那一輪讀到的是「傳輸中」，少了這組監聽器就要等到下一次本機寫入才會再看一次。
   *
   * 走同一個 debounce：書籤同步是逐筆到的，幾十塊會連續觸發幾十次。自己寫入也會觸發，
   * 多出來的那一輪讀到指紋相同就不會再寫，不會互相觸發下去。
   */
  const inFolder = (...ids: (string | undefined)[]): boolean =>
    ids.some((id) => id !== undefined && isSyncFolderIdSync(id));
  browser.bookmarks.onCreated.addListener((id, node) => {
    if (inFolder(id, node.parentId)) {
      scheduleVaultSync();
    }
  });
  browser.bookmarks.onRemoved.addListener((id, info) => {
    if (inFolder(id, info.parentId)) {
      scheduleVaultSync();
    }
  });
  browser.bookmarks.onMoved.addListener((id, info) => {
    if (inFolder(id, info.parentId, info.oldParentId)) {
      scheduleVaultSync();
    }
  });
  // onChanged 只給 id：塊被改了網址要讀一次才知道它在不在資料夾裡
  browser.bookmarks.onChanged.addListener((id) => {
    if (inFolder(id)) {
      scheduleVaultSync();
      return;
    }
    void browser.bookmarks.get(id).then(
      ([node]) => {
        if (inFolder(node?.parentId)) {
          scheduleVaultSync();
        }
      },
      () => undefined,
    );
  });
}

export function scheduleVaultSync(): void {
  if (timer !== null) {
    clearTimeout(timer);
  }
  timer = setTimeout(() => {
    timer = null;
    void syncVault();
  }, DEBOUNCE_MS);
}

/** 雲端還沒有（看得懂的）meta 時，新的一份放哪裡：本機設定決定的初值 */
async function defaultStore(): Promise<PackStore> {
  return (await getSettings()).vaultSyncBookmarks ? 'bookmarks' : 'sync';
}

/**
 * 隱私空間在 `storage.sync` 實際能用的 KB 數：100 KB 扣掉 meta 的餘裕與書籤排列那份（與 `fits` 同一個算法）。
 * 訊息裡寫這個數字而不是 100 —— 寫 100 會出現「約 98 KB，超過 100 KB 額度」這種讀起來自相矛盾的句子。
 */
async function vaultBudgetKb(): Promise<number> {
  return Math.floor((SYNC_TOTAL_BUDGET - SYNC_META_RESERVE - (await gridSyncReserve())) / 1024);
}

async function quotaMessage(blob: string): Promise<string> {
  return t('sync_quota_exceeded', Math.ceil(blob.length / 1024), await vaultBudgetKb());
}

/**
 * 拉遠端 → 合併 → 推回去。
 *
 * 自動觸發的路徑（寫入後、遠端變動、解鎖後）都走這裡，所以「條件不成立」一律
 * 回傳一個結果而不丟錯。呼叫端（設定頁的「立刻同步」）要根據結果說實話，
 * 不能一律顯示「同步完成」—— 明明因為上鎖而什麼都沒做卻說合併好了，
 * 使用者會以為資料已經上去了。
 */
export async function syncVault(): Promise<SyncOutcome> {
  return runSync();
}

/**
 * `syncVault` 的本體。`pushTo`：合併完推到指定的存放位置，而不是雲端 meta 說的那裡 —— 只給
 * `setSyncStore('bookmarks')` 用。
 *
 * 為什麼要有它：「改用書籤同步」最需要的時刻正是 `storage.sync` 塞不下的時候，而那時照雲端 meta
 * 推回 `storage.sync` 一定因為超額而失敗，`syncVault` 回 `failed`，切換就永遠按不成
 * （2026-10-16 D 期實機抓到：超額提示裡的「改用書籤同步」按了只會再顯示一次超額訊息）。
 * 合併的規則一條都沒有放寬：一樣要解鎖、遠端傳輸中一樣停下、salt 不同一樣停下，
 * 只是合併完的那份直接寫進書籤（先塊後 meta，寫完刪 `vaultPackC*`）。
 */
async function runSync(pushTo?: PackStore): Promise<SyncOutcome> {
  if (!syncAvailable()) {
    return finish('unavailable');
  }
  // 旗標必須在任何 await 之前就設好：三條觸發路徑可能在同一個 tick 內都進到這裡，
  // 「先檢查、await 幾次、再設旗標」等於沒有互斥，兩個合併交錯就會弄丟一邊的資料
  if (running) {
    // 也要記下來並廣播：否則使用者按「立刻同步」時，畫面會顯示**上一次**的結果，
    // 看起來像這次點擊完成了同步
    return finish('busy');
  }
  running = true;
  try {
    if (!(await getSettings()).vaultSyncEnabled) {
      return finish('disabled');
    }
    const local = await readMeta();
    if (local === null) {
      return finish('no-vault');
    }

    const gone = await readSyncGone();
    if (gone !== null && gone.deviceId !== (await deviceId())) {
      // 另一台裝置刪掉了整個隱私空間。不自動刪本機那份（遠端的一個旗標不該有權
      // 銷毀本機資料），但也不能把它推回去 —— 那正是「刪了又自己回來」的成因。
      lastError = t('sync_deleted_elsewhere');
      return finish('deleted-elsewhere');
    }

    const pack = await readPackEnvelope();
    const legacy = await readSyncEnvelope();
    const packMeta = pack.kind === 'absent' ? null : pack.meta;
    const legacyMeta = legacy.kind === 'absent' ? null : legacy.meta;

    // salt 不同代表兩邊是各自建立的隱私空間，金鑰互不相通 —— 沒有任何合併的可能
    if (packMeta !== null && !sameVault(packMeta, local)) {
      throw new Error(t('sync_salt_mismatch'));
    }
    /*
     * 舊格式那份 salt 不同：新格式已經是這個隱私空間的話，它是前一個（已刪除的）隱私空間
     * 留下的，推新格式時會一起清掉；沒有新格式就與以前一樣停下來。
     */
    const legacyOurs = legacyMeta !== null && sameVault(legacyMeta, local);
    if (legacyMeta !== null && !legacyOurs && packMeta === null) {
      throw new Error(t('sync_salt_mismatch'));
    }

    /*
     * 中介資料的協調要在「上鎖就返回」**之前**做，而且不需要金鑰。
     *
     * 在 A 更改主密碼之後，B 必須換掉自己的包裹，否則 B 會一直只認舊密碼 ——
     * `unlockVault` 只在本機完全沒有隱私空間時才看雲端，所以這是唯一的途徑。
     * 換包裹不影響任何資料：salt 相同代表兩邊包的是同一把資料金鑰。
     */
    let adopted = false;
    for (const meta of [packMeta, legacyOurs ? legacyMeta : null]) {
      if (meta !== null && (await adoptRemoteMeta(meta.vault))) {
        adopted = true;
      }
    }
    if (adopted) {
      broadcast('vault/changed', await vaultState());
    }

    /*
     * 塊還沒到齊、新舊混雜、或連 meta 都還沒到。這時手上沒有完整的遠端內容，
     * 上傳就等於覆蓋掉我們還沒看到的東西 —— 寧可等下一輪。
     *
     * 舊格式只在「有 meta 而且是這個隱私空間」時才等：只剩塊沒有 meta 的，多半是清到一半
     * 留下的殘塊，為它等下去會讓同步永遠停住；推新格式時會一起清掉。
     */
    if (pack.kind === 'partial' || (legacyOurs && legacy.kind === 'partial')) {
      // 更新版本寫的不會自己好，要講清楚；其餘是傳輸中，等下一輪
      lastError = pack.kind === 'partial' && pack.newer === true ? t('sync_newer_format') : null;
      return finish('waiting');
    }

    if (!isUnlocked()) {
      lastError = null;
      return finish('locked');
    }

    // 遠端那份本身解不開時（本機的錯誤會往上丟），用本機那份覆蓋過去 —— 否則這台裝置會因為
    // 一份壞掉的遠端副本而永遠停止上傳自己的新書籤
    let fellBack = false;
    if (pack.kind === 'ok' && !(await mergePack(pack.blob, pack.meta.version))) {
      fellBack = true;
    }
    if (legacyOurs && legacy.kind === 'ok') {
      if (!(await mergeRemote(legacy))) {
        fellBack = true;
      }
      await mergeLegacyLayout(local);
    }

    // 重讀本機 meta：上面的協調可能剛換掉包裹，用一開始那份會把舊包裹又推回去。
    // 存放位置照雲端 meta（哪怕那份解不開而要覆蓋，也覆蓋在同一個地方）
    await push(
      (await readMeta()) ?? local,
      pack.kind === 'ok' && !fellBack ? pack.meta : null,
      pushTo ?? (packMeta === null ? await defaultStore() : packStoreOf(packMeta)),
    );
    lastSyncedAt = Date.now();
    if (!fellBack) {
      lastError = null;
    }
    return finish('synced');
  } catch (error) {
    lastError = describe(error);
    return finish('failed');
  } finally {
    running = false;
  }
}

/**
 * 合併遠端那份。回傳 false 代表**遠端那份本身**壞掉（呼叫端應該覆蓋它）。
 *
 * 只有 `RemoteBlobUnreadable` 算「遠端壞掉」。其他失敗（本機寫入失敗、
 * 合併期間上鎖、IndexedDB 出錯）一律往上丟：把一個暫時性的本機錯誤當成
 * 「遠端壞了」，會讓它變成對雲端唯一副本的無合併覆蓋，而且訊息還把責任推給雲端。
 */
async function mergeRemote(remote: Extract<SyncRead, { kind: 'ok' }>): Promise<boolean> {
  let report;
  try {
    report = await mergeEncryptedBlob(remote.blob);
  } catch (error) {
    if (!(error instanceof RemoteBlobUnreadable)) {
      throw error;
    }
    lastError = t('sync_remote_unreadable_fell_back', error.message);
    return false;
  }
  const changed =
    report.bookmarks.added +
      report.bookmarks.updated +
      report.folders.added +
      report.folders.updated +
      report.reattached >
    0;
  if (changed) {
    // 合併進來的東西要讓開著的頁面立刻看到，否則畫面停在合併前
    broadcast('vault/changed', await vaultState());
  }
  return true;
}

/** 合併雲端的新格式。回傳 false 代表**遠端那份本身**壞掉（呼叫端應該覆蓋它），理由同 `mergeRemote` */
async function mergePack(blob: string, version: number): Promise<boolean> {
  try {
    if (await mergeEncryptedPack(blob, version)) {
      broadcast('vault/changed', await vaultState());
    }
    return true;
  } catch (error) {
    if (!(error instanceof RemoteBlobUnreadable)) {
      throw error;
    }
    lastError = t('sync_remote_unreadable_fell_back', error.message);
    return false;
  }
}

/** 舊格式的版面：合併進來就好，解不開或還沒傳完都不管 —— 推新格式時它會被刪掉，掉的只是排列 */
async function mergeLegacyLayout(local: VaultMeta): Promise<void> {
  const remote = await readLayoutEnvelope();
  if (remote.kind !== 'ok' || remote.meta.salt !== local.salt) {
    return;
  }
  try {
    if (await mergeEncryptedLayout(remote.blob)) {
      broadcast('vault/changed', await vaultState());
    }
  } catch (error) {
    if (!(error instanceof RemoteBlobUnreadable)) {
      throw error;
    }
  }
}

/** 清掉舊格式的兩份（有的話）。沒有就不寫，免得每一輪都觸發其他裝置的 onChanged */
async function clearLegacy(): Promise<void> {
  const keys = Object.keys(await browser.storage.sync.get(null));
  const present = keys.some(
    (key) =>
      key === SYNC_META_KEY ||
      key === LAYOUT_META_KEY ||
      key.startsWith(SYNC_CHUNK_PREFIX) ||
      key.startsWith(LAYOUT_CHUNK_PREFIX),
  );
  if (present) {
    await clearSyncEnvelope();
    await clearLayoutEnvelope();
  }
}

/** 這份塞不塞得進去：100 KB 扣掉 meta 的餘裕與書籤排列那份 */
async function fits(blob: string): Promise<boolean> {
  return fitsInSync(toChunks(blob), PACK_CHUNK_PREFIX, SYNC_META_RESERVE + (await gridSyncReserve()));
}

/**
 * 把本機那份推上雲端（新格式），順手清掉舊格式。
 *
 * 只有「書籤與版面的指紋都相同**而且**中介資料也相同」才跳過不寫。不能改用密文比對 ——
 * 每次加密都換 IV，同一份內容的密文永遠不同，於是兩台裝置會輪流認定「雲端跟我
 * 不一樣」而互相覆蓋，每次覆蓋又觸發對方再覆蓋一次，永遠停不下來。
 *
 * 先確認塞得進去才清舊格式：塞不進去的話舊格式那份至少還是一份能用的雲端副本。
 */
async function push(local: VaultMeta, remote: PackSyncMeta | null, store: PackStore): Promise<void> {
  const snapshot = await packedSnapshot();
  // 放書籤時不檢查配額：書籤沒有 100 KB 的限制（塊數上限在 `toBookmarkChunks` 把關）
  const target = await targetFor(store, snapshot.bytes);
  await clearLegacy();
  // 舊版本（1）的雲端副本內容一樣也要重寫：換成目前的格式才省得到空間
  const unchanged =
    remote !== null &&
    remote.version === metaVersionFor(store) &&
    packStoreOf(remote) === store &&
    remote.tag === snapshot.tag &&
    remote.layoutTag === snapshot.layoutTag &&
    sameMetaContent(remote.vault, local);
  if (unchanged) {
    return;
  }
  await writePackEnvelope(
    { vault: local, tag: snapshot.tag, layoutTag: snapshot.layoutTag, deviceId: await deviceId() },
    target,
  );
}

function metaVersionFor(store: PackStore): number {
  return store === 'bookmarks' ? PACK_META_VERSION : PACK_META_VERSION_SYNC;
}

/** 依存放位置編碼。放 `storage.sync` 時先確認塞得進去，塞不進去丟配額的訊息 */
async function targetFor(
  store: PackStore,
  bytes: Bytes,
): Promise<Parameters<typeof writePackEnvelope>[1]> {
  if (store === 'bookmarks') {
    return { store, bytes };
  }
  const blob = toBase91(bytes);
  if (!(await fits(blob))) {
    throw new Error(await quotaMessage(blob));
  }
  return { store, chunks: toChunks(blob) };
}

/**
 * 以本機那份覆蓋雲端，不合併。
 *
 * salt 不同（兩邊各自建立）或雲端那份卡在「傳輸中」時唯一的出路，而且必須由
 * 使用者明確按下 —— 它會讓另一台裝置上那份資料再也無法從雲端取回。
 */
export async function overwriteRemote(): Promise<void> {
  if (!syncAvailable()) {
    throw new Error(t('sync_unavailable'));
  }
  if (running) {
    throw new Error(t('sync_in_progress'));
  }
  running = true;
  try {
    const local = await readMeta();
    if (local === null) {
      throw new Error(t('sync_no_local_vault'));
    }
    // 要解鎖：精簡格式要有金鑰才編得出來
    const snapshot = await packedSnapshot();
    // 存放位置照雲端 meta；meta 看不懂（或不在）才用本機設定
    const remoteMeta = await readPackMeta();
    const store = remoteMeta === null ? await defaultStore() : packStoreOf(remoteMeta);
    /*
     * 先確認塞得進配額才清空遠端（`targetFor`）。
     *
     * 反過來的話（清空 → 上傳 → 因為超額而失敗）會變成兩邊都沒有那份副本，
     * 而使用者按這顆按鈕的處境往往正是「資料很多」。
     */
    const target = await targetFor(store, snapshot.bytes);
    // 寫回書籤時留著資料夾：`writeBookmarkChunks` 會沿用它、補齊或刪掉多的塊（「重建」）
    await clearPackEnvelope(store === 'sync');
    await clearSyncEnvelope();
    await clearLayoutEnvelope();
    await clearSyncGone();
    await writePackEnvelope(
      { vault: local, tag: snapshot.tag, layoutTag: snapshot.layoutTag, deviceId: await deviceId() },
      target,
    );
    lastSyncedAt = Date.now();
    lastError = null;
    lastOutcome = 'synced';
  } catch (error) {
    lastError = describe(error);
    throw error;
  } finally {
    running = false;
    void announce();
  }
}

/**
 * 移除雲端副本，本機資料不動。
 *
 * **一併關掉同步。** 不關的話下一次寫入會把副本推回去，使用者按了「移除」卻發現
 * 它還在雲端 —— 對一個隱私功能來說，那是最不能出錯的一種訊息。
 */
export async function clearRemote(): Promise<void> {
  /*
   * 進行中的同步會在我們清完之後把副本寫回去（它早就過了「同步有沒有啟用」那道檢查）。
   * 所以這裡也要拿同一個旗標，並且取消排程中的那一次 —— 不然使用者看到
   * 「已移除」而東西還在雲端。
   */
  if (running) {
    throw new Error(t('sync_in_progress_seconds'));
  }
  running = true;
  try {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    await patchSettings({ vaultSyncEnabled: false });
    // 連書籤裡那個資料夾一起刪（`clearPackEnvelope` 預設就會）
    await clearPackEnvelope();
    await clearSyncEnvelope();
    // 版面也是隱私資訊（第 3 期起還有群組名稱），「移除雲端副本」要連它一起移除
    await clearLayoutEnvelope();
    await clearSyncGone();
    lastError = null;
    lastSyncedAt = null;
    lastOutcome = null;
  } finally {
    running = false;
    void announce();
  }
}

/**
 * 切換雲端那份的存放位置（`storage.sync` ↔ 書籤）。整個帳號一起換：寫進 meta，其他裝置照 meta 走。
 *
 * 先跑一次同步（改去書籤時合併完直接推到書籤），結果不是 `synced` 就停下來說明原因：換地方等於重寫雲端那份，
 * 沒合併過就重寫會覆蓋掉別台裝置還沒合併進來的東西（「解鎖才推」那條規則的同一個理由）。
 * 也因此要解鎖。
 *
 * - 改去書籤：寫書籤 → 寫 meta（version 3）→ 刪 `vaultPackC*`（都在 `writePackEnvelope` 裡）。
 * - 改回 sync：先確認塞得進 100 KB，塞不下就拒絕（雲端那份不動）；寫回 `vaultPackC*` → meta → 刪資料夾。
 *   資料夾最後才刪：中途失敗的話，meta 還指著書籤、資料都還在。
 */
export async function setSyncStore(store: PackStore): Promise<void> {
  if (!syncAvailable()) {
    throw new Error(t('sync_unavailable'));
  }
  if (!isUnlocked()) {
    throw new Error(t('sync_bookmarks_need_unlock'));
  }
  if (running) {
    throw new Error(t('sync_in_progress'));
  }
  // 改去書籤時合併完就直接寫進書籤：照雲端 meta 推回 storage.sync 在超額時一定失敗（見 `runSync`）
  const outcome = await runSync(store === 'bookmarks' ? 'bookmarks' : undefined);
  if (outcome !== 'synced') {
    throw new Error(lastError ?? t('sync_bookmarks_not_merged', outcomeText(outcome)));
  }
  // syncVault 結束到這裡之間，排程中的那一次可能已經開始了
  if (running) {
    throw new Error(t('sync_in_progress'));
  }
  running = true;
  try {
    const local = await readMeta();
    if (local === null) {
      throw new Error(t('sync_no_local_vault'));
    }
    const remote = await readPackMeta();
    const current = remote === null ? await defaultStore() : packStoreOf(remote);
    if (remote !== null && current === store) {
      await patchSettings({ vaultSyncBookmarks: store === 'bookmarks' });
      return;
    }
    const snapshot = await packedSnapshot();
    let target: Parameters<typeof writePackEnvelope>[1];
    if (store === 'sync') {
      const blob = toBase91(snapshot.bytes);
      if (!(await fits(blob))) {
        throw new Error(
          t('sync_bookmarks_cannot_fit', Math.ceil(blob.length / 1024), await vaultBudgetKb()),
        );
      }
      target = { store, chunks: toChunks(blob) };
    } else {
      target = { store, bytes: snapshot.bytes };
    }
    await writePackEnvelope(
      { vault: local, tag: snapshot.tag, layoutTag: snapshot.layoutTag, deviceId: await deviceId() },
      target,
    );
    if (store === 'sync') {
      await removeSyncFolder(remote?.folderId ?? null);
    }
    await patchSettings({ vaultSyncBookmarks: store === 'bookmarks' });
    lastSyncedAt = Date.now();
    lastError = null;
    lastOutcome = 'synced';
  } finally {
    running = false;
    void announce();
  }
}

/** `syncVault` 沒有同步成功時，給錯誤訊息用的原因 */
function outcomeText(outcome: SyncOutcome): string {
  switch (outcome) {
    case 'disabled':
      return t('sync_bookmarks_reason_disabled');
    case 'locked':
      return t('sync_bookmarks_need_unlock');
    case 'waiting':
      return t('sync_bookmarks_reason_waiting');
    case 'busy':
      return t('sync_in_progress');
    case 'deleted-elsewhere':
      return t('sync_deleted_elsewhere');
    case 'unavailable':
      return t('sync_unavailable');
    case 'no-vault':
      return t('sync_no_local_vault');
    default:
      return outcome;
  }
}

/** 清掉「另一台裝置刪除了隱私空間」的標記，重新開始同步。 */
export async function resumeAfterRemoteDelete(): Promise<void> {
  await clearSyncGone();
  lastError = null;
  lastOutcome = null;
  await syncVault();
}

export async function syncStatus(): Promise<VaultSyncStatus> {
  const available = syncAvailable();
  const settings = await getSettings();
  const local = await readMeta();

  const base = {
    enabled: settings.vaultSyncEnabled,
    store: (settings.vaultSyncBookmarks ? 'bookmarks' : 'sync') as PackStore,
    hasLocalVault: local !== null,
    quota: SYNC_TOTAL_BUDGET,
    lastError,
    lastSyncedAt,
    lastOutcome,
  };

  if (!available) {
    return {
      ...base,
      available: false,
      remote: 'absent',
      remoteUpdatedAt: null,
      sameVault: null,
      bytes: 0,
      usageRatio: 0,
      wouldFit: true,
      deletedElsewhere: false,
    };
  }

  // 新格式在就看新格式；沒有的話（還沒有新版推過）看舊格式那份
  const pack = await readPackEnvelope();
  const remote = pack.kind === 'absent' ? await readSyncEnvelope() : pack;
  const remoteMeta = remote.kind === 'absent' ? null : remote.meta;
  const gone = await readSyncGone();
  const bytes = await syncBytesInUse();
  // 存放位置看雲端 meta（舊格式那份一定在 storage.sync）；雲端沒有時是本機設定的初值
  const store = pack.kind === 'absent' || pack.meta === null ? base.store : packStoreOf(pack.meta);

  return {
    ...base,
    store,
    available: true,
    remote: remote.kind,
    remoteUpdatedAt: remoteMeta?.updatedAt ?? null,
    sameVault: remoteMeta === null || local === null ? null : sameVault(remoteMeta, local),
    bytes,
    usageRatio: bytes / SYNC_TOTAL_BUDGET,
    // 放書籤時沒有配額可超
    wouldFit: store === 'bookmarks' ? true : await wouldFit(),
    deletedElsewhere: gone !== null && gone.deviceId !== (await deviceId()),
  };
}

/** 上鎖時量不到（要金鑰才編得出來），先當成放得下 —— 解鎖後的那次同步會說實話 */
async function wouldFit(): Promise<boolean> {
  if (!isUnlocked()) {
    return true;
  }
  try {
    return await fits(toBase91((await packedSnapshot()).bytes));
  } catch {
    return true;
  }
}

function finish(outcome: SyncOutcome): SyncOutcome {
  lastOutcome = outcome;
  void announce();
  return outcome;
}

/**
 * 把同步狀態廣播出去。
 *
 * 自動同步會在背景改動 `lastError` / `lastSyncedAt`，而設定頁沒有別的方式知道 ——
 * 少了這則廣播，一次失敗的自動同步在畫面上與「還沒同步過」一模一樣。
 * 廣播了不代表畫面會更新，接收端也得訂閱，兩邊都要有。
 */
async function announce(): Promise<void> {
  try {
    broadcast('vault/sync-changed', await syncStatus());
  } catch {
    // 沒有接收端是常態（設定頁沒開著）
  }
}
