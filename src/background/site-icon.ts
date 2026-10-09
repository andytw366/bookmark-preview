import {
  conventionalTouchIcons,
  iconsFromManifest,
  rankIconCandidates,
  UNDECLARED_ICON_SIZE,
  type IconCandidate,
} from '@/shared/site-icon-rank';
import type { PreviewChoice, Settings } from '@/shared/types';
import { isEntryUrl, normalizeUrl } from '@/shared/url';
import { t } from '@/shared/i18n';
import { fetchImageBlob, fetchImageBlobInPage, injectWithArgs } from './image-grab';
import { type Thumbnail } from './image';
import { extractIconUrls, fetchHtmlDocument } from './og-fetcher';

/**
 * 網站圖示：書籤指的是「一個網站／App」（`isEntryUrl`）時，預覽用這個，不是截圖或分享圖。
 *
 * **為什麼要自己抓。** Firefox 自己的圖示存在 `favicons.sqlite`，擴充套件讀不到：
 * `bookmarks` API 不給圖示，唯一拿得到的是開著的分頁的 `tab.favIconUrl`（常是 16px）。
 *
 * **不用第三方圖示服務**（Google `s2/favicons`、DuckDuckGo icons）：那會把每個書籤的網域
 * 送給第三方，違反隱私政策。這裡的請求全都打向書籤自己的網站，性質與 og:image 一樣。
 *
 * 兩個入口，都**只回傳 `Thumbnail`、不寫入**（與 `coverThumbnailFor` 同一個形狀），
 * 隱私書籤才能拿去加密寫入：
 * - `iconThumbnailFromTab`：分頁開著，從 DOM 讀宣告。
 * - `fetchIconThumbnail`：沒開分頁（補抓、沒開分頁時的重抓），抓 HTML 解析。
 *
 * **不套 `MIN_COVER_EDGES`**：單色的圖示（例如黑底白字）邊緣分數可能過不了封面的門檻，
 * 而它就是對的答案。只要求能解碼、最短邊至少 16px。
 */

/**
 * 這個書籤要不要先試網站圖示。**傳書籤自己的網址**（理由見 `isEntryUrl`）。
 *
 * 決定順序：手動選擇（列選單「改用網站圖示／改用頁面預覽」）> 設定與入口規則。
 * `manual`（右鍵指定過圖）不表態，照規則。
 *
 * 每一條寫縮圖的路都經過這裡，漏一條就會「這裡有圖示、那裡沒有」。
 */
export function wantsSiteIcon(
  settings: Pick<Settings, 'entryIcons'>,
  bookmarkUrl: string,
  choice?: PreviewChoice,
): boolean {
  if (choice === 'icon' || choice === 'page') {
    return choice === 'icon';
  }
  return settings.entryIcons && isEntryUrl(bookmarkUrl);
}

/** 存檔時最長邊的上限。顯示最大 48px，留 2× 以上給高 DPI */
const ICON_MAX = 256;
const MIN_ICON_SIDE = 16;
/** 最多試幾個候選。全部失敗的站台不該拖著對外發一長串請求 */
const MAX_ATTEMPTS = 8;
/** 解出來最短邊到這個大小就夠用了，不再往下試（顯示最大約 80 CSS px，高 DPI 下 160） */
const GOOD_ENOUGH_SIDE = 128;
const MANIFEST_TIMEOUT_MS = 8_000;
const MAX_MANIFEST_BYTES = 500_000;

interface PageIconDeclarations {
  icons: IconCandidate[];
  manifest: string | null;
}

/**
 * 注入頁面執行（只跑最上層 frame —— 嵌入內容的圖示不是這個網站的）。
 *
 * 與 `og-fetcher.ts` 的 `extractIconUrls` 是同一套規則。這支會被序列化，
 * 不能引用外部常數，所以 4096／180／32 只能寫成字面值（意思見 `shared/site-icon-rank.ts`）。
 */
