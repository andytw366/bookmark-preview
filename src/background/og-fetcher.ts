import * as coverParams from '@/shared/cover-params';
import { imagesInJsonLd } from '@/shared/json-ld';
import { MIN_COVER_EDGES } from '@/shared/image-structure';
import {
  looksLikeSvg,
  parseSizes,
  SCALABLE_SIZE,
  UNDECLARED_ICON_SIZE,
  UNDECLARED_TOUCH_ICON_SIZE,
  type IconCandidate,
} from '@/shared/site-icon-rank';
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

/** `learn` 見 `noteDeclaredImages`：隱私書籤一律傳 false */
export async function fetchOgThumbnail(pageUrl: string, { learn }: { learn: boolean }): Promise<Thumbnail | null> {
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
  const siteWide = await noteDeclaredImages(pageUrl, declared, { learn });
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
      const thumbnail = await makeCoverThumbnail(image);
      // 純色、平滑漸層、被拉開的裝飾條都不是圖（`shared/image-structure.ts`）。
      // 這條路與分頁擷取那條套同一條線 —— 兩邊不一致的話，「補抓」與「開著頁面抓」
      // 會對同一張圖給出不同答案，而那種差異最難查。
      if (thumbnail.edges < MIN_COVER_EDGES) {
        continue;
      }
      return thumbnail;
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
  return (await fetchHtmlDocument(pageUrl))?.html ?? null;
}

/**
 * 抓頁面 HTML，連同轉址後的最終網址一起回傳。
 *
 * 匯出給 `site-icon.ts`（沒開分頁時解析圖示）：`<link rel="icon">` 的相對路徑要以
 * **最終網址**為基準解析，首頁被轉到語系路徑或子網域時，用書籤網址解析會指錯地方。
 */
export async function fetchHtmlDocument(pageUrl: string): Promise<{ html: string; url: string } | null> {
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
    return { html: await response.text(), url: response.url === '' ? pageUrl : response.url };
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
 * 順序刻意對齊 `cover.ts` 的分數（1050 播放器 poster、1000 宣告層、950 JSON-LD、
 * 900 video poster）—— 兩條路對「哪一張比較可信」的看法本來就該一樣，不一樣的只有
 * 「看得到什麼」。
 *
 * **這裡只做得到宣告層。** `cover.ts` 還有第四層：版面上最像封面的那張圖，依面積與
 * 位置競爭。那需要 `getBoundingClientRect`，沒有渲染就沒有版面 —— 所以補抓對
 * 「什麼都沒宣告、但畫面上有一張大封面」的頁面永遠無能為力，那不是這裡能補的。
 *
 * 取「全部」而不是第一個：全站共用判定需要知道這一頁宣告過哪些圖才能記錄，
 * 而且第一個被降級時要有第二個可以退。順帶修掉一個小缺口 —— 有些站台的
 * `og:image` 是共用 logo 但 `twitter:image` 才是內容圖，只看第一個就永遠拿不到。
 */
function extractImageUrls(html: string, pageUrl: string): string[] {
  const document_ = new DOMParser().parseFromString(html, 'text/html');
  const found: string[] = [];
  const seen = new Set<string>();

  const add = (raw: string | null | undefined): void => {
    if (raw === null || raw === undefined || raw.trim() === '') {
      return;
    }
    try {
      // og:image 常是相對路徑，要以頁面網址為基準解析
      const resolved = new URL(raw.trim(), pageUrl);
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
        return;
      }
      const url = resolved.toString();
      if (!seen.has(url)) {
        seen.add(url);
        found.push(url);
      }
    } catch {
      // 不是網址，跳過
    }
  };

  /*
   * ── 最可信：嵌入式播放器的封面參數 ────────────────────────────
   *
   * 掃的是**整份 HTML 文字**，不是 `iframe[src]` 屬性。實際案例（Vue）那個 iframe
   * 寫的是 `:src="currentEpisode?.url"` —— 框架綁定，屬性上根本沒有網址，等 JS 跑完
   * 才會填。但播放器網址連同 `?poster=` 就序列化在同一份 HTML 的初始資料裡，
   * 只有掃文字看得到。理由與取捨見 `shared/cover-params.ts`。
   */
  for (const url of coverParams.fromText(html)) {
    add(url);
  }

  // ── 宣告層：og:image / twitter:image / image_src ──────────────
  for (const selector of IMAGE_SELECTORS) {
    for (const element of document_.querySelectorAll(selector)) {
      add(element.getAttribute('content') ?? element.getAttribute('href'));
    }
  }

  // ── JSON-LD（schema.org）──────────────────────────────────────
  for (const script of document_.querySelectorAll('script[type="application/ld+json"]')) {
    for (const url of imagesInJsonLd(script.textContent)) {
      add(url);
    }
  }

  // ── <video poster> ───────────────────────────────────────────
  for (const video of document_.querySelectorAll('video[poster]')) {
    add(video.getAttribute('poster'));
  }

  return found;
}

/**
 * 從 HTML 解析網站圖示的宣告：`<link rel="icon">`、`apple-touch-icon` 與 manifest 的網址。
 *
 * 與 `site-icon.ts` 注入分頁的 `collectIconCandidates` 是同一套規則 —— 那支要序列化後
 * 注入頁面，引用不到這裡，只好各寫一份。改一邊要記得改另一邊。
 *
 * `rel~="icon"` 不會配到 `mask-icon`（那是單一個 token），Safari 的單色剪影本來就不要。
 */
export function extractIconUrls(
  html: string,
  pageUrl: string,
): { icons: IconCandidate[]; manifest: string | null } {
  const document_ = new DOMParser().parseFromString(html, 'text/html');
  const resolve = (raw: string | null): string | null => {
    if (raw === null || raw.trim() === '') {
      return null;
    }
    try {
      const url = new URL(raw.trim(), pageUrl);
      return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'data:'
        ? url.toString()
        : null;
    } catch {
      return null;
    }
  };

  const icons: IconCandidate[] = [];
  for (const link of document_.querySelectorAll('link[rel~="icon" i], link[rel~="apple-touch-icon" i]')) {
    const url = resolve(link.getAttribute('href'));
    if (url === null) {
      continue;
    }
    const touch = (link.getAttribute('rel') ?? '').toLowerCase().includes('apple-touch-icon');
    const parsed = parseSizes(link.getAttribute('sizes'));
    const size = looksLikeSvg(url, link.getAttribute('type'))
      ? SCALABLE_SIZE
      : (parsed?.size ?? (touch ? UNDECLARED_TOUCH_ICON_SIZE : UNDECLARED_ICON_SIZE));
    icons.push({ url, size, ...(parsed?.oblong === true ? { oblong: true } : {}) });
  }
  const manifest = resolve(document_.querySelector('link[rel~="manifest" i]')?.getAttribute('href') ?? null);
  return { icons, manifest };
}
