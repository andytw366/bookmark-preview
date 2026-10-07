import { seal, unseal } from '@/crypto/aead';
import { copyBytes, fromBase64, toBase64, type Bytes } from '@/crypto/bytes';
import { fromChunks } from '@/crypto/chunk';
import { deriveKey, KDF_ITERATIONS, randomSalt } from '@/crypto/kdf';
import {
  generateDek,
  generateRecoveryKey,
  importDek,
  recoveryKek,
  sealText,
  unsealText,
  unwrapDek,
  wrapDek,
  zero,
} from '@/crypto/keyring';
import { decodePayload, encodePayload } from '@/crypto/vault-codec';
import type { VaultThumbPayload } from '@/shared/messages';
import type {
  PrivateBookmark,
  PrivateFolder,
  VaultMeta,
  VaultPayload,
  VaultState,
  WrappedKey,
} from '@/shared/types';
import { createSerialQueue } from '@/shared/serial-queue';
import { urlKey, VAULT_THUMB_PREFIX, vaultThumbKey } from '@/shared/url';
import { isSamePageIgnoringScheme } from '@/shared/url-match';
import { backupFilename, buildBackup, parseBackup } from '@/shared/vault-backup';
import {
  emptyLayout,
  layoutTag,
  mergeLayouts,
  moveIds,
  sanitizeLayout,
  vaultChildId,
  vaultChildren,
  withFolderOrder,
  type VaultLayout,
} from '@/shared/vault-layout';
import { planFolderExport, planFolderImport } from '@/shared/vault-subtree';
import {
  contentTag,
  countAlive,
  mergeVaults,
  pruneTombstones,
  sanitizeVaultPayload,
  type MergeReport,
} from '@/shared/vault-merge';
import { clearLayoutEnvelope } from '@/storage/layout-sync';
import { getSettings } from '@/storage/settings';
import { deleteThumb, getThumb, listKeys as listThumbKeys, putThumb } from '@/storage/thumbs-db';
import {
  clearSyncEnvelope,
  deviceId,
  readSyncEnvelope,
  readSyncMeta,
  syncAvailable,
  syncEnvelopePresent,
  writeSyncGone,
} from '@/storage/vault-sync';
import {
  destroyVault,
  readBlob,
  readMeta,
  readStoredBlob,
  readStoredLayout,
  writeBlob,
  writeLayout,
  writeMeta,
} from '@/storage/vault-store';
import { t } from '@/shared/i18n';

/**
 * 隱私空間的唯一擁有者。
 *
 * 金鑰與明文只存在這個模組的模組層變數裡 —— 也就是背景頁的記憶體。
 * 側邊欄永遠拿不到金鑰，需要明文時透過訊息索取。這讓「金鑰在哪」
 * 只有一個答案，不必追蹤它有沒有被複製到其他 context。
 *
 * 背景事件頁被卸載時這些變數自然消失，等於自動上鎖。
 */
let key: CryptoKey | null = null;
let payload: VaultPayload | null = null;
/** 版面（排列順序）。與 payload 同生同死：解鎖時一起讀進來、上鎖時一起丟掉 */
let layout: VaultLayout | null = null;

const EMPTY: VaultPayload = { version: 1, bookmarks: [], folders: [] };

function alive<T extends { deleted?: true }>(items: readonly T[]): T[] {
  return items.filter((item) => item.deleted !== true);
}

function requireUnlocked(): { key: CryptoKey; payload: VaultPayload } {
  if (key === null || payload === null) {
    throw new Error(t('vault_locked'));
  }
  return { key, payload };
}

/**
 * 這份中介資料是不是舊格式（開發期間的 version 1，密碼直接加密資料）。
 *
 * 舊格式**刻意不做遷移**：這個擴充套件還沒有對外發布過，為了少數開發期的測試資料
 * 背一段只會跑一次的轉換程式碼不划算 —— 那段程式碼一旦寫錯，代價是資料打不開。
 * 但辨識它是必要的：不辨識就會丟出一個看不懂的解密失敗，使用者只會以為壞了。
 */
export function isLegacyMeta(meta: VaultMeta | null): boolean {
  return meta !== null && (meta as { version?: unknown }).version !== 2;
}

function requireCurrentFormat(meta: VaultMeta): void {
  if (isLegacyMeta(meta)) {
    throw new Error(
      t('vault_legacy_format'),
    );
  }
}

/**
 * 所有會改動 payload 的操作都排成一列，一次只跑一個。
 *
 * 這不是效能考量而是正確性：這些操作都是「拿到 payload → await 幾件事 → 改它 →
 * persist」，而同步的合併會把 `payload` 換成**另一個物件**。兩者交錯時，改動會
 * 落在已經被換掉的那份上，接著 persist 寫出的是不含該改動的新 payload。
 *
 * 最糟的組合是移入隱私空間：加密資料沒寫進去，原生書籤卻照樣被移除
 * ——書籤兩邊都不存在了，而 UI 回報成功。所以連「只改一個欄位」的操作也要排隊。
 *
 * **這個鎖刻意不可重入**（原因與那次失敗的實作寫在 `createSerialQueue`）。批量操作
 * 因此呼叫下面的 `*Locked` 內部函式，它們不自己取鎖。
 */
const exclusive = createSerialQueue();

/**
 * 每次加密資料落地後要通知的對象（同步模組會掛在這裡）。
 *
 * 用回呼註冊而不是直接 import 同步模組：同步模組需要這裡的 `mergeEncryptedBlob`，
 * 反過來 import 就成了循環相依。金鑰也因此仍然只存在這個模組。
 */
let persistHook: () => void = () => undefined;

export function setPersistHook(hook: () => void): void {
  persistHook = hook;
}

/**
 * storage.sync 上那份可用的加密副本（只在同步已啟用時才看）。
 *
 * 這是「換一台裝置」的關鍵：新裝置的 storage.local 是空的，若只看本機就會判定
 * 「還沒建立隱私空間」，接著使用者在建立畫面輸入同一組密碼 —— 產生的是**新的
 * salt**，於是兩邊金鑰不同、雲端那份永遠打不開。所以本機沒有時要看雲端。
 *
 * 同步預設關閉，關閉時完全不看雲端：沒有人希望一個沒開同步的裝置忽然冒出
 * 「這裡有隱私空間」。
 */
async function syncedVault(): Promise<{ meta: VaultMeta; blob: string; tag: string } | null> {
  if (!(await syncEnabled())) {
    return null;
  }
  const remote = await readSyncEnvelope();
  if (remote.kind !== 'ok') {
    return null;
  }
  // 中介資料原樣搬過來，不逐欄複製 —— 少帶一個欄位的症狀是「換裝置後打不開」
  return { meta: remote.meta.vault, blob: remote.blob, tag: remote.meta.tag };
}

async function syncEnabled(): Promise<boolean> {
  return syncAvailable() && (await getSettings()).vaultSyncEnabled;
}

/**
 * 雲端上有沒有一份隱私空間（只讀中介資料，不讀塊）。
 *
 * 存在性判斷**必須包含「塊還沒傳完」的狀態**。storage.sync 是逐筆傳播的，新裝置
 * 幾乎一定會先收到 meta 才收到十幾個塊；那個空窗期若判定成「還沒建立隱私空間」，
 * 使用者就會看到建立畫面、建出一個新 salt 的 vault，接著把雲端上那份唯一的副本
 * 覆蓋掉 —— 那正是災難還原最需要它的時候。
 *
 * 順帶也便宜得多：`vaultState()` 每次 UI 更新都會呼叫，讀一個鍵而不是十幾個。
 */
async function syncedVaultExists(): Promise<boolean> {
  return (await syncEnabled()) && (await syncEnvelopePresent());
}