function collectIconCandidates(): PageIconDeclarations {
  const resolve = (raw: string | null): string | null => {
    if (raw === null || raw.trim() === '') {
      return null;
    }
    try {
      const url = new URL(raw.trim(), document.baseURI);
      return /^(https?|data):$/.test(url.protocol) ? url.toString() : null;
    } catch {
      return null;
    }
  };
  const icons: { url: string; size: number; oblong?: boolean }[] = [];
  for (const link of document.querySelectorAll('link[rel~="icon" i], link[rel~="apple-touch-icon" i]')) {
    const url = resolve(link.getAttribute('href'));
    if (url === null) {
      continue;
    }
    const touch = (link.getAttribute('rel') ?? '').toLowerCase().includes('apple-touch-icon');
    const type = (link.getAttribute('type') ?? '').toLowerCase();
    const svg = type.includes('svg') || /\.svg($|[?#])/i.test(url) || url.startsWith('data:image/svg');
    // 宣告了就取最大那組的最短邊；沒宣告用猜的（apple-touch-icon 規格預設 180）
    let declaredSize = 0;
    let oblong = false;
    let any = false;
    for (const token of (link.getAttribute('sizes') ?? '').trim().toLowerCase().split(/\s+/)) {
      const match = /^(\d+)x(\d+)$/.exec(token);
      if (token === 'any') {
        any = true;
      } else if (match !== null && Math.min(Number(match[1]), Number(match[2])) > declaredSize) {
        declaredSize = Math.min(Number(match[1]), Number(match[2]));
        oblong = match[1] !== match[2];
      }
    }
    const size = svg || any ? 4096 : declaredSize > 0 ? declaredSize : touch ? 180 : 32;
    icons.push({ url, size, ...(oblong ? { oblong: true } : {}) });
  }
  const manifest = resolve(document.querySelector('link[rel~="manifest" i]')?.getAttribute('href') ?? null);
  return { icons, manifest };
}

/** 注入頁面：在頁面的脈絡裡抓 manifest（帶它自己的 cookie 與 CORS 設定） */
function fetchTextInPage(url: string): Promise<string | null> {
  return fetch(url, { credentials: 'include' })
    .then((response) => (response.ok ? response.text() : null))
    .catch(() => null);
}

/** 分頁開著時：從已渲染的 DOM 讀宣告，加上瀏覽器自己給的 `favIconUrl` */
export async function iconThumbnailFromTab(tabId: number, url: string): Promise<Thumbnail | null> {
  const tab = await browser.tabs.get(tabId);
  if (normalizeUrl(tab.url ?? '') !== normalizeUrl(url)) {
    return null;
  }
  let declared: PageIconDeclarations = { icons: [], manifest: null };
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: collectIconCandidates as unknown as () => void,
    });
    const result = results[0]?.result as PageIconDeclarations | undefined;
    if (result !== undefined && Array.isArray(result.icons)) {
      declared = result;
    }
  } catch {
    // 注入不了的頁面（CSP 完全封鎖等）還有 favIconUrl 可以試
  }

  const candidates = [...declared.icons];
  if (declared.manifest !== null) {
    candidates.push(...(await manifestIcons(declared.manifest, { tabId, credentials: 'include' })));
  }
  if (tab.favIconUrl !== undefined && tab.favIconUrl !== '') {
    candidates.push({ url: tab.favIconUrl, size: UNDECLARED_ICON_SIZE });
  }
  candidates.push(...conventionalTouchIcons(url));

  return bestDecodable(rankIconCandidates(candidates), async (iconUrl) => {
    const direct = await fetchImageBlob(iconUrl);
    if (direct !== null || iconUrl.startsWith('data:')) {
      return direct;
    }
    // 防盜連、需要頁面 cookie 的：在頁面裡抓（與封面同一個階梯，但不截畫面）
    return fetchImageBlobInPage(tabId, iconUrl);
  });
}

