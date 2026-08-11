import { t } from './i18n';
import type { VaultMeta } from './types';

/**
 * 加密備份檔的容器格式。
 *
 * 「忘記主密碼就永久遺失」是這個擴充套件唯一無法補救的失敗模式，備份檔是它的
 * 出口。因此格式的每個選擇都往「三年後還打得開」靠：
 *
 * - **純文字 JSON**，不是二進位。使用者能用任何編輯器確認裡面沒有明文，
 *   壞掉時也還有機會人工搶救。
 * - **整份 `VaultMeta` 一定要在檔案裡**（salt、KDF 參數、兩個包裹）。少了它們，
 *   即使記得密碼也派生不出金鑰 —— 檔案就是一堆永遠打不開的位元組。這是這個格式
 *   最重要的部分。存整個物件而不是逐欄複製：少帶一個欄位的症狀是「還原時打不開」，
 *   而那要等到真的需要還原的那一天才會發現。
 * - 因此備份檔也能用**救援金鑰**打開。少了這一點，「忘記主密碼」時備份檔一樣是廢的
 *   —— 那會讓整個備份機制在最需要它的情境下失效。
 * - `format` 與 `version` 讓「這不是備份檔」與「這是未來版本的備份檔」能給出
 *   不同的訊息。
 *
 * 刻意**不含預覽圖**：圖片會讓檔案大上兩三個數量級，而預覽圖丟了可以重抓，
 * 書籤丟了才是真的沒了。匯入後按一次「補抓預覽圖」就會回來。
 */
export const BACKUP_FORMAT = 'bookmark-preview-vault-backup';
export const BACKUP_VERSION = 1;

export interface BackupFile {
  format: string;
  version: number;
  createdAt: number;
  /** 那個隱私空間的中介資料，原樣搬過來 */
  vault: VaultMeta;
  /** base64 的加密信封（`vault-codec` 的輸出接回單一字串） */
  blob: string;
}

export function buildBackup(meta: VaultMeta, blob: string, now: number = Date.now()): string {
  const file: BackupFile = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: now,
    vault: meta,
    blob,
  };
  // 縮排兩格：檔案大小差別可以忽略，但人工檢查與 diff 差很多
  return JSON.stringify(file, null, 2);
}

function fail(reason: string): never {
  throw new Error(reason);
}

export function parseBackup(text: string): BackupFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail(t('backup_invalid_json'));
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return fail(t('backup_not_a_backup'));
  }

  const file = parsed as Partial<BackupFile>;
  if (file.format !== BACKUP_FORMAT) {
    return fail(t('backup_wrong_extension'));
  }
  if (typeof file.version !== 'number' || file.version > BACKUP_VERSION) {
    return fail(t('backup_newer_version'));
  }

  const vault = file.vault as Partial<VaultMeta> | undefined;
  // salt 與 KDF 參數缺了就永遠派生不出金鑰，這時要明講而不是丟一個解密失敗
  if (typeof vault?.salt !== 'string' || vault.salt === '') {
    return fail(t('backup_missing_salt'));
  }
  if (
    typeof vault.iterations !== 'number' ||
    !Number.isInteger(vault.iterations) ||
    vault.iterations < 1
  ) {
    return fail(t('backup_bad_iterations'));
  }
  if (typeof vault.passwordWrap?.ct !== 'string' || typeof vault.passwordWrap.iv !== 'string') {
    return fail(t('backup_missing_password_wrap'));
  }
  if (typeof vault.recoveryWrap?.ct !== 'string' || typeof vault.recoveryWrap.iv !== 'string') {
    return fail(t('backup_missing_recovery_wrap'));
  }
  if (typeof file.blob !== 'string' || file.blob === '') {
    return fail(t('backup_missing_blob'));
  }

  return {
    format: file.format,
    version: file.version,
    createdAt: typeof file.createdAt === 'number' && Number.isFinite(file.createdAt) ? file.createdAt : 0,
    vault: vault as VaultMeta,
    blob: file.blob,
  };
}

/** 檔名帶日期，讓多份備份放在同一個資料夾裡看得出先後。 */
export function backupFilename(at: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return t('backup_filename', stamp);
}