/**
 * 雲端那份的中介資料 —— **本機已經有 vault 時也會讀**，而且**不看時間戳**。
 *
 * `syncedVault()` 只在本機完全沒有隱私空間時才被呼叫，所以它涵蓋不到「密碼是在另一台
 * 裝置改的」這件事。
 *
 * 刻意不比時間戳：解鎖那條路有一個更強的判準 —— **使用者剛輸入的密碼能不能開它**。
 * 那是自我驗證的，不需要相信任何時鐘。時間戳很脆弱：兩台裝置的時鐘不同步、離線改的
 * 變更會帶著舊時間，而任何一條忘記更新它的程式碼路徑都會讓採用永久失效
 * （實際發生過：`changePassword` 曾經只換包裹而沒有更新時間戳，於是兩台裝置各自停在
 * 自己的包裹上，怎麼同步都不會變）。
 *
 * 只要求同一個隱私空間（salt 相同＝同一把資料金鑰），這樣換包裹一定安全。KDF 迭代
 * 次數允許不同（更改主密碼會順便升到目前的建議值），呼叫端會依該份 meta 重新派生 KEK。
 */
async function syncedMetaCandidate(local: VaultMeta): Promise<VaultMeta | null> {
  if (!(await syncEnabled())) {
    return null;
  }
  const remote = await readSyncMeta();
  if (remote === null) {
    return null;
  }
  const candidate = remote.vault;
  if (candidate.salt !== local.salt) {
    return null;
  }
  // 內容一樣就沒必要再試一次（省一次 600k 次迭代的派生）
  const same =
    candidate.passwordWrap.ct === local.passwordWrap.ct &&
    candidate.recoveryWrap.ct === local.recoveryWrap.ct;
  return same ? null : candidate;
}

/**
 * 中介資料的時間戳。
 *
 * 舊的 v2 資料可能還沒有 `metaUpdatedAt`（那個欄位是後來補的），退回 `createdAt`
 * 而不是丟錯 —— 少一個時間戳只該讓比較保守一點，不該讓整個隱私空間打不開。
 */
export function metaStamp(meta: VaultMeta): number {
  return meta.metaUpdatedAt ?? meta.createdAt ?? 0;
}

/**
 * 採用雲端那份的中介資料（包裹），保留本機的加密內容。
 *
 * 這是「在 A 改了主密碼，B 也要跟著改」的唯一途徑：`unlockVault` 只在本機完全沒有
 * 隱私空間時才看雲端，所以 B 一旦有了自己的 meta 就再也不會更新它 —— 表現成
 * 「密碼改了，另一台裝置卻還在用舊密碼」。
 *
 * 只有 salt 相同（＝同一個隱私空間、同一把資料金鑰）時才可以這樣換：兩個包裹包的是
 * 同一個 DEK，所以換掉包裹不影響已經解開的內容，也不影響本機的加密資料。
 */
export async function adoptRemoteMeta(remote: VaultMeta): Promise<boolean> {
  return exclusive(async () => {
    const local = await readMeta();
    if (local === null || remote.salt !== local.salt || remote.iterations !== local.iterations) {
      return false;
    }
    if (metaStamp(remote) <= metaStamp(local)) {
      return false;
    }
    await writeMeta(remote);
    return true;
  });
}

/**
 * 把一份（別處來的）加密副本寫成本機的隱私空間。呼叫端要先確認本機還沒有。
 *
 * `tag` 是那份副本的內容指紋。傳不進來（例如舊格式的備份檔）時寫空字串，
 * 代表「未知」—— 下一次同步會補上正確的值，只是多推一次。
 */
async function adoptCopy(meta: VaultMeta, blob: string, tag: string): Promise<void> {
  await writeMeta(meta);
  await writeBlob(blob, tag);
}

export async function vaultState(): Promise<VaultState> {
  const meta = await readMeta();
  if (meta === null) {
    // 本機沒有，但雲端有的話這台裝置是「上鎖」而不是「還沒建立」
    return (await syncedVaultExists()) ? { status: 'locked' } : { status: 'absent' };
  }
  // 舊格式要明講，不能混在「上鎖」裡 —— 那會讓使用者一直輸入正確的密碼卻打不開
  if (isLegacyMeta(meta)) {
    return { status: 'legacy' };
  }
  if (key === null || payload === null) {
    return { status: 'locked' };
  }
  return { status: 'unlocked', bookmarkCount: alive(payload.bookmarks).length };
}

/**
 * 建立隱私空間，回傳**只會顯示這一次**的救援金鑰。
 *
 * 救援金鑰是強制產生的，不是選填。做成選填的話幾乎沒有人會設，那這個機制就等於不存在
 * —— 而會忘記主密碼的人，正好也是不會主動去設救援金鑰的那些人。
 */
export async function createVault(password: string): Promise<string> {
  return exclusive(async () => {
    if ((await readMeta()) !== null) {
      throw new Error(t('vault_already_created'));
    }
    /*
     * 雲端已有一份時不能另建，而且這道把關**不看同步有沒有啟用**。
     *
     * 新建的 vault 會有新的 salt，兩份從此永遠合不起來，而後續的同步會把雲端那份
     * 覆蓋掉。這個代價太高，所以即使使用者還沒打開同步也要先擋下來並說明出路。
     */
    if (syncAvailable() && (await readSyncMeta()) !== null) {
      throw new Error(
        t('vault_remote_exists'),
      );
    }

    const salt = randomSalt();
    const code = generateRecoveryKey();
    const dek = generateDek();
    try {
      const dataKey = await importDek(dek);
      const meta: VaultMeta = {
        version: 2,
        salt: toBase64(salt),
        iterations: KDF_ITERATIONS,
        passwordWrap: await wrapDek(await deriveKey(password, salt), dek),
        recoveryWrap: await wrapDek(await recoveryKek(code, salt), dek),
        recoveryCodeSealed: await sealText(dataKey, code),
        metaUpdatedAt: Date.now(),
        createdAt: Date.now(),
      };
      await writeMeta(meta);
      key = dataKey;
      payload = { ...EMPTY };
      layout = emptyLayout();
      await persist();
    } finally {
      // 原始位元組只需要活到包裹完成為止
      zero(dek);
    }
    return code;
  });
}

export async function unlockVault(password: string): Promise<void> {
  return unlockWith({
    label: t('vault_secret_password'),
    kek: async (meta) => deriveKey(password, fromBase64(meta.salt), meta.iterations),
    wrap: (meta) => meta.passwordWrap,
  });
}

/**
 * 用救援金鑰解鎖。
 *
 * 「忘記主密碼」唯一的出路。走的是同一個 DEK，所以解開之後看到的資料與用密碼解開
 * 完全相同 —— 這條路不是降級的存取，只是另一把鑰匙。
 */
export async function unlockWithRecoveryKey(code: string): Promise<void> {
  return unlockWith({
    label: t('vault_secret_recovery'),
    kek: async (meta) => recoveryKek(code, fromBase64(meta.salt)),
    wrap: (meta) => meta.recoveryWrap,
  });
}

/**
 * 一條解鎖路徑要說明的三件事：叫什麼、怎麼從中介資料派生出 KEK、用哪個包裹。
 *
 * 拆成這個形狀（而不是直接傳一個「拿到 DEK」的函式）是為了讓同一把 KEK 能拿去試
 * **兩份**中介資料 —— 本機那份與雲端那份。KEK 只由「秘密 + salt + KDF 參數」決定，
 * 所以兩份的 salt 與參數相同時可以重複使用，不必再跑一次 60 萬次迭代的派生。
 */
interface Opener {
  label: string;
  kek: (meta: VaultMeta) => Promise<CryptoKey>;
  wrap: (meta: VaultMeta) => WrappedKey;
}

/**
 * 兩條解鎖路徑共用的流程。
 *
 * 順序有三個地方很重要，各自對應一種實際發生過的失敗：
 *
 * - **取得 DEK 在落地之前**：反過來的話，一次打錯密碼就讓本機從此有一份 meta，
 *   狀態變成「上鎖」，而刪除需要先解鎖、建立會說已經建立過。
 * - **解得開內容在落地之前**：雲端那份若已損毀（鑰匙對卻解不開內容），先落地就會
 *   留下一個永遠打不開也刪不掉的隱私空間。
 * - **每次解鎖都要跟雲端那份對一次包裹**，見下面 `reconcile` 的說明。
 */
