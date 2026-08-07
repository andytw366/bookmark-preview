import { noteDeclaredImages } from '@/storage/site-image-stats';
import { makeCoverThumbnail, type Thumbnail } from './image';

/**
 * 預覽 fallback 的第二層：抓網頁的 og:image / twitter:image。
 *
 * 用於從未造訪過的書籤（沒有截圖可用），以及使用者手動補抓時。
 * 抓不到就回傳 null，交給第三層的網域色卡。
 *
 * **這條路也要套用「全站共用圖」判定。** 之前它是無條件採用第一個 og:image，
 * 於是補抓（`backfill`）與「頁面沒開著時的重新抓」兩條路都繞過了降級 ——
 * 整批補抓完可能一排書籤都是同一個站台 logo，而且因為沒有記錄，
 * 那些頁面對學習毫無貢獻，事後重抓也修不回來。
 */
const TIMEOUT_MS = 8_000;
const MAX_HTML_BYTES = 4_000_000;
const MAX_IMAGE_BYTES = 8_000_000;

export async function fetchOgThumbnail(pageUrl: string): Promise<Thumbnail | null> {
  const html = await fetchHtml(pageUrl);
  if (html === null) {
    return null;
  }
  const declared = extractImageUrls(html, pageUrl);
  if (declared.length === 0) {
    return null;
  }

  // 判定為全站共用的排到最後，但**不移除**：某些頁面真的只有那一張圖可用，
  // 那時 logo 仍勝過完全沒有預覽圖。與分頁擷取那條路的政策一致
  // （`SITE_WIDE_PENALTY` 是降級而非排除）。
  const siteWide = await noteDeclaredImages(pageUrl, declared);
  const ranked = [
    ...declared.filter((url) => !siteWide.has(url)),
    ...declared.filter((url) => siteWide.has(url)),
  ];

  for (const imageUrl of ranked) {
    const image = await fetchImage(imageUrl);
    if (image === null) {
      continue;
    }
    try {
      // og:image 是內容圖而非網頁畫面，維持原始長寬比不裁切
      return await makeCoverThumbnail(image);
    } catch {
      // 這張解碼失敗（可能是 SVG 或壞檔），換下一張
      continue;
    }
  }
  return null;
}

function withTimeout(): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
    },
  };
}

async function fetchHtml(pageUrl: string): Promise<string | null> {
  const { signal, done } = withTimeout();
  try {
    // credentials: 'omit' —— 不要帶著使用者的 cookie 去抓頁面。
    // 這既避免抓到個人化內容，也避免對第三方站台洩漏登入狀態。
    const response = await fetch(pageUrl, { credentials: 'omit', redirect: 'follow', signal });
    if (!response.ok) {
      return null;
    }
    if (!(response.headers.get('content-type') ?? '').includes('text/html')) {
      return null;
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_HTML_BYTES) {
      return null;
    }
    return await response.text();
  } catch {
    return null;
  } finally {
    done();
  }
}

async function fetchImage(imageUrl: string): Promise<Blob | null> {
  const { signal, done } = withTimeout();
  try {
    const response = await fetch(imageUrl, { credentials: 'omit', redirect: 'follow', signal });
    if (!response.ok) {
      return null;
    }
    if (!(response.headers.get('content-type') ?? '').startsWith('image/')) {
      return null;
    }
    const blob = await response.blob();
    return blob.size > MAX_IMAGE_BYTES ? null : blob;
  } catch {
    return null;
  } finally {
    done();
  }
}

const IMAGE_SELECTORS = [
  'meta[property="og:image"]',
  'meta[property="og:image:url"]',
  'meta[property="og:image:secure_url"]',
  'meta[name="twitter:image"]',
  'meta[name="twitter:image:src"]',
  'link[rel="image_src"]',
];

/**
 * 依可信度順序取出所有宣告的預覽圖，去重後回傳。
 *
 * 取「全部」而不是第一個：全站共用判定需要知道這一頁宣告過哪些圖才能記錄，
 * 而且第一個被降級時要有第二個可以退。順帶修掉一個小缺口 —— 有些站台的
 * `og:image` 是共用 logo 但 `twitter:image` 才是內容圖，只看第一個就永遠拿不到。
 */
function extractImageUrls(html: string, pageUrl: string): string[] {
  const document_ = new DOMParser().parseFromString(html, 'text/html');
  const found: string[] = [];
  const seen = new Set<string>();
  for (const selector of IMAGE_SELECTORS) {
    for (const element of document_.querySelectorAll(selector)) {
      const raw = element.getAttribute('content') ?? element.getAttribute('href');
      if (raw === null || raw.trim() === '') {
        continue;
      }
      try {
        // og:image 常是相對路徑，要以頁面網址為基準解析
        const resolved = new URL(raw.trim(), pageUrl);
        if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
          continue;
        }
        const url = resolved.toString();
        if (!seen.has(url)) {
          seen.add(url);
          found.push(url);
        }
      } catch {
        continue;
      }
    }
  }
  return found;
}
