import type { ThumbSource } from '@/shared/types';

/** 已經解好、可以直接掛到 `<img src>` 的縮圖。 */
export interface CachedImage {
  src: string;
  width: number;
  height: number;
  source: ThumbSource;
}

interface Entry {
  /** null 代表「查過了，這個書籤沒有縮圖」—— 與「還沒查過」是兩件事 */
  image: CachedImage | null;
  /** 目前有幾個元件在用它。大於 0 時絕對不能撤銷 object URL */
  users: number;
  /** 最後一次被取用的流水號，用於淘汰最久沒用到的 */
  usedAt: number;
  /**
   * 內容已經過時（補抓或重新抓之後）。
   *
   * 標記而不是直接刪掉，是為了保住 `users`：同一個網址可能有兩列同時在顯示，
   * 刪掉再重建會把佔用數重設成 1，於是還有人在看的項目變成可淘汰 ——
   * 那會撤銷正在顯示的 object URL，畫面出現破圖。
   */
  stale: boolean;
}

/**
 * 上限。
 *
 * 只需要遠大於「同時看得到的縮圖數」即可 —— 虛擬滾動之後那個數字是幾十，
 * 三百給了一個數量級的餘裕，捲動一整頁再捲回來仍然全部命中。
 */
const LIMIT = 300;

const cache = new Map<string, Entry>();
let clock = 0;

/**
 * 縮圖快取。
 *
 * 虛擬滾動之後，捲動會不停地掛載／卸載同一批列。沒有快取的話每一次重新掛載
 * 都要重跑「SHA-256 → 讀 IndexedDB → 建 Blob → 建 object URL」——實測捲動
 * 一小段就重讀了數百次。真正的問題不是吞吐量（三千次讀取一秒內就跑完），
 * 而是**每次重讀之間那一格會先顯示色卡再換成圖**，捲回去的每一列都閃一下。
 *
 * 淘汰時會跳過還有人在用的項目：撤銷了正在顯示的 object URL，那張圖會直接變成
 * 破圖，而且只有在快取剛好滿的時候才會發生 —— 是最難重現的那種缺陷。
 */
export function peekThumb(key: string): CachedImage | null | undefined {
  const entry = cache.get(key);
  if (entry === undefined || entry.stale) {
    return undefined;
  }
  entry.usedAt = (clock += 1);
  return entry.image;
}

/**
 * 宣告「我正在用這個 key」，並回傳目前的內容。
 *
 * 回傳 `undefined` 代表「還沒讀過、或內容已過時」，呼叫端要自己去讀一次；
 * 佔用數不論如何都會加上去。
 */
export function holdThumb(key: string): CachedImage | null | undefined {
  const entry = cache.get(key);
  if (entry === undefined) {
    cache.set(key, { image: null, users: 1, usedAt: (clock += 1), stale: true });
    return undefined;
  }
  entry.users += 1;
  entry.usedAt = (clock += 1);
  return entry.stale ? undefined : entry.image;
}

export function releaseThumb(key: string): void {
  const entry = cache.get(key);
  if (entry !== undefined && entry.users > 0) {
    entry.users -= 1;
  }
  evict();
}

/** 記下讀取結果。`image` 為 null 表示這個書籤沒有縮圖。 */
export function storeThumb(key: string, image: CachedImage | null): void {
  const existing = cache.get(key);
  if (existing !== undefined) {
    if (existing.image !== image) {
      revoke(existing.image);
    }
    existing.image = image;
    existing.stale = false;
    existing.usedAt = (clock += 1);
    return;
  }
  cache.set(key, { image, users: 0, usedAt: (clock += 1), stale: false });
  evict();
}

/**
 * 縮圖換了（補抓、重新抓）——標記過時，讓下一次讀取拿到新的。
 *
 * **舊圖先留著不撤銷**，等新的讀進來再由 `storeThumb` 換掉：正在顯示它的那一列
 * 還沒重繪，這時撤銷 object URL 會讓畫面短暫出現破圖。真的沒有人來重讀時，
 * 淘汰那一步也會把它撤銷掉，不會漏。
 */
export function invalidateThumb(key: string): void {
  const entry = cache.get(key);
  if (entry !== undefined) {
    entry.stale = true;
  }
}

/**
 * 全部標記過時（設定頁清除了所有預覽圖）。
 *
 * 與 `invalidateThumb` 同樣只標記、不撤銷：正在顯示的那幾列還沒重繪，這時撤銷
 * object URL 會出現破圖。重讀之後 `storeThumb` 會拿 null 換掉它們。
 */
export function invalidateAllThumbs(): void {
  for (const entry of cache.values()) {
    entry.stale = true;
  }
}

function revoke(image: CachedImage | null): void {
  if (image !== null) {
    URL.revokeObjectURL(image.src);
  }
}

function evict(): void {
  if (cache.size <= LIMIT) {
    return;
  }
  // 只淘汰沒有人在用的：撤銷了正在顯示的 object URL 會直接變成破圖，
  // 而且只在快取剛好滿的時候發生 —— 是最難重現的那種缺陷
  const idle = [...cache.entries()]
    .filter(([, entry]) => entry.users === 0)
    .sort((a, b) => a[1].usedAt - b[1].usedAt);
  for (const [key, entry] of idle) {
    if (cache.size <= LIMIT) {
      break;
    }
    revoke(entry.image);
    cache.delete(key);
  }
}

/**
 * 網址 → SHA 鍵的對照。
 *
 * 雜湊本身不貴，但它是**非同步**的：少了這一層，每次重新掛載都要多等一個
 * microtask 才知道要讀哪一筆，快取就永遠只能在第二次繪製之後才生效 ——
 * 那正是想消掉的那一下閃爍。
 */
const digests = new Map<string, string>();

export function knownDigest(url: string): string | undefined {
  return digests.get(url);
}

export function rememberDigest(url: string, key: string): void {
  digests.set(url, key);
}