async function unlockWith(opener: Opener): Promise<void> {
  return exclusive(async () => {
    const local = await readMeta();
    // 換裝置後的第一次解鎖：雲端那份是唯一的來源
    const remote = local === null ? await syncedVault() : null;
    const meta = local ?? remote?.meta ?? null;
    if (meta === null) {
      throw new Error(
        (await syncedVaultExists())
          ? t('vault_remote_still_transferring')
          : t('vault_not_created'),
      );
    }
    requireCurrentFormat(meta);

    const openWith = async (candidate: VaultMeta): Promise<Bytes> =>
      unwrapDek(await opener.kek(candidate), opener.wrap(candidate));

    let dek: Bytes | null = null;
    let firstFailure: unknown = null;
    try {
      dek = await openWith(meta);
    } catch (error) {
      firstFailure = error;
    }

    /*
     * 跟雲端那份對一次包裹 —— **每次解鎖都做，不論本機開得了沒有**。
     *
     * 這一段解決兩個方向的問題：
     *
     * 1. 本機開不了、雲端開得了 → 密碼是在另一台裝置改的，這台還沒同步到新包裹。
     *    採用它，使用者用新密碼就進得來，不必等背景同步跑過。
     * 2. 本機開得了、雲端**不**接受這組秘密 → 這組秘密已經在別台裝置被換掉了。
     *    這時必須**拒絕**，否則舊密碼會在這台裝置上一直有效 —— 而改密碼的動機
     *    往往正是「舊密碼可能已經洩漏」。
     *
     * 判準盡量不依賴時鐘：「這個秘密開不開得了雲端那份包裹」是自我驗證的。時間戳
     * 只用在第 2 種情況下區分「雲端較新」與「自己剛改還沒推上去」，而那時兩份內容
     * 必然不同，所以 `>=` 不會誤判成已經同步過的狀態。
     */
    const cloud = local === null ? null : await syncedMetaCandidate(meta);
    if (cloud !== null) {
      let cloudDek: Bytes | null = null;
      try {
        cloudDek = await openWith(cloud);
      } catch {
        // 雲端那份不吃這個秘密
      }

      if (cloudDek !== null) {
        if (dek !== null) {
          zero(dek);
        }
        await writeMeta(cloud);
        dek = cloudDek;
      } else if (dek !== null && metaStamp(cloud) >= metaStamp(meta)) {
        zero(dek);
        // 換成雲端那份，這樣下一次用新的秘密就進得來
        await writeMeta(cloud);
        throw new Error(
          t('vault_secret_changed_elsewhere', opener.label),
        );
      }
      // 其餘情況：本機比雲端新（自己剛改還沒推上去），維持本機那份
    }

    if (dek === null) {
      throw firstFailure ?? new Error(t('vault_secret_wrong', opener.label));
    }

    let dataKey: CryptoKey;
    try {
      dataKey = await importDek(dek);
    } finally {
      zero(dek);
    }

    const source = local === null && remote !== null ? remote.blob : await readBlob();
    const opened =
      source === null
        ? { ...EMPTY }
        : sanitizeVaultPayload(await decodePayload<unknown>(dataKey, [source]));

    if (local === null && remote !== null) {
      await adoptCopy(remote.meta, remote.blob, remote.tag);
    }

    payload = opened;
    key = dataKey;
    layout = await openLayout(dataKey);
    prune();
  });
}

/**
 * 讀出本機的版面。
 *
 * 解不開時給一份空的而不是讓解鎖失敗：版面只是排列順序，為了它把使用者關在門外
 * 不划算。空的那份不會自己寫回去，要等使用者下一次排序才會蓋掉那份解不開的。
 */
async function openLayout(dataKey: CryptoKey): Promise<VaultLayout> {
  const stored = await readStoredLayout();
  if (stored === null) {
    return emptyLayout();
  }
  try {
    return sanitizeLayout(await decodePayload<unknown>(dataKey, [stored.blob]));
  } catch {
    return emptyLayout();
  }
}

/**
 * 更改主密碼。
 *
 * 只要重新包一次 DEK，**資料一個位元都不用動**（縮圖也不用）。舊格式做不到這件事：
 * 密碼直接派生資料金鑰，改密碼就等於整包重新加密，中途失敗會留下一堆解不開的東西。
 *
 * 要求輸入目前的密碼而不是「已解鎖就好」：改密碼是把別人鎖在外面的動作，
 * 不該讓一台沒鎖的電腦前面的任何人做得到。
 */
export async function changePassword(current: string, next: string): Promise<void> {
  return exclusive(async () => {
    const meta = await readMeta();
    if (meta === null) {
      throw new Error(t('vault_not_created'));
    }
    requireCurrentFormat(meta);
    if (next === '') {
      throw new Error(t('vault_new_password_empty'));
    }
    const salt = fromBase64(meta.salt);
    const dek = await unwrapDek(await deriveKey(current, salt, meta.iterations), meta.passwordWrap);
    try {
      // 一併把 KDF 迭代次數升到目前的建議值 —— 改密碼是唯一自然的時機
      const passwordWrap = await wrapDek(await deriveKey(next, salt, KDF_ITERATIONS), dek);
      await writeMeta({ ...meta, iterations: KDF_ITERATIONS, passwordWrap });
      // 中介資料變了也要同步出去，否則其他裝置仍然只認舊密碼
      persistHook();
    } finally {
      zero(dek);
    }
  });
}

/**
 * 重新產生救援金鑰，回傳新的那一串。
 *
 * 舊的那串立刻失效（它包的那份 DEK 副本被換掉了），所以抄在紙上的舊碼要丟掉。
 */
export async function regenerateRecoveryKey(password: string): Promise<string> {
  return exclusive(async () => {
    const meta = await readMeta();
    if (meta === null) {
      throw new Error(t('vault_not_created'));
    }
    requireCurrentFormat(meta);
    const salt = fromBase64(meta.salt);
    const dek = await unwrapDek(await deriveKey(password, salt, meta.iterations), meta.passwordWrap);
    const code = generateRecoveryKey();
    try {
      await writeMeta({
        ...meta,
        recoveryWrap: await wrapDek(await recoveryKek(code, salt), dek),
        recoveryCodeSealed: await sealText(await importDek(dek), code),
      });
      // 同上：不推出去的話，其他裝置上失效的舊救援金鑰還是開得了
      persistHook();
    } finally {
      zero(dek);
    }
    return code;
  });
}

/** 再看一次救援金鑰。需要已解鎖 —— 那串碼是以資料金鑰加密存著的。 */
export async function revealRecoveryKey(): Promise<string> {
  const { key: k } = requireUnlocked();
  const meta = await readMeta();
  if (meta === null) {
    throw new Error(t('vault_not_created'));
  }
  requireCurrentFormat(meta);
  return unsealText(k, meta.recoveryCodeSealed);
}

export function lockVault(): void {
  key = null;
  payload = null;
  layout = null;
}

export function isUnlocked(): boolean {
  return key !== null && payload !== null;
}

/**
 * 徹底刪除隱私空間。
 *
 * 需要先解鎖：否則任何人都能在不知道密碼的情況下把資料清掉。
 *
 * 雲端副本也要一起清掉。少了這一步，本機刪除之後 `vaultState()` 會從雲端讀回
 * 那份副本並回報「上鎖」—— 使用者按了刪除，隱私空間卻還在，而且下次解鎖會把
 * 全部資料還原回來。
 *
 * 但**只清掉屬於這個隱私空間的那份副本**：條件是同步已啟用、而且雲端那份的 salt
 * 與本機相同。沒有這兩個條件的話，一台從未開啟同步的裝置刪掉自己的 vault，會順手
 * destroy 另一台裝置的雲端副本並讓它的同步停擺 —— 那份東西跟這次刪除毫無關係。
 */
