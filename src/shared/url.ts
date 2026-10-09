/** 不應該出現在預覽牆裡的書籤協定。 */
const EXCLUDED_PROTOCOLS = new Set([
  'place:', // Firefox 智慧書籤（例如工具列上的「最近的標籤」查詢）
  'javascript:', // bookmarklet
  'data:',
  'about:',
  'chrome:',
  'resource:',
  'moz-extension:',
]);

/** 這個網址是否值得放進預覽牆（也決定 M1 要不要為它抓縮圖）。 */
export function isPreviewableUrl(raw: string): boolean {
  try {
    return !EXCLUDED_PROTOCOLS.has(new URL(raw).protocol);
  } catch {
    return false;
  }
}

/** 取得可顯示的主機名稱，失敗時回傳原字串，不拋錯。 */
export function hostnameOf(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./, '');
  } catch {
    return raw;
  }
}

/**
 * 由字串推出穩定的色相。
 * 這是規劃文件裡預覽 fallback 的第三層（favicon + 網域色卡）：
 * 同一個網域永遠得到同一個顏色，讓清單在沒有縮圖時仍可辨識。
 */
export function hueFromString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) % 360;
  }
  return hash;
}

/**
 * 網址正規化，用於縮圖快取的鍵以及「這個頁面有沒有被加入書籤」的比對。
 *
 * 去掉 fragment 並拿掉尾端斜線，是因為書籤存的可能是
 * `https://example.com` 而實際造訪的是 `https://example.com/` ——
 * 不正規化的話這兩者會被當成不同頁面，縮圖永遠對不上。
 */
export function normalizeUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    const text = parsed.toString();
    return text.endsWith('/') ? text.slice(0, -1) : text;
  } catch {
    return raw;
  }
}

/**
 * 這個書籤指的是「一個網站／App」而不是「一則內容」嗎？
 *
 * 判準只看網址的形狀、不看網域：**路徑最多一層、而且沒有 query**。
 * `google.com/maps`、`drive.google.com`、`twitch.tv` 是；`youtube.com/watch?v=…`、
 * `github.com/u/repo` 不是。`x.com/某人` 這種一層的個人頁也會被當成入口 —— 使用者接受這個誤判。
 *
 * **一律傳書籤自己的網址**，不是分頁停在的網址：Drive 會轉到 `/drive/my-drive`，那是兩層。
 *
 * 考慮過、放棄的訊號：「有 Web App manifest」。YouTube、Twitch 首頁沒有，MDN、GitHub 的內容頁反而有。
 */
export function isEntryUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    return parsed.pathname.split('/').filter(Boolean).length <= 1 && parsed.search === '';
  } catch {
    return false;
  }
}

/**
 * 兩個網址指的是不是同一個頁面。
 *
 * 「同一頁」的判準與縮圖鍵一致（`normalizeUrl`）：忽略 fragment 與尾端斜線，
 * 主機名不分大小寫。書籤存 `https://x.com`、分頁顯示 `https://x.com/` 是完全
 * 正常的情況，嚴格字串比對會把它誤判成兩個不同的頁面。
 *
 * **要找「這個網址現在有沒有開著」時，用這個配 `tabs.query({})` 自己比對，
 * 不要用 `tabs.query({ url })`。** match pattern 有兩個硬性限制會讓後者對很常見
 * 的網址直接丟 `Invalid url pattern`：主機不能帶連接埠（`http://127.0.0.1:8899/`
 * 就不合法），而且一定要有路徑（所以不能把首頁的尾端斜線拿掉）。兩者都踩過。
 */
export function isSamePage(a: string, b: string): boolean {
  return normalizeUrl(a) === normalizeUrl(b);
}

/**
 * 隱私書籤縮圖的鍵。
 *
 * 放在 shared 而不是背景頁，因為兩端都要用：背景頁寫入與廣播用它，
 * 側邊欄的 `VaultThumb` 要用它比對「這則更新是不是我的」。
 * 兩邊各自寫死 `vault:` 前綴的話，改動時會有一邊靜默失效。
 */
export const VAULT_THUMB_PREFIX = 'vault:';

export function vaultThumbKey(id: string): string {
  return `${VAULT_THUMB_PREFIX}${id}`;
}

/** 縮圖快取的鍵：正規化網址的 SHA-256 十六進位字串。 */
export async function urlKey(raw: string): Promise<string> {
  const data = new TextEncoder().encode(normalizeUrl(raw));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 網域首字，用於色卡上的字母。 */
export function initialOf(hostname: string): string {
  const first = hostname.replace(/^[^a-z0-9]+/i, '').charAt(0);
  return (first || '?').toUpperCase();
}
