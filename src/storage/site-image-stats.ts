import { normalizeUrl } from '@/shared/url';

/**
 * 記錄各網域宣告過的 og:image，用來認出「全站共用圖」。
 *
 * 很多網站的 og:image 是整站共用的 logo 或預設分享圖，而不是這一頁的內容圖。
 * 那種圖當預覽比網頁截圖還糟 —— 一整排書籤全都是同一個 logo。
 *
 * 判定方式完全不看網域，也不需要維護站台清單：**同一個圖片網址在同一個網域的
 * 兩個以上不同頁面出現過，就判定為全站共用。** 這會隨著使用自動學習，
 * 第一次造訪某站時還無法判斷（那時 og:image 仍照原本的優先序使用），
 * 造訪第二頁之後就會自動降級。
 */
const KEY = 'siteImageStats';
const MAX_HOSTS = 80;
const MAX_IMAGES_PER_HOST = 12;
const PAGES_TO_CONFIRM = 2;

/** host → 圖片網址 → 出現過這張圖的頁面（正規化網址，最多存 PAGES_TO_CONFIRM 筆） */
type Stats = Record<string, Record<string, string[]>>;

async function read(): Promise<Stats> {
  const stored = await browser.storage.local.get(KEY);
  return (stored[KEY] as Stats | undefined) ?? {};
}

async function write(stats: Stats): Promise<void> {
  await browser.storage.local.set({ [KEY]: stats });
}

/**
 * 記錄「這個頁面宣告了這些圖」，並回傳其中已確認是全站共用的那些。
 *
 * 記錄與查詢合併成一個動作，因為呼叫端每次都是先記錄再判斷，
 * 分開兩個函式只會讓呼叫端有機會忘記其中一步。
 *
 * **`learn: false` = 只查不記**，給隱私書籤用：這張表把頁面網址明文存在 `storage.local`，
 * 隱私書籤的網址寫進來就等於從隱私空間漏出去（與 `redirect-map.ts`、`recordCapture`
 * 同一條規則）。刻意做成必填，呼叫端不能靠預設值帶過。
 */
export async function noteDeclaredImages(
  pageUrl: string,
  imageUrls: readonly string[],
  { learn }: { learn: boolean },
): Promise<Set<string>> {
  if (imageUrls.length === 0) {
    return new Set();
  }
  let host: string;
  try {
    host = new URL(pageUrl).host;
  } catch {
    return new Set();
  }

  const stats = await read();
  const forHost = stats[host] ?? {};
  const page = normalizeUrl(pageUrl);
  const siteWide = new Set<string>();

  for (const imageUrl of imageUrls) {
    const pages = [...(forHost[imageUrl] ?? [])];
    if (!pages.includes(page) && pages.length < PAGES_TO_CONFIRM) {
      pages.push(page);
    }
    if (pages.length >= PAGES_TO_CONFIRM) {
      siteWide.add(imageUrl);
    }
    if (learn) {
      forHost[imageUrl] = pages;
    }
  }

  // 隱私書籤：照樣用已學到的結論判斷，但這一頁不准留下來 —— 頁面網址是明文
  if (!learn) {
    return siteWide;
  }
  stats[host] = capImages(forHost, MAX_IMAGES_PER_HOST);
  await write(capKeys(stats, MAX_HOSTS));
  return siteWide;
}

/** 只保留最後加入的 N 筆。物件的鍵順序是插入順序，砍前面的即可。 */
function capKeys<T>(record: Record<string, T>, limit: number): Record<string, T> {
  const keys = Object.keys(record);
  if (keys.length <= limit) {
    return record;
  }
  const kept: Record<string, T> = {};
  for (const key of keys.slice(keys.length - limit)) {
    kept[key] = record[key] as T;
  }
  return kept;
}

/**
 * 同上，但**已確認為全站共用的項目不淘汰**。
 *
 * 不能單純砍最舊的：全站共用圖每一頁都出現，所以它必然是這個網域**最早**
 * 被插入的鍵，砍最舊等於專門砍掉這個機制唯一想記住的結論。而每頁各自不同的
 * 圖（影片封面、商品圖）會不斷插入新鍵，很快就把額度用完 —— 結果是剛學會
 * 「這是 logo」就立刻忘記，永遠學不成。
 *
 * 未確認的項目才依插入順序淘汰：它們若真是全站共用，下次造訪同網域的另一頁
 * 就會再被記錄一次，丟掉的成本只是慢一輪。
 */
function capImages(
  record: Record<string, string[]>,
  limit: number,
): Record<string, string[]> {
  const keys = Object.keys(record);
  if (keys.length <= limit) {
    return record;
  }
  const confirmed = keys.filter((key) => (record[key] as string[]).length >= PAGES_TO_CONFIRM);
  const pending = keys.filter((key) => (record[key] as string[]).length < PAGES_TO_CONFIRM);

  const kept: Record<string, string[]> = {};
  for (const key of confirmed.slice(Math.max(0, confirmed.length - limit))) {
    kept[key] = record[key] as string[];
  }
  const room = limit - Object.keys(kept).length;
  if (room <= 0) {
    return kept;
  }
  for (const key of pending.slice(Math.max(0, pending.length - room))) {
    kept[key] = record[key] as string[];
  }
  return kept;
}

/** 使用者可能想重置學習結果（例如網站改版了）。 */
export async function clearSiteImageStats(): Promise<void> {
  await browser.storage.local.remove(KEY);
}

/**
 * 把這些頁面從學習紀錄裡拿掉（書籤移進隱私空間時）。
 *
 * 只拿掉頁面，不動其他頁面學到的結論；某張圖的頁面拿光了就整筆刪掉，網域空了也刪。
 */
export async function forgetPages(pageUrls: readonly string[]): Promise<void> {
  if (pageUrls.length === 0) {
    return;
  }
  const gone = new Set(pageUrls.map(normalizeUrl));
  const stats = await read();
  let changed = false;
  for (const [host, forHost] of Object.entries(stats)) {
    for (const [imageUrl, pages] of Object.entries(forHost)) {
      const kept = pages.filter((page) => !gone.has(page));
      if (kept.length === pages.length) {
        continue;
      }
      changed = true;
      if (kept.length === 0) {
        delete forHost[imageUrl];
      } else {
        forHost[imageUrl] = kept;
      }
    }
    if (Object.keys(forHost).length === 0) {
      delete stats[host];
    }
  }
  if (changed) {
    await write(stats);
  }
}