export async function deleteEverything(): Promise<void> {
  return exclusive(async () => {
    const { payload: current } = requireUnlocked();
    const local = await readMeta();
    await Promise.all(current.bookmarks.map((record) => deleteThumb(vaultThumbKey(record.id))));

    const remote = (await syncEnabled()) ? await readSyncMeta() : null;
    if (remote !== null && local !== null && remote.vault.salt === local.salt) {
      await clearSyncEnvelope();
      await clearLayoutEnvelope();
      /*
       * 留下刪除標記。
       *
       * 只清空雲端副本不夠：另一台裝置看到「雲端沒有副本」就會把自己那份推上去，
       * 於是這台裝置下次同步又把整個隱私空間拉回來 —— 使用者按了刪除，資料自己回來。
       * 標記讓其他裝置停下來詢問，而不是自動刪掉它們的資料。
       */
      await writeSyncGone(await deviceId());
    }
    await destroyVault();
    lockVault();
  });
}

/**
 * 放棄這台裝置上的隱私空間，**不需要先解鎖**。
 *
 * 這是「上鎖 + 打不開」時唯一的出路 —— 忘記主密碼又沒有救援金鑰，或資料是舊格式。
 * 在此之前那是個死路：刪除要求先解鎖、建立會說已經建立過。
 *
 * 「刪除必須先解鎖」原本想擋的是「有人趁你離開時清掉資料」，但能碰到這台電腦的人
 * 本來就能直接清掉擴充套件的儲存目錄，所以那道門擋住的其實只有誤觸 —— 而它同時
 * 把真正需要出路的人關在外面。改成用明確的確認來擋誤觸。
 *
 * **不動雲端副本**：這台裝置打不開它，不代表別台裝置也打不開。要清雲端請用設定頁的
 * 「移除雲端副本」。
 */
export async function forgetVault(): Promise<void> {
  return exclusive(async () => {
    // 加密的縮圖也要清掉，否則會變成永遠解不開的孤兒（清理程序在上鎖時會跳過它們）
    const keys = await listThumbKeys();
    await Promise.all(keys.filter((k) => k.startsWith(VAULT_THUMB_PREFIX)).map(deleteThumb));
    await destroyVault();
    lockVault();
  });
}

/**
 * 把雲端那份副本落到本機，成為這台裝置的隱私空間。
 *
 * 設定頁的「從雲端還原到這台裝置」用。還原後狀態是「上鎖」——meta 是明文，
 * 不需要密碼就能落地；要看到內容仍然得輸入主密碼。
 */
export async function adoptSyncedVault(): Promise<void> {
  return exclusive(async () => {
    if ((await readMeta()) !== null) {
      throw new Error(t('vault_already_on_device'));
    }
    const remote = await syncedVault();
    if (remote === null) {
      throw new Error(t('vault_no_remote_copy'));
    }
    await adoptCopy(remote.meta, remote.blob, remote.tag);
  });
}

export function listBookmarks(): PrivateBookmark[] {
  const { payload: current } = requireUnlocked();
  return alive(current.bookmarks).sort((a, b) => b.createdAt - a.createdAt);
}

// ── 資料夾 ────────────────────────────────────────────────────────────

export function listFolders(): PrivateFolder[] {
  const { payload: current } = requireUnlocked();
  return alive(current.folders).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
}

function requireFolder(current: VaultPayload, id: string): PrivateFolder {
  const folder = current.folders.find((item) => item.id === id && item.deleted !== true);
  if (folder === undefined) {
    throw new Error(t('vault_folder_not_found'));
  }
  return folder;
}

export async function createFolder(name: string, parentId: string | null): Promise<void> {
  return exclusive(async () => {
    const { payload: current } = requireUnlocked();
    if (parentId !== null) {
      requireFolder(current, parentId);
    }
    current.folders.push({
      id: crypto.randomUUID(),
      name,
      parentId,
      updatedAt: Date.now(),
    });
    await persist();
  });
}

export async function renameFolder(id: string, name: string): Promise<void> {
  return exclusive(async () => {
    const { payload: current } = requireUnlocked();
    const folder = requireFolder(current, id);
    folder.name = name;
    folder.updatedAt = Date.now();
    await persist();
  });
}

/**
 * 刪除資料夾，**內容移到上一層而不是一起刪掉**。
 *
 * 原生書籤的資料夾是連內容一起刪的，這裡刻意不同：隱私空間沒有「復原刪除」，
 * 一次誤刪就要靠備份檔才救得回來。少數人會因此多按幾次刪除，但沒有人會因此
 * 失去資料。（M4 的匯出／匯入已經做好，所以改回遞迴刪除現在是可以考慮的選項；
 * 但那要等使用者真的養成匯出備份的習慣才划算。）
 */
export async function deleteFolder(id: string): Promise<void> {
  return exclusive(async () => {
    const { payload: current } = requireUnlocked();
    const folder = requireFolder(current, id);
    const now = Date.now();

    for (const record of current.bookmarks) {
      if (record.deleted !== true && record.folderId === id) {
        record.folderId = folder.parentId;
        record.updatedAt = now;
      }
    }
    for (const child of current.folders) {
      if (child.deleted !== true && child.parentId === id) {
        child.parentId = folder.parentId;
        child.updatedAt = now;
      }
    }

    folder.deleted = true;
    folder.updatedAt = now;
    await persist();
  });
}

/** candidate 是否落在 ancestor 的子樹裡（含 ancestor 本身）。 */
function isWithin(current: VaultPayload, candidate: string, ancestor: string): boolean {
  let cursor: string | null = candidate;
  // 深度上限防資料損毀造成的環狀 parentId 讓迴圈跑不完
  for (let depth = 0; cursor !== null && depth < 32; depth += 1) {
    if (cursor === ancestor) {
      return true;
    }
    cursor = current.folders.find((folder) => folder.id === cursor)?.parentId ?? null;
  }
  return false;
}

/**
 * 搬移資料夾本身。
 *
 * 必須擋掉「搬進自己或自己的子孫」——那會造成環狀 parentId，之後
 * 巡覽與麵包屑都會走不出來（那些地方雖然都有深度上限保護，但資料已經壞了）。
 */
export async function moveFolderToParent(id: string, parentId: string | null): Promise<void> {
  return exclusive(async () => moveFolderToParentLocked(id, parentId));
}

/** 不取鎖的內部版本；呼叫者必須已經持有佇列。 */
async function moveFolderToParentLocked(id: string, parentId: string | null): Promise<void> {
  const { payload: current } = requireUnlocked();
  const folder = requireFolder(current, id);
  if (parentId !== null) {
    requireFolder(current, parentId);
    if (isWithin(current, parentId, id)) {
      throw new Error(t('vault_folder_into_itself'));
    }
  }
  folder.parentId = parentId;
  folder.updatedAt = Date.now();
  await persist();
}

export async function moveBookmarkToFolder(id: string, folderId: string | null): Promise<void> {
  return exclusive(async () => moveBookmarkToFolderLocked(id, folderId));
}

/** 不取鎖的內部版本；呼叫者必須已經持有佇列。 */
async function moveBookmarkToFolderLocked(id: string, folderId: string | null): Promise<void> {
  const { payload: current } = requireUnlocked();
  const record = current.bookmarks.find((item) => item.id === id && item.deleted !== true);
  if (record === undefined) {
    throw new Error(t('vault_bookmark_not_found'));
  }
  if (folderId !== null) {
    requireFolder(current, folderId);
  }
  record.folderId = folderId;
  record.updatedAt = Date.now();
  await persist();
}

async function persist(): Promise<void> {
  const { key: k, payload: current } = requireUnlocked();
  const encoded = fromChunks(await encodePayload(k, current));
  // 指紋與密文一起寫（同一次 storage.set），兩者不會分家 —— 見 readStoredBlob 的說明
  await writeBlob(encoded, await contentTag(current));
  // 落地之後才通知同步：同步會去讀 storage.local 的那份 blob
  persistHook();
}

