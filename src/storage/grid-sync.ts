import { getSettings } from './settings';
import { syncAvailable } from './vault-sync';

/**
 * 書籤的排列與群組（`grid:<資料夾>`）在 `storage.sync` 上的預算。
 *
 * `storage.sync` 整個只有 100 KB，與隱私空間的加密副本共用。書籤這邊**固定**佔 20 KB：
 * 超過就停止同步排列（只存本機）並在設定頁說明 —— 騰出的空間留給隱私空間，那邊的
 * 配額檢查要把這 20 KB 扣掉（`gridSyncReserve`）。
 */
export const GRID_PREFIX = 'grid:';
export const GRID_SYNC_BUDGET = 20_480;
/** `storage.sync` 單筆上限（鍵名 + JSON）。超過的那個資料夾只存本機 */
export const GRID_ITEM_LIMIT = 8_192;

export function gridKey(folderId: string): string {
  return `${GRID_PREFIX}${folderId}`;
}

export function gridBytes(key: string, value: unknown): number {
  return key.length + JSON.stringify(value).length;
}

/** 隱私空間的配額檢查要先扣掉的部分：書籤排列的同步打開時就是整個預算 */
export async function gridSyncReserve(): Promise<number> {
  return syncAvailable() && (await getSettings()).syncGrid ? GRID_SYNC_BUDGET : 0;
}
