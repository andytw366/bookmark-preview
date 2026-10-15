import { SYNC_META_RESERVE, SYNC_TOTAL_BUDGET } from '@/crypto/chunk';
import { getSettings } from './settings';
import { syncAvailable } from './vault-sync';

/**
 * 書籤的排列與群組（`grid:<資料夾>`）在 `storage.sync` 上的預算。
 *
 * `storage.sync` 整個只有 100 KB，與隱私空間的加密副本共用。書籤這邊**最多** 20 KB：
 * 超過就停止同步排列（只存本機）並在設定頁說明。
 *
 * 隱私空間只扣掉書籤這邊**實際用掉的**再加一點餘裕（`gridSyncReserve`），不是整整 20 KB ——
 * 80 筆書籤的排列只佔幾 KB，固定扣 20 KB 等於讓隱私空間少放一百多筆。代價是兩邊會互相擠：
 * 書籤這邊長大時，可用的上限也要扣掉隱私空間已經佔的（`gridSyncBudget`）。
 */
export const GRID_PREFIX = 'grid:';
export const GRID_SYNC_BUDGET = 20_480;
/** `storage.sync` 單筆上限（鍵名 + JSON）。超過的那個資料夾只存本機 */
export const GRID_ITEM_LIMIT = 8_192;
/** 隱私空間替書籤排列多留的空間：排列小幅成長（新的群組、幾個資料夾）不必等隱私空間讓位 */
export const GRID_SYNC_HEADROOM = 4_096;

export function gridKey(folderId: string): string {
  return `${GRID_PREFIX}${folderId}`;
}

export function gridBytes(key: string, value: unknown): number {
  return key.length + JSON.stringify(value).length;
}

/** 雲端上 `grid:` 與其他鍵各佔多少 */
async function syncUsage(): Promise<{ grid: number; others: number }> {
  const all = await browser.storage.sync.get(null);
  let grid = 0;
  let others = 0;
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(GRID_PREFIX)) {
      grid += gridBytes(key, value);
    } else {
      others += gridBytes(key, value);
    }
  }
  return { grid, others };
}

/** 隱私空間的配額檢查要先扣掉的部分：書籤排列實際佔的加上餘裕，最多 20 KB */
export async function gridSyncReserve(): Promise<number> {
  if (!syncAvailable() || !(await getSettings()).syncGrid) {
    return 0;
  }
  const { grid } = await syncUsage();
  return Math.min(GRID_SYNC_BUDGET, grid + GRID_SYNC_HEADROOM);
}

/** 書籤排列這次能用多少：20 KB，或扣掉其他東西（隱私空間）之後剩下的，取小的 */
export async function gridSyncBudget(): Promise<number> {
  const { others } = await syncUsage();
  return Math.max(0, Math.min(GRID_SYNC_BUDGET, SYNC_TOTAL_BUDGET - SYNC_META_RESERVE - others));
}