async function persistLayout(): Promise<void> {
  const { key: k } = requireUnlocked();
  const current = layout ?? emptyLayout();
  const encoded = fromChunks(await encodePayload(k, current));
  await writeLayout(encoded, await layoutTag(current));
  persistHook();
}

/** 清掉過期的墓碑。在解鎖時做一次就夠。 */
function prune(): void {
  if (payload === null) {
    return;
  }
  pruneTombstones(payload);
}

// ── 合併（同步與備份共用）────────────────────────────────────────────

/**
 * 遠端那份副本本身解不開（不是本機的問題）。
 *
 * 同步要能分辨這兩件事：「遠端損毀」可以用本機那份覆蓋過去，而「本機寫入失敗」
 * 絕對不能 —— 那會把一個暫時性的本機錯誤變成對雲端唯一副本的無合併覆蓋。
 */
export class RemoteBlobUnreadable extends Error {
  constructor(cause: string) {
    super(t('vault_remote_unreadable', cause));
    this.name = 'RemoteBlobUnreadable';
  }
}

/**
 * 把另一份加密副本合併進解鎖中的隱私空間。
 *
 * 金鑰不離開這個模組，所以「解開遠端那份」這件事必須在這裡做 —— 同步模組只
 * 負責把 base64 遞進來。呼叫端要自己確認那份副本的 salt 與本機相同，否則
 * 這裡的金鑰解不開它。
 */
export async function mergeEncryptedBlob(blob: string): Promise<MergeReport> {
  return exclusive(async () => {
    const { key: k, payload: current } = requireUnlocked();

    let incoming;
    try {
      incoming = sanitizeVaultPayload(await decodePayload<unknown>(k, [blob]));
    } catch (cause) {
      throw new RemoteBlobUnreadable(cause instanceof Error ? cause.message : String(cause));
    }

    /*
     * 解密期間可能已經上鎖了（`lockVault()` 是同步的，閒置與側邊欄關閉都會呼叫它）。
     * 不重新確認的話，這裡會把明文塞回 `payload` —— 金鑰已經沒了，狀態顯示「上鎖」，
     * 而解密後的書籤就這樣留在記憶體裡。
     */
    if (key !== k) {
      throw new Error(t('vault_locked_during_merge'));
    }

    const merged = mergeVaults(current, incoming);

    /*
     * 內容真的沒變就不要重新加密。
     *
     * 每次 `persist()` 都用新的 IV，所以同一份內容加密出來的位元組永遠不同。
     * 無條件 persist 的後果是：密文變了 → 同步認為「本機與雲端不同」而上傳 →
     * 上傳又排下一次同步 → 兩秒一輪，永遠停不下來。
     *
     * 判斷用內容指紋而不是 report 的計數：合併會順手清掉剛好過期的墓碑，那讓計數
     * 顯示「有變動」而內容其實一樣（兩台裝置跨過 30 天界線時會互相推來推去）。
     */
    if ((await contentTag(current)) === (await contentTag(merged.payload))) {
      return merged.report;
    }

    if (key !== k) {
      throw new Error(t('vault_locked_during_merge'));
    }
    payload = merged.payload;
    await persist();
    return merged.report;
  });
}

export interface VaultSnapshot {
  /** 已加密的 base64，null 代表還沒有任何資料 */
  blob: string | null;
  /** 那份密文的內容指紋。舊格式或還沒算過時為 null */
  tag: string | null;
}

/**
 * 要上傳的加密副本與它的內容指紋。
 *
 * 兩者都來自 `storage.local`（`persist` 把它們寫在同一次 set 裡），所以**不可能**
 * 出現「舊的密文配新的指紋」。曾經改成從記憶體算指紋，那會在修改已套用而 persist
 * 還沒完成的瞬間產出不一致的組合，後果是那筆修改永遠不會被同步出去 —— 而且兩邊
 * 都看不出來，因為雲端那份看起來完全正常。
 *
 * 這裡不必進佇列：只是讀兩個一起寫入的鍵，沒有跨 await 的狀態。
 */
export async function currentSnapshot(): Promise<VaultSnapshot> {
  const stored = await readStoredBlob();
  return stored === null ? { blob: null, tag: null } : { blob: stored.blob, tag: stored.tag };
}

// ── 加密檔備份 ────────────────────────────────────────────────────────

/**
 * 匯出加密備份檔。
 *
 * 要求先解鎖，而檔案本身是加密的、解鎖與否都不影響內容 —— 這個要求的用意是讓
 * 使用者在匯出的當下**證明自己還記得密碼**。一份打不開的備份檔比沒有備份更糟：
 * 它會讓人以為自己有備份。
 */
export async function exportBackup(): Promise<{ filename: string; json: string }> {
  requireUnlocked();
  const meta = await readMeta();
  if (meta === null) {
    throw new Error(t('vault_not_created'));
  }
  requireCurrentFormat(meta);
  const blob = await readBlob();
  if (blob === null) {
    throw new Error(t('vault_nothing_to_export'));
  }
  const storedLayout = await readStoredLayout();
  return {
    filename: backupFilename(),
    json: buildBackup(meta, blob, Date.now(), storedLayout?.blob),
  };
}

export interface BackupImportResult {
  /** 本機原本沒有隱私空間，直接採用了整份備份（而不是合併） */
  adopted: boolean;
  report: MergeReport;
}

/**
 * 匯入加密備份檔。可以用主密碼，也可以用**救援金鑰**。
 *
 * 救援金鑰那條路是必須的：忘記主密碼時，備份檔用的是同一組密碼，所以少了它，
 * 整個備份機制在最需要它的情境下等於不存在。
 *
 * 兩種情況：
 *
 * - **本機還沒有隱私空間**（換裝置、重裝、災難還原）：連中介資料一起採用，
 *   之後就用備份檔的那組密碼／救援金鑰解鎖。這條路不需要先解鎖，否則就變成
 *   「要先有隱私空間才能還原隱私空間」。
 * - **本機已有隱私空間**：必須先解鎖，然後逐筆合併。備份檔的密碼可以與本機的
 *   不同 —— 用備份檔的金鑰解開、用本機的金鑰寫回，兩把金鑰互不相干。
 *
 * 備份檔不含預覽圖，還原後要靠「補抓預覽圖」重新產生。
 */
export async function importBackup(
  json: string,
  secret: string,
  viaRecoveryKey = false,
): Promise<BackupImportResult> {
  return exclusive(async () => {
    const backup = parseBackup(json);
    const salt = fromBase64(backup.vault.salt);
    const dek = viaRecoveryKey
      ? await unwrapDek(await recoveryKek(secret, salt), backup.vault.recoveryWrap)
      : await unwrapDek(
          await deriveKey(secret, salt, backup.vault.iterations),
          backup.vault.passwordWrap,
        );

    let backupKey: CryptoKey;
    try {
      backupKey = await importDek(dek);
    } finally {
      zero(dek);
    }
    const incoming = sanitizeVaultPayload(await decodePayload<unknown>(backupKey, [backup.blob]));
    // 版面是選用的（舊版的備份檔沒有），解不開也不該讓整份還原失敗
    let incomingLayout = emptyLayout();
    if (backup.layout !== undefined) {
      try {
        incomingLayout = sanitizeLayout(await decodePayload<unknown>(backupKey, [backup.layout]));
      } catch {
        // 維持空的
      }
    }

    if ((await readMeta()) === null) {
      await writeMeta(backup.vault);
      key = backupKey;
      payload = incoming;
      layout = incomingLayout;
      await persist();
      await persistLayout();
      return { adopted: true, report: countAlive(incoming) };
    }

    const { payload: current } = requireUnlocked();
    const merged = mergeVaults(current, incoming);
    payload = merged.payload;
    layout = mergeLayouts(layout ?? emptyLayout(), incomingLayout);
    await persist();
    await persistLayout();
    return { adopted: false, report: merged.report };
  });
}

// ── 縮圖加密 ──────────────────────────────────────────────────────────

// 鍵的格式定義在 shared/url.ts —— 側邊欄比對廣播時要用同一個
export { vaultThumbKey };

