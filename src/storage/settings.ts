import type { Settings } from '@/shared/types';
import { DEFAULT_VAULT_TRIGGER } from '@/shared/vault-entry';

const KEY = 'settings';

export const DEFAULT_SETTINGS: Settings = {
  captureEnabled: true,
  previewSource: 'cover-first',
  captureBlocklist: [],
  thumbMaxAgeDays: 14,
  density: 'card',
  autoLockMinutes: 5,
  vaultEntry: 'hidden',
  vaultTrigger: DEFAULT_VAULT_TRIGGER,
  vaultExportFolderId: null,
  vaultSyncEnabled: false,
  syncGrid: true,
};

export async function getSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(KEY);
  const value = stored[KEY] as Partial<Settings> | undefined;
  // 逐欄合併預設值，讓日後新增設定項目時舊資料不會缺欄位
  return { ...DEFAULT_SETTINGS, ...value };
}

export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await browser.storage.local.set({ [KEY]: next });
  return next;
}

/** 監聽設定變動，讓多個擴充套件頁面保持同步。 */
export function onSettingsChanged(handler: (settings: Settings) => void): () => void {
  const listener = (
    changes: Record<string, browser.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'local' || !(KEY in changes)) {
      return;
    }
    const next = changes[KEY]?.newValue as Partial<Settings> | undefined;
    handler({ ...DEFAULT_SETTINGS, ...next });
  };
  browser.storage.onChanged.addListener(listener);
  return () => {
    browser.storage.onChanged.removeListener(listener);
  };
}

/** 主機名稱是否落在擷取黑名單內。 */
export function isBlocked(hostname: string, blocklist: readonly string[]): boolean {
  const target = hostname.toLowerCase();
  return blocklist.some((pattern) => {
    const needle = pattern.trim().toLowerCase();
    return needle !== '' && target.includes(needle);
  });
}