/**
 * 沒開分頁時：抓 HTML 解析宣告；什麼都沒有（或 HTML 拿不到）就試 `/favicon.ico`。
 *
 * 一律 `credentials: 'omit'`，與 `og-fetcher.ts` 抓頁面同一個政策。
 */
export async function fetchIconThumbnail(pageUrl: string): Promise<Thumbnail | null> {
  const page = await fetchHtmlDocument(pageUrl);
  const candidates: IconCandidate[] = [];
  let base = pageUrl;
  if (page !== null) {
    base = page.url;
    const declared = extractIconUrls(page.html, page.url);
    candidates.push(...declared.icons);
    if (declared.manifest !== null) {
      candidates.push(...(await manifestIcons(declared.manifest, { credentials: 'omit' })));
    }
  }
  candidates.push(...conventionalTouchIcons(base));
  const ranked = rankIconCandidates(candidates);
  try {
    // 墊底：沒宣告的站台多半還是有這個檔案。已經在清單裡就不重複
    const fallback = new URL('/favicon.ico', base).toString();
    if (!ranked.includes(fallback)) {
      ranked.push(fallback);
    }
  } catch {
    // base 不是網址，什麼都不必試了
  }
  return bestDecodable(ranked, (iconUrl) => fetchImageBlob(iconUrl, { credentials: 'omit' }));
}

/**
 * 依序取下來解碼，留下**最大的**那張；解到夠大（`GOOD_ENOUGH_SIDE`）就提早停。
 *
 * 不是「第一張能解碼的就用」：排序靠的是宣告或猜測的尺寸，而那常常不準 —— 沒寫 `sizes`
 * 的 `<link rel="icon">` 可能是 16px，猜 120 的慣例路徑可能是 57px。第一張就停的話，
 * 排在前面的小圖會擋掉後面真正大的那張，放大顯示就是糊的。
 */
async function bestDecodable(
  urls: readonly string[],
  fetchBlob: (url: string) => Promise<Blob | null>,
): Promise<Thumbnail | null> {
  let best: Thumbnail | null = null;
  for (const url of urls.slice(0, MAX_ATTEMPTS)) {
    const blob = await fetchBlob(url);
    if (blob === null) {
      continue;
    }
    const thumbnail = await decodeIcon(blob);
    if (thumbnail === null) {
      continue;
    }
    const side = Math.min(thumbnail.width, thumbnail.height);
    if (best === null || side > Math.min(best.width, best.height)) {
      best = thumbnail;
    }
    if (side >= GOOD_ENOUGH_SIDE) {
      break;
    }
  }
  return best;
}

/**
 * 抓 manifest 取 `icons[]`。先在背景頁抓；失敗而且有分頁時，改在頁面裡抓 ——
 * 例如 Google 地圖的 manifest 是 `crossorigin="use-credentials"`，要帶頁面的 cookie。
 */
async function manifestIcons(
  manifestUrl: string,
  { tabId, credentials }: { tabId?: number; credentials: RequestCredentials },
): Promise<IconCandidate[]> {
  let text = await fetchManifestText(manifestUrl, credentials);
  if (text === null && tabId !== undefined) {
    try {
      const inPage = await injectWithArgs<string | null>(tabId, fetchTextInPage as never, [manifestUrl]);
      text = typeof inPage === 'string' ? inPage : null;
    } catch {
      text = null;
    }
  }
  if (text === null || text.length > MAX_MANIFEST_BYTES) {
    return [];
  }
  try {
    return iconsFromManifest(JSON.parse(text) as unknown, manifestUrl);
  } catch {
    return [];
  }
}

async function fetchManifestText(url: string, credentials: RequestCredentials): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, MANIFEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { credentials, redirect: 'follow', signal: controller.signal });
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── 解碼 ──────────────────────────────────────────────────────────────

/**
 * 解成圖示縮圖：保持原比例、只縮不放、最長邊 256px，**保留透明**。
 *
 * 不用 `makeCoverThumbnail`：它的編碼在不支援 WebP 時退 JPEG，透明會變黑底；
 * 而且它解不了 SVG。
 */