/**
 * 把明文縮圖轉成加密縮圖，並刪掉明文那份。
 *
 * 刪掉明文是關鍵：如果隱私書籤的截圖以明文躺在 IndexedDB 裡，
 * 任何能翻擴充套件儲存目錄的人看圖就知道內容，整個加密設計就形同虛設。
 */
async function encryptThumb(record: PrivateBookmark): Promise<void> {
  const { key: k } = requireUnlocked();
  const plainKey = await urlKey(record.url);
  const existing = await getThumb(plainKey);
  if (existing === undefined || existing.encrypted) {
    return;
  }
  const sealed = await seal(k, copyBytes(new Uint8Array(existing.bytes)));
  await putThumb({
    ...existing,
    key: vaultThumbKey(record.id),
    bytes: sealed.ciphertext,
    iv: sealed.iv,
    encrypted: true,
  });
  await deleteThumb(plainKey);
}

/** 移出隱私空間時把縮圖還原成明文。 */
async function decryptThumbToPlain(record: PrivateBookmark): Promise<void> {
  const { key: k } = requireUnlocked();
  const encryptedKey = vaultThumbKey(record.id);
  const existing = await getThumb(encryptedKey);
  if (existing === undefined || !existing.encrypted || existing.iv === null) {
    return;
  }
  const plain = await unseal(k, { iv: copyBytes(existing.iv), ciphertext: existing.bytes });
  await putThumb({
    ...existing,
    key: await urlKey(record.url),
    bytes: plain,
    iv: null,
    encrypted: false,
  });
  await deleteThumb(encryptedKey);
}

export async function readVaultThumb(id: string): Promise<VaultThumbPayload | null> {
  const { key: k } = requireUnlocked();
  const record = await getThumb(vaultThumbKey(id));
  if (record === undefined || !record.encrypted || record.iv === null) {
    return null;
  }
  try {
    const bytes = await unseal(k, { iv: copyBytes(record.iv), ciphertext: record.bytes });
    return {
      bytes,
      mime: record.mime,
      width: record.width,
      height: record.height,
      source: record.source,
    };
  } catch {
    return null;
  }
}

/** 依 id 找隱私書籤。重新抓預覽圖需要取出它的網址。 */
export function findVaultBookmarkById(id: string): PrivateBookmark | null {
  if (payload === null) {
    return null;
  }
  return payload.bookmarks.find((record) => record.id === id && record.deleted !== true) ?? null;
}

/** 依網址找隱私書籤。用於右鍵手動指定預覽圖時判斷這一頁屬於隱私空間。 */
export function findVaultBookmarkByUrl(url: string): PrivateBookmark | null {
  if (payload === null) {
    return null;
  }
  // 容許 http/https 的差異（`shared/url-match.ts`）：隱私書籤存的網址一樣可能是
  // 多年前的 http，而頁面早就轉到 https —— 嚴格比對會讓右鍵手動指定對它完全失效
  return (
    payload.bookmarks.find(
      (record) => record.deleted !== true && isSamePageIgnoringScheme(record.url, url),
    ) ?? null
  );
}

/** 以隱私空間的金鑰加密並存入縮圖。 */
export async function storeVaultThumbnail(
  id: string,
  thumbnail: { bytes: ArrayBuffer; mime: string; width: number; height: number },
): Promise<void> {
  {
    const { key: k } = requireUnlocked();
    const sealed = await seal(k, copyBytes(new Uint8Array(thumbnail.bytes)));
    await putThumb({
      key: vaultThumbKey(id),
      bytes: sealed.ciphertext,
      mime: thumbnail.mime,
      width: thumbnail.width,
      height: thumbnail.height,
      source: 'cover',
      capturedAt: Date.now(),
      encrypted: true,
      iv: sealed.iv,
    });
  }
}

/** 給縮圖整理用：這些鍵屬於隱私空間，不是孤兒。 */
export function protectedThumbKeys(): Set<string> {
  if (payload === null) {
    return new Set();
  }
  return new Set(payload.bookmarks.map((record) => vaultThumbKey(record.id)));
}

// ── 移入／移出 ────────────────────────────────────────────────────────

export interface ImportResult {
  moved: boolean;
  /** 移入的書籤數。整個資料夾移入時會大於 1 */
  bookmarks: number;
  /** 一併建立的隱私資料夾數。單筆書籤是 0 */
  folders: number;
  /** 實際清掉瀏覽記錄的筆數 */
  historyPurged: number;
  historyUnavailable: boolean;
}

export interface BatchImportResult {
  /** 移入的書籤數（不是「處理了幾個項目」——一個資料夾可能帶進上百筆） */
  imported: number;
  /** 一併建立的隱私資料夾數 */
  folders: number;
  failed: number;
  /** 實際清掉瀏覽記錄的筆數 */
  historyPurged: number;
  /** 有任何一筆因為缺少 history 權限而沒清成 */
  historyUnavailable: boolean;
}

/**
 * 把原生書籤移進隱私空間。
 *
 * 步驟順序很重要：先寫入加密資料並確認落地，最後才移除原生書籤。
 * 反過來的話中途失敗就等於直接遺失書籤。
 */
export async function importNativeBookmark(
  bookmarkId: string,
  purgeHistory: boolean,
): Promise<ImportResult> {
  return exclusive(async () => importOneLocked(bookmarkId, purgeHistory));
}

/** 不取鎖的內部版本；呼叫者必須已經持有佇列。 */
async function importOneLocked(bookmarkId: string, purgeHistory: boolean): Promise<ImportResult> {
  {
    const { payload: current } = requireUnlocked();
    const nodes = await browser.bookmarks.get(bookmarkId);
    const node = nodes[0];
    if (node === undefined) {
      throw new Error(t('bookmark_not_found'));
    }
    // 資料夾走遞迴那條路：整棵子樹一起搬，結構保留
    if (node.url === undefined) {
      return importFolderLocked(bookmarkId, purgeHistory);
    }

    const now = Date.now();
    const record: PrivateBookmark = {
      id: crypto.randomUUID(),
      url: node.url,
      title: node.title,
      folderId: null,
      createdAt: now,
      updatedAt: now,
    };
    current.bookmarks.push(record);
    await encryptThumb(record);
    await persist();

    // 這一步不可逆：書籤從此不在 Firefox 的書籤樹裡
    await browser.bookmarks.remove(bookmarkId);

    const outcome = purgeHistory ? await purgeHistoryFor(node.url) : 'skipped';
    return {
      moved: true,
      bookmarks: 1,
      folders: 0,
      historyPurged: outcome === 'purged' ? 1 : 0,
      historyUnavailable: outcome === 'unavailable',
    };
  }
}

/**
 * Firefox 內建的根資料夾（書籤選單／書籤工具列／其他書籤／行動書籤）不能移入。
 *
 * 它們是永久的，`removeTree` 會失敗 —— 而失敗的時機是在加密資料已經落地之後，
 * 結果就是「書籤兩邊都有」。與其讓它走到那一步，不如一開始就擋掉並說清楚。
 */
async function assertImportableFolder(id: string): Promise<void> {
  const tree = await browser.bookmarks.getTree();
  const root = tree[0];
  const permanent = new Set<string>([
    ...(root === undefined ? [] : [root.id]),
    ...(root?.children ?? []).map((child) => child.id),
  ]);
  if (permanent.has(id)) {
    throw new Error(t('vault_root_folder_not_importable'));
  }
}

/**
 * 整個資料夾移入隱私空間。
 *
 * 順序與單筆一樣、而且更要緊：**先把加密資料落地，最後才 `removeTree`**。
 * 反過來的話中途失敗就是整棵子樹的書籤直接消失 —— 單筆做錯損失一筆，
 * 這裡做錯損失的是使用者整個分類。
 *
 * 轉換規則（保留層級、空資料夾照建、`place:` 略過）在 `shared/vault-subtree.ts`，
 * 那是純函式而且有測試；這裡只負責 IO。
 */
