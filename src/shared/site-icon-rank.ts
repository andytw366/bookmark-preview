/**
 * 網站圖示的候選排序。純函式，放在 shared 是為了能在 node 裡測。
 *
 * 來源有三種：`<link rel="icon">`／`apple-touch-icon`、Web App manifest 的 `icons[]`、
 * 瀏覽器給的 `tab.favIconUrl`。全部收成同一個形狀再排：**尺寸大的優先、偏好正方形**。
 * 真正能不能用要等取下來解碼才知道（`site-icon.ts` 逐一試），這裡只決定試的順序。
 */
export interface IconCandidate {
  url: string;
  /** 宣告的最短邊。`any` 或 SVG 當作很大，沒寫就用猜的（見下面各來源） */
  size: number;
  /** 宣告的尺寸不是正方形（例如 `sizes="310x150"`）。圖示格子是正方形，這種排後面 */
  oblong?: boolean;
  /** manifest 的 `purpose: maskable`：四周留了大片安全區、底色鋪滿，比一般圖示差一點 */
  maskable?: boolean;
}

/** `any` 與 SVG 的尺寸。比任何點陣圖都大，但仍是有限數字，排序與相加都安全 */
export const SCALABLE_SIZE = 4096;

/** 沒寫 `sizes` 的 `<link rel="icon">`：多半是 16～32 的 favicon.ico，猜小一點 */
export const UNDECLARED_ICON_SIZE = 32;

/** 沒寫 `sizes` 的 `apple-touch-icon`：規格的預設就是 180 */
export const UNDECLARED_TOUCH_ICON_SIZE = 180;

/**
 * 解析 `sizes` 屬性（`"16x16 32x32"`、`"any"`），回傳最大的那組的最短邊與是否為長方形。
 * 解析不出任何尺寸就回 null，讓呼叫端用自己的猜測值。
 */
export function parseSizes(raw: string | null | undefined): { size: number; oblong: boolean } | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  let best: { size: number; oblong: boolean } | null = null;
  for (const token of raw.trim().toLowerCase().split(/\s+/)) {
    if (token === 'any') {
      return { size: SCALABLE_SIZE, oblong: false };
    }
    const match = /^(\d+)x(\d+)$/.exec(token);
    if (match === null) {
      continue;
    }
    const width = Number(match[1]);
    const height = Number(match[2]);
    const size = Math.min(width, height);
    if (best === null || size > best.size) {
      best = { size, oblong: width !== height };
    }
  }
  return best;
}

/** 從網址或 `type` 屬性看出是不是 SVG */
export function looksLikeSvg(url: string, type?: string | null): boolean {
  if (type !== null && type !== undefined && type.toLowerCase().includes('svg')) {
    return true;
  }
  if (url.startsWith('data:image/svg')) {
    return true;
  }
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.svg');
  } catch {
    return false;
  }
}

/**
 * 從 Web App manifest 的 JSON 取出圖示候選。`src` 相對於 **manifest 自己的網址**解析，
 * 不是頁面網址（規格如此，實際上也常常不同目錄）。
 *
 * `purpose` 只有 `monochrome` 的不要 —— 那是給系統塗色用的單色剪影。
 */
export function iconsFromManifest(json: unknown, manifestUrl: string): IconCandidate[] {
  if (typeof json !== 'object' || json === null) {
    return [];
  }
  const icons = (json as { icons?: unknown }).icons;
  if (!Array.isArray(icons)) {
    return [];
  }
  const found: IconCandidate[] = [];
  for (const icon of icons as unknown[]) {
    if (typeof icon !== 'object' || icon === null) {
      continue;
    }
    const { src, sizes, type, purpose } = icon as Record<string, unknown>;
    if (typeof src !== 'string' || src.trim() === '') {
      continue;
    }
    const purposes = typeof purpose === 'string' ? purpose.toLowerCase().split(/\s+/) : ['any'];
    if (!purposes.includes('any') && !purposes.includes('maskable')) {
      continue;
    }
    let url: string;
    try {
      url = new URL(src.trim(), manifestUrl).toString();
    } catch {
      continue;
    }
    const parsed = parseSizes(typeof sizes === 'string' ? sizes : null);
    const svg = looksLikeSvg(url, typeof type === 'string' ? type : null);
    found.push({
      url,
      size: svg ? SCALABLE_SIZE : (parsed?.size ?? UNDECLARED_ICON_SIZE),
      ...(parsed?.oblong === true ? { oblong: true } : {}),
      ...(!purposes.includes('any') ? { maskable: true } : {}),
    });
  }
  return found;
}

/**
 * 沒宣告也常常存在的 iOS 慣例路徑。iOS 會自己去網站根目錄找這兩個檔，所以很多站台放了卻沒寫
 * `<link>`：Twitch 只宣告 16／32px，根目錄卻有 180px 的；Google 學術只有 favicon.ico，根目錄有 120px 的。
 *
 * 尺寸猜 120（不是規格預設的 180）：老站台放的常是 57／72px。猜的只影響試的順序，
 * 真正的大小由 `site-icon.ts` 解碼後比較。
 */
export const CONVENTIONAL_TOUCH_ICON_SIZE = 120;

export function conventionalTouchIcons(pageUrl: string): IconCandidate[] {
  try {
    const origin = new URL(pageUrl).origin;
    if (!/^https?:/.test(origin)) {
      return [];
    }
    return ['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png'].map((path) => ({
      url: `${origin}${path}`,
      size: CONVENTIONAL_TOUCH_ICON_SIZE,
    }));
  } catch {
    return [];
  }
}

/** 只收網頁協定與 `data:`（`tab.favIconUrl` 常是 data:） */
function usable(url: string): boolean {
  return /^(https?:|data:image\/)/i.test(url);
}

/**
 * 去重、排序。長方形與 maskable 的有效尺寸打對折 —— 仍然是候選，只是同級時排後面。
 */
export function rankIconCandidates(candidates: readonly IconCandidate[]): string[] {
  const score = (candidate: IconCandidate): number =>
    candidate.size * (candidate.oblong === true ? 0.5 : 1) * (candidate.maskable === true ? 0.5 : 1);
  const best = new Map<string, number>();
  for (const candidate of candidates) {
    if (!usable(candidate.url)) {
      continue;
    }
    best.set(candidate.url, Math.max(best.get(candidate.url) ?? 0, score(candidate)));
  }
  // Map 保留插入順序，sort 是穩定的：同分時照來源順序（頁面宣告的在前）
  return [...best.entries()].sort((a, b) => b[1] - a[1]).map(([url]) => url);
}
