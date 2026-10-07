import { gridSyncReserve } from '@/storage/grid-sync';
import { estimateSyncBytes, fitsInSync, SYNC_META_RESERVE, SYNC_TOTAL_BUDGET, toChunks } from '@/crypto/chunk';
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
  writeSyncEnvelope,
  type SyncMeta,
  type SyncRead,
} from '@/storage/vault-sync';
import {
  clearLayoutEnvelope,
  LAYOUT_CHUNK_PREFIX,
  LAYOUT_META_KEY,
  layoutSyncBytes,
  readLayoutEnvelope,
  writeLayoutEnvelope,
} from '@/storage/layout-sync';
import { readMeta, readStoredLayout } from '@/storage/vault-store';
import {
  adoptRemoteMeta,
  currentSnapshot,
  isUnlocked,
  mergeEncryptedBlob,
  mergeEncryptedLayout,
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
function sameVault(remote: SyncMeta, local: VaultMeta): boolean {
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
    // 版面那份也要聽：只改了排列時，書籤那份的 meta 不會動
    const changedKey = [SYNC_META_KEY, LAYOUT_META_KEY].find((name) => name in changes);
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

function quotaMessage(blob: string): string {
  return (
    t(
      'sync_quota_exceeded',
      Math.ceil(blob.length / 1024),
      Math.floor(SYNC_TOTAL_BUDGET / 1024),
    )
  );
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

    const remote = await readSyncEnvelope();
    const remoteMeta = remote.kind === 'absent' ? null : remote.meta;

    // salt 不同代表兩邊是各自建立的隱私空間，金鑰互不相通 —— 沒有任何合併的可能
    if (remoteMeta !== null && !sameVault(remoteMeta, local)) {
      throw new Error(
        t('sync_salt_mismatch'),
      );
    }

    /*
     * 中介資料的協調要在「上鎖就返回」**之前**做，而且不需要金鑰。
     *
     * 在 A 更改主密碼之後，B 必須換掉自己的包裹，否則 B 會一直只認舊密碼 ——
     * `unlockVault` 只在本機完全沒有隱私空間時才看雲端，所以這是唯一的途徑。
     * 換包裹不影響任何資料：salt 相同代表兩邊包的是同一把資料金鑰。
     */
    if (remoteMeta !== null && (await adoptRemoteMeta(remoteMeta.vault))) {
      broadcast('vault/changed', await vaultState());
    }

    if (remote.kind === 'partial') {
      // 塊還沒到齊、新舊混雜、或連 meta 都還沒到。這時手上沒有完整的遠端內容，
      // 上傳就等於覆蓋掉我們還沒看到的東西 —— 寧可等下一輪
      lastError = null;
      return finish('waiting');
    }

    if (remote.kind === 'ok') {
      if (!isUnlocked()) {
        lastError = null;
        return finish('locked');
      }
      if (!(await mergeRemote(remote))) {
        // 只有「遠端那份本身解不開」會走到這裡（本機的寫入失敗會往上丟）。
        // 那份已經救不回來，所以用本機那份覆蓋過去 —— 否則這台裝置會因為一份
        // 壞掉的遠端副本而永遠停止上傳自己的新書籤。
        await push(local, null);
        await syncLayout(local);
        lastSyncedAt = Date.now();
        return finish('synced');
      }
    }

    // 重讀本機 meta：上面的協調可能剛換掉包裹，用一開始那份會把舊包裹又推回去
    await push((await readMeta()) ?? local, remote.kind === 'ok' ? remote.meta : null);
    await syncLayout(local);
    lastSyncedAt = Date.now();
    lastError = null;
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

/**
 * 把本機那份推上雲端。
 *
 * 只有「書籤內容的指紋相同**而且**中介資料也相同」才跳過不寫。不能改用密文比對 ——
 * 每次加密都換 IV，同一份內容的密文永遠不同，於是兩台裝置會輪流認定「雲端跟我
 * 不一樣」而互相覆蓋，每次覆蓋又觸發對方再覆蓋一次，永遠停不下來。
 */
async function push(local: VaultMeta, remote: SyncMeta | null): Promise<void> {
  const { blob, tag } = await currentSnapshot();
  if (blob === null) {
    return;
  }
  const unchanged =
    remote !== null &&
    tag !== null &&
    remote.tag !== '' &&
    remote.tag === tag &&
    sameMetaContent(remote.vault, local);
  if (unchanged) {
    return;
  }
  const chunks = toChunks(blob);
  // 版面那份與它共用同一個 100 KB，要把它佔掉的算進來
  if (!fitsInSync(chunks, SYNC_CHUNK_PREFIX, SYNC_META_RESERVE + (await layoutSyncBytes()) + (await gridSyncReserve()))) {
    throw new Error(quotaMessage(blob));
  }
  await writeSyncEnvelope(
    {
      vault: local,
      // 指紋是跟密文一起存的，所以上鎖也讀得到。只有「舊版寫的資料還沒有指紋」
      // 這一種情況會是 null，那時寫空字串代表「未知」，下一次寫入就會補上
      tag: tag ?? '',
      deviceId: await deviceId(),
    },
    chunks,
  );
}

/** 書籤那份在雲端要佔多少（版面推上去之前要先扣掉） */
async function mainSyncBytes(): Promise<number> {
  const { blob } = await currentSnapshot();
  return blob === null ? 0 : estimateSyncBytes(toChunks(blob), SYNC_CHUNK_PREFIX) + SYNC_META_RESERVE;
}

/**
 * 版面（排列順序）的同步：拉遠端 → 合併 → 推回去。在書籤那份處理完之後呼叫。
 *
 * 規則與書籤那份一致：傳播中什麼都不做；合併要金鑰，上鎖時不推（推了就是覆蓋）；
 * 內容指紋相同就不寫。salt 不同的那份屬於另一個隱私空間 —— 書籤那份已經確認過
 * salt 相同才會走到這裡，所以那是前一個（已刪除的）隱私空間留下的，直接蓋掉。
 */
async function syncLayout(local: VaultMeta): Promise<void> {
  const remote = await readLayoutEnvelope();
  if (remote.kind === 'partial') {
    return;
  }
  const sameSalt = remote.kind === 'ok' && remote.meta.salt === local.salt;
  if (sameSalt) {
    if (!isUnlocked()) {
      return;
    }
    try {
      if (await mergeEncryptedLayout(remote.blob)) {
        broadcast('vault/changed', await vaultState());
      }
    } catch (error) {
      // 遠端那份解不開才用本機的蓋過去；本機的錯誤往上丟（理由同 mergeRemote）
      if (!(error instanceof RemoteBlobUnreadable)) {
        throw error;
      }
    }
  }
  const stored = await readStoredLayout();
  if (stored === null) {
    return;
  }
  if (sameSalt && stored.tag !== null && remote.meta.tag === stored.tag) {
    return;
  }
  const chunks = toChunks(stored.blob);
  if (!fitsInSync(chunks, LAYOUT_CHUNK_PREFIX, SYNC_META_RESERVE + (await mainSyncBytes()) + (await gridSyncReserve()))) {
    throw new Error(quotaMessage(stored.blob));
  }
  await writeLayoutEnvelope({ salt: local.salt, tag: stored.tag ?? '', deviceId: await deviceId() }, chunks);
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
    const { blob, tag } = await currentSnapshot();
    if (blob === null) {
      throw new Error(t('sync_nothing_to_upload'));
    }
    const chunks = toChunks(blob);
    /*
     * 先確認塞得進配額才清空遠端。
     *
     * 反過來的話（清空 → 上傳 → 因為超額而失敗）會變成兩邊都沒有那份副本，
     * 而使用者按這顆按鈕的處境往往正是「資料很多」。
     */
    if (!fitsInSync(chunks, SYNC_CHUNK_PREFIX, SYNC_META_RESERVE + (await gridSyncReserve()))) {
      throw new Error(quotaMessage(blob));
    }
    await clearSyncEnvelope();
    await clearLayoutEnvelope();
    await clearSyncGone();
    await writeSyncEnvelope(
      { vault: local, tag: tag ?? '', deviceId: await deviceId() },
      chunks,
    );
    await syncLayout(local);
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
      wouldFit: true,
      deletedElsewhere: false,
    };
  }

  const remote = await readSyncEnvelope();
  const remoteMeta = remote.kind === 'absent' ? null : remote.meta;
  const { blob } = await currentSnapshot();
  const gone = await readSyncGone();

  return {
    ...base,
    available: true,
    remote: remote.kind,
    remoteUpdatedAt: remoteMeta?.updatedAt ?? null,
    sameVault: remoteMeta === null || local === null ? null : sameVault(remoteMeta, local),
    bytes: await syncBytesInUse(),
    wouldFit:
      blob === null ||
      fitsInSync(toChunks(blob), SYNC_CHUNK_PREFIX, SYNC_META_RESERVE + (await layoutSyncBytes()) + (await gridSyncReserve())),
    deletedElsewhere: gone !== null && gone.deviceId !== (await deviceId()),
  };
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