async function importFolderLocked(folderId: string, purgeHistory: boolean): Promise<ImportResult> {
  const { payload: current } = requireUnlocked();
  await assertImportableFolder(folderId);

  const subtree = (await browser.bookmarks.getSubTree(folderId))[0];
  if (subtree === undefined) {
    throw new Error(t('vault_folder_not_found'));
  }

  const plan = planFolderImport(subtree, null, () => crypto.randomUUID());
  const now = Date.now();
  for (const folder of plan.folders) {
    current.folders.push({
      id: folder.id,
      name: folder.name,
      parentId: folder.parentId,
      updatedAt: now,
    });
  }

  const records: PrivateBookmark[] = plan.bookmarks.map((item) => ({
    id: crypto.randomUUID(),
    url: item.url,
    title: item.title,
    folderId: item.folderId,
    createdAt: now,
    updatedAt: now,
  }));
  current.bookmarks.push(...records);

  // 縮圖逐筆搬成加密版（明文那份會被刪掉），失敗不該讓整個移入停下 ——
  // 少一張預覽圖重抓就有，書籤沒進來才是真的損失
  for (const record of records) {
    try {
      await encryptThumb(record);
    } catch {
      // 忽略：縮圖不是資料本體
    }
  }

  await persist();
  // 這一步不可逆，而且一定要在 persist 之後
  await browser.bookmarks.removeTree(folderId);

  let historyPurged = 0;
  let historyUnavailable = false;
  if (purgeHistory) {
    for (const record of records) {
      const outcome = await purgeHistoryFor(record.url);
      if (outcome === 'purged') {
        historyPurged += 1;
      }
      if (outcome === 'unavailable') {
        historyUnavailable = true;
        break;
      }
    }
  }

  return {
    moved: true,
    bookmarks: records.length,
    folders: plan.folders.length,
    historyPurged,
    historyUnavailable,
  };
}

/**
 * 批量移入。
 *
 * 逐筆呼叫 `importNativeBookmark` 而不是「全部寫完再一次 persist」——
 * 那樣看似省下 N 次寫入，但中途失敗就會變成「原生書籤已刪、加密資料沒落地」，
 * 也就是直接遺失書籤。每一筆各自維持「先寫入、後刪除」的順序才安全。
 *
 * 單筆失敗不中斷整批：使用者選了二十筆，不該因為其中一筆已被刪掉而全部停下。
 */
export async function importManyNativeBookmarks(
  bookmarkIds: readonly string[],
  purgeHistory: boolean,
): Promise<BatchImportResult> {
  return exclusive(async () => {
    requireUnlocked();
    let imported = 0;
    let folders = 0;
    let failed = 0;
    let historyPurged = 0;
    let historyUnavailable = false;

    for (const bookmarkId of bookmarkIds) {
      try {
        const result = await importOneLocked(bookmarkId, purgeHistory);
        // 累加實際筆數而不是「+1」：勾到的可能是資料夾，那一次就帶進好幾十筆
        imported += result.bookmarks;
        folders += result.folders;
        historyPurged += result.historyPurged;
        if (result.historyUnavailable) {
          historyUnavailable = true;
        }
      } catch {
        failed += 1;
      }
    }

    return { imported, folders, failed, historyPurged, historyUnavailable };
  });
}

/** 重新命名隱私書籤。原生書籤走 `bookmarks/rename`，這裡的記錄不在書籤樹裡。 */
export async function renameBookmark(id: string, title: string): Promise<void> {
  return exclusive(async () => {
    const { payload: current } = requireUnlocked();
    const record = current.bookmarks.find((item) => item.id === id && item.deleted !== true);
    if (record === undefined) {
      throw new Error(t('vault_bookmark_not_found'));
    }
    record.title = title;
    record.updatedAt = Date.now();
    await persist();
  });
}

/**
 * 從隱私空間移回原生書籤。
 *
 * 目標資料夾的優先序：呼叫端指定 → 設定裡的預設 → Firefox 的預設（其他書籤）。
 * 設定裡那個資料夾可能已經被刪掉，所以建立失敗時退回預設位置而不是整個失敗 ——
 * 書籤已經要離開隱私空間了，這時丟錯會讓它卡在兩邊都沒有的狀態。
 */
export async function exportToNative(id: string, parentId?: string): Promise<void> {
  return exclusive(async () => exportOneLocked(id, parentId));
}

/** 不取鎖的內部版本；呼叫者必須已經持有佇列。 */
async function exportOneLocked(id: string, parentId?: string): Promise<void> {
  {
    const { payload: current } = requireUnlocked();
    // 資料夾走遞迴那條路（與移入對稱）
    if (current.folders.some((folder) => folder.id === id && folder.deleted !== true)) {
      return exportFolderLocked(id, parentId);
    }
    const record = current.bookmarks.find((item) => item.id === id && item.deleted !== true);
    if (record === undefined) {
      throw new Error(t('vault_bookmark_not_found'));
    }
    const settings = await getSettings();
    const target = parentId ?? settings.vaultExportFolderId ?? undefined;

    await decryptThumbToPlain(record);
    const details = { title: record.title, url: record.url };
    try {
      await browser.bookmarks.create(target === undefined ? details : { ...details, parentId: target });
    } catch {
      await browser.bookmarks.create(details);
    }

    record.deleted = true;
    record.updatedAt = Date.now();
    await deleteThumb(vaultThumbKey(record.id));
    await persist();
  }
}

/**
 * 整個隱私資料夾移回原生書籤。
 *
 * 與移入相反的順序：**先把原生書籤建出來，最後才標記刪除**。反過來的話
 * 中途失敗就是資料兩邊都沒有 —— 原則同樣是「任何一個瞬間，資料至少存在於一邊」。
 *
 * 資料夾一定要父在子之前建（原生 API 沒有父就建不了子），那個順序由
 * `planFolderExport` 保證。
 */
async function exportFolderLocked(folderId: string, parentId?: string): Promise<void> {
  const { payload: current } = requireUnlocked();
  const plan = planFolderExport(current.folders, current.bookmarks, folderId);
  const rootFolder = plan.folders[0];
  if (rootFolder === undefined) {
    throw new Error(t('vault_private_folder_not_found'));
  }

  const settings = await getSettings();
  const target = parentId ?? settings.vaultExportFolderId ?? undefined;

  // 隱私空間的資料夾 id → 剛建出來的原生資料夾 id
  const nativeIds = new Map<string, string>();
  for (const folder of plan.folders) {
    // 子樹裡的資料夾掛在剛建好的父底下；根那一層掛在使用者指定的落點
    const parent = folder.id === folderId ? target : nativeIds.get(folder.parentId ?? '');
    const details = { title: folder.name || t('folder_untitled_folder') };
    let created;
    try {
      created = await browser.bookmarks.create(parent === undefined ? details : { ...details, parentId: parent });
    } catch {
      // 落點可能已經被刪掉；退回 Firefox 的預設位置而不是整個失敗
      created = await browser.bookmarks.create(details);
    }
    nativeIds.set(folder.id, created.id);
  }

  const now = Date.now();
  for (const record of plan.bookmarks) {
    await decryptThumbToPlain(record);
    const parent = nativeIds.get(record.folderId ?? '');
    const details = { title: record.title, url: record.url };
    try {
      await browser.bookmarks.create(parent === undefined ? details : { ...details, parentId: parent });
    } catch {
      await browser.bookmarks.create(details);
    }
    record.deleted = true;
    record.updatedAt = now;
    await deleteThumb(vaultThumbKey(record.id));
  }

  for (const planned of plan.folders) {
    const folder = current.folders.find((item) => item.id === planned.id);
    if (folder !== undefined) {
      folder.deleted = true;
      folder.updatedAt = now;
    }
  }

  await persist();
}

export interface BatchCountResult {
  done: number;
  failed: number;
}

/** 批量移出。逐筆處理，單筆失敗不中斷整批。 */
export async function exportManyToNative(
  ids: readonly string[],
  parentId?: string,
): Promise<BatchCountResult> {
  return exclusive(async () => {
    requireUnlocked();
    let done = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await exportOneLocked(id, parentId);
        done += 1;
      } catch {
        failed += 1;
      }
    }
    return { done, failed };
  });
}