async function decodeIcon(blob: Blob): Promise<Thumbnail | null> {
  let source: { image: CanvasImageSource; width: number; height: number; release: () => void } | null;
  try {
    source = (await isSvg(blob)) ? await rasterizeSvg(blob) : await bitmapSource(blob);
  } catch {
    return null;
  }
  if (source === null) {
    return null;
  }
  try {
    if (Math.min(source.width, source.height) < MIN_ICON_SIDE) {
      return null;
    }
    const scale = Math.min(ICON_MAX / source.width, ICON_MAX / source.height, 1);
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (context === null) {
      throw new Error(t('image_no_2d_context'));
    }
    // 512 的 manifest 圖示一步縮到 256：預設的平滑品質會讓細線發毛
    context.imageSmoothingQuality = 'high';
    context.drawImage(source.image, 0, 0, width, height);
    const encoded = await encodeWithAlpha(canvas);
    return { bytes: await encoded.arrayBuffer(), mime: encoded.type, width, height };
  } catch {
    return null;
  } finally {
    source.release();
  }
}

async function bitmapSource(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  return {
    image: bitmap,
    width: bitmap.width,
    height: bitmap.height,
    release: () => {
      bitmap.close();
    },
  };
}

async function isSvg(blob: Blob): Promise<boolean> {
  if (blob.type.includes('svg')) {
    return true;
  }
  // 不少伺服器對 .svg 回 text/plain 或 octet-stream，看開頭
  return /<svg[\s>]/i.test(await blob.slice(0, 1024).text());
}

/**
 * SVG 要經過 `<img>` 畫上 canvas：背景頁的 `createImageBitmap` 解不了 SVG blob。
 *
 * **根元素沒寫 `width`/`height` 時 Firefox 會畫成 0×0**，所以一律改寫成
 * 以 viewBox 比例算出、最長邊 256 的尺寸 —— 順便讓向量圖以存檔尺寸點陣化，不必再縮。
 */
async function rasterizeSvg(blob: Blob) {
  const parsed = new DOMParser().parseFromString(await blob.text(), 'image/svg+xml');
  const root = parsed.documentElement;
  if (root.localName !== 'svg') {
    return null;
  }
  const viewBox = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  let ratio = 1;
  if (viewBox.length === 4 && viewBox[2]! > 0 && viewBox[3]! > 0) {
    ratio = viewBox[2]! / viewBox[3]!;
  } else {
    const width = parseFloat(root.getAttribute('width') ?? '');
    const height = parseFloat(root.getAttribute('height') ?? '');
    if (width > 0 && height > 0) {
      ratio = width / height;
      // 只有寬高沒有 viewBox 時，改寫寬高會裁切而不是縮放，補一個 viewBox
      root.setAttribute('viewBox', `0 0 ${String(width)} ${String(height)}`);
    }
  }
  const width = Math.round(ratio >= 1 ? ICON_MAX : ICON_MAX * ratio);
  const height = Math.round(ratio >= 1 ? ICON_MAX / ratio : ICON_MAX);
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));

  const objectUrl = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(parsed)], { type: 'image/svg+xml' }),
  );
  const release = () => {
    URL.revokeObjectURL(objectUrl);
  };
  try {
    const image = new Image(width, height);
    image.src = objectUrl;
    await image.decode();
    return { image, width, height, release };
  } catch (cause) {
    release();
    throw cause;
  }
}

/**
 * 一律 PNG：無損、有 alpha。
 *
 * 原本是有損 WebP（quality 0.9），但圖示全是銳利的邊與細字，有損壓縮在那些邊上留下的雜訊
 * 放大顯示時很明顯 —— 這是「解析度很差」的原因之一。最長邊 256 的 PNG 通常只有幾十 KB。
 * 不用 JPEG：透明會變黑底。
 */
async function encodeWithAlpha(canvas: OffscreenCanvas): Promise<Blob> {
  return canvas.convertToBlob({ type: 'image/png' });
}