/**
 * 批量搬到隱私空間裡的另一個資料夾。
 *
 * 書籤與資料夾都要處理：多選是可以勾資料夾的，若這裡只認書籤，勾了資料夾
 * 按下「移動到…」就會回報「0 個成功、1 個失敗」而使用者完全看不出為什麼。
 *
 * **一定要呼叫 `*Locked` 版本。** 這裡曾經呼叫會自己取鎖的
 * `moveFolderToParent` / `moveBookmarkToFolder`，而佇列不可重入 —— 內層等外層、
 * 外層等內層，整個 vault 佇列從此卡死：按下去什麼都沒發生，**之後每一個寫入
 * 操作（新增資料夾、移入、刪除、同步合併）都跟著無聲失效**，直到背景頁重啟。
 * 型別檢查與當時的 110 項測試全綠，因為沒有任何測試涵蓋巢狀呼叫。
 */
export async function moveManyToFolder(
  ids: readonly string[],
  folderId: string | null,
): Promise<BatchCountResult> {
  return exclusive(async () => {
    const { payload: current } = requireUnlocked();
    let done = 0;
    let failed = 0;
    for (const id of ids) {
      const isFolder = current.folders.some((folder) => folder.id === id && folder.deleted !== true);
      try {
        if (isFolder) {
          await moveFolderToParentLocked(id, folderId);
        } else {
          await moveBookmarkToFolderLocked(id, folderId);
        }
        done += 1;
      } catch {
        failed += 1;
      }
    }
    return { done, failed };
  });
}

/** 直接刪除隱私書籤，不還原成原生書籤。 */
export async function removeBookmark(id: string): Promise<void> {
  return exclusive(async () => {
    const { payload: current } = requireUnlocked();
    const record = current.bookmarks.find((item) => item.id === id);
    if (record === undefined) {
      return;
    }
    record.deleted = true;
    record.updatedAt = Date.now();
    await deleteThumb(vaultThumbKey(record.id));
    await persist();
  });
}

// ── 排列（版面）───────────────────────────────────────────────────────

export function readLayout(): VaultLayout {
  requireUnlocked();
  return layout ?? emptyLayout();
}

/** 把一筆（書籤或資料夾）搬到 `folderId` 底下。已經在那裡就不動。回傳有沒有搬 */
function placeUnder(current: VaultPayload, id: string, folderId: string | null, now: number): boolean {
  const record = current.bookmarks.find((item) => item.id === id && item.deleted !== true);
  if (record !== undefined) {
    if (record.folderId === folderId) {
      return false;
    }
    record.folderId = folderId;
    record.updatedAt = now;
    return true;
  }
  const folder = requireFolder(current, id);
  if (folder.parentId === folderId) {
    return false;
  }
  if (folderId !== null && isWithin(current, folderId, id)) {
    throw new Error(t('vault_folder_into_itself'));
  }
  folder.parentId = folderId;
  folder.updatedAt = now;
  return true;
}

function childIdsOf(folderId: string | null): string[] {
  return vaultChildren(listFolders(), listBookmarks(), folderId, layout ?? emptyLayout()).map(
    vaultChildId,
  );
}

/**
 * 拖拽排序：把 `ids` 放到 `folderId` 裡 `beforeId` 那一筆的前面（null = 最後）。
 *
 * 也涵蓋「拖進資料夾」—— 那就是 `beforeId: null`。不在這個資料夾的先搬過來，
 * 搬動與排序在同一個佇列項目裡做完，不會有「搬了但排序還沒寫」被同步撞見的空檔。
 */
export async function reorder(
  ids: readonly string[],
  folderId: string | null,
  beforeId: string | null,
): Promise<void> {
  return exclusive(async () => {
    const { payload: current } = requireUnlocked();
    if (folderId !== null) {
      requireFolder(current, folderId);
    }
    const now = Date.now();
    let moved = false;
    for (const id of ids) {
      moved = placeUnder(current, id, folderId, now) || moved;
    }
    if (moved) {
      await persist();
    }
    const children = childIdsOf(folderId);
    layout = withFolderOrder(
      layout ?? emptyLayout(),
      folderId,
      moveIds(children, ids, beforeId),
      new Set(children),
      now,
    );
    await persistLayout();
  });
}

/**
 * 兩張卡片疊在一起 →「建立資料夾」：在 `targetId` 的位置建一個資料夾，把它與 `ids`
 * 依序搬進去。回傳新資料夾的 id。
 *
 * 建資料夾與搬移必須在同一個佇列項目裡（「多選移動讓佇列永久卡死」那次的前車之鑑是
 * 巢狀取鎖；這裡反過來，分兩次送的話中間可能插進一次同步合併）。
 */
export async function mergeIntoNewFolder(
  targetId: string,
  ids: readonly string[],
  name: string,
): Promise<string> {
  return exclusive(async () => {
    const { payload: current } = requireUnlocked();
    const target =
      current.bookmarks.find((item) => item.id === targetId && item.deleted !== true) ??
      requireFolder(current, targetId);
    const parentId = 'folderId' in target ? target.folderId : target.parentId;
    const now = Date.now();
    const siblings = childIdsOf(parentId);

    const id = crypto.randomUUID();
    current.folders.push({ id, name, parentId, updatedAt: now });
    const members = [targetId, ...ids.filter((member) => member !== targetId)];
    for (const member of members) {
      placeUnder(current, member, id, now);
    }
    await persist();

    // 新資料夾放在被疊上去的那張卡片原本的位置
    const parentOrder = moveIds([...siblings, id], [id], targetId).filter(
      (member) => !members.includes(member),
    );
    let next = withFolderOrder(
      layout ?? emptyLayout(),
      parentId,
      parentOrder,
      new Set(childIdsOf(parentId)),
      now,
    );
    next = withFolderOrder(next, id, members, new Set(members), now);
    layout = next;
    await persistLayout();
    return id;
  });
}

/**
 * 把另一份加密的版面合併進來（同步用）。回傳內容有沒有變。
 */
export async function mergeEncryptedLayout(blob: string): Promise<boolean> {
  return exclusive(async () => {
    const { key: k } = requireUnlocked();
    let incoming: VaultLayout;
    try {
      incoming = sanitizeLayout(await decodePayload<unknown>(k, [blob]));
    } catch (cause) {
      throw new RemoteBlobUnreadable(cause instanceof Error ? cause.message : String(cause));
    }
    if (key !== k) {
      throw new Error(t('vault_locked_during_merge'));
    }
    const current = layout ?? emptyLayout();
    const merged = mergeLayouts(current, incoming);
    // 與書籤那份同理：內容沒變就不要重新加密，否則兩台裝置會無止盡地互相上傳
    if ((await layoutTag(current)) === (await layoutTag(merged))) {
      return false;
    }
    layout = merged;
    await persistLayout();
    return true;
  });
}

// ── 瀏覽記錄清除 ──────────────────────────────────────────────────────

type PurgeOutcome = 'purged' | 'unavailable' | 'skipped';

/**
 * 清除該網址的瀏覽記錄。
 *
 * 沒清的話網址列自動完成仍會浮出這些網址 —— 書籤藏起來了，
 * 打幾個字卻又跳出來，隱私效果會有明顯破口。
 *
 * history 是選用權限。與 captureVisibleTab 同樣的陷阱：API 是否存在取決於
 * context 建立時權限是否已授予，所以這裡要檢查函式本身而不只是權限旗標。
 */
async function purgeHistoryFor(url: string): Promise<PurgeOutcome> {
  if (!(await browser.permissions.contains({ permissions: ['history'] }))) {
    return 'unavailable';
  }
  const api = (browser as { history?: { deleteUrl?: unknown } }).history;
  if (typeof api?.deleteUrl !== 'function') {
    return 'unavailable';
  }
  await browser.history.deleteUrl({ url });
  return 'purged';
}
