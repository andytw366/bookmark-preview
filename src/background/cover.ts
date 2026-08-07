/**
 * 從「已渲染的分頁」裡找出這個頁面的內容封面圖。
 *
 * 為什麼不從背景頁重新 fetch 網址再解析 HTML：
 *
 * 1. **前端渲染的站台什麼都拿不到。** 漫畫站、影音站多半是 SPA，
 *    伺服器回的 HTML 裡沒有封面，圖是 JS 跑完才插進 DOM 的。
 * 2. **Cloudflare 之類的防護會擋掉。** 實測某站台對背景頁的 fetch
 *    直接回「Attention Required!」驗證頁，連 HTML 都拿不到。
 *
 * 使用者正在看的那個分頁已經通過驗證、已經跑完 JS，直接從它的 DOM 讀最可靠，
 * 而且不必再發一次頁面請求。
 *
 * 這裡完全沒有站台專屬的邏輯 —— 沒有網域清單、沒有專屬選擇器。
 * 判定依據只有標準規格（Open Graph、Twitter Card、schema.org、video poster）
 * 與一條不看網域的圖片評分啟發式。
 */

/**
 * 這個函式會被序列化後注入頁面執行，所以：
 * 不能引用外部變數、不能用 import、只能用頁面環境有的 API。
 * 分數只能是字面值 —— 抽成常數會在序列化後變成未定義。
 *
 * 分層（高分優先）：
 *   1050  嵌入式播放器 src 裡的封面參數（例如 ?poster=...）
 *   1000  站方宣告的 og:image / twitter:image
 *    950  JSON-LD（schema.org）
 *    900  video poster
 *    500  頁面上最像封面的圖（<img> 與 CSS background-image 同池競爭）
 */
function collectCoverCandidates(): { url: string; score: number }[] {
  const found: { url: string; score: number }[] = [];

  const absolute = (raw: string): string | null => {
    try {
      const resolved = new URL(raw, location.href).toString();
      return /^https?:/.test(resolved) ? resolved : null;
    } catch {
      return null;
    }
  };

  const add = (raw: string | null | undefined, score: number): void => {
    if (raw === null || raw === undefined || raw.trim() === '') {
      return;
    }
    const url = absolute(raw.trim());
    if (url !== null) {
      found.push({ url, score });
    }
  };

  // ── 第一層：站方明確宣告的預覽圖 ──────────────────────────────
  // 這是網站自己說「這張圖代表這一頁」，比任何猜測都可信。
  const declared: [string, number][] = [
    ['meta[property="og:image:secure_url"]', 1000],
    ['meta[property="og:image"]', 1000],
    ['meta[name="twitter:image"]', 990],
    ['meta[name="twitter:image:src"]', 990],
    ['meta[itemprop="image"]', 980],
    ['link[rel="image_src"]', 970],
  ];
  for (const [selector, score] of declared) {
    for (const element of document.querySelectorAll(selector)) {
      add(element.getAttribute('content') ?? element.getAttribute('href'), score);
    }
  }

  // ── 第二層：JSON-LD（schema.org）───────────────────────────────
  // 漫畫站常用 Book / ComicSeries，影音站用 VideoObject / Movie，
  // 電商用 Product。封面通常在 image、thumbnailUrl 或 poster。
  // 結構深度不一，直接遞迴掃比列舉型別穩健。
  const KEYS = ['thumbnailUrl', 'image', 'poster', 'contentUrl'];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 8 || node === null || typeof node !== 'object') {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item, depth + 1);
      }
      return;
    }
    const record = node as Record<string, unknown>;
    for (const key of KEYS) {
      const value = record[key];
      if (typeof value === 'string') {
        add(value, 950);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string') {
            add(item, 950);
          } else if (item !== null && typeof item === 'object') {
            add((item as { url?: string }).url, 950);
          }
        }
      } else if (value !== null && typeof value === 'object') {
        add((value as { url?: string }).url, 950);
      }
    }
    for (const value of Object.values(record)) {
      walk(value, depth + 1);
    }
  };
  for (const element of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      walk(JSON.parse(element.textContent ?? 'null'), 0);
    } catch {
      // 壞掉的 JSON-LD 很常見，忽略就好
    }
  }

  // ── 第零層：嵌入式播放器 src 裡的封面參數 ──────────────────────
  //
  // 嵌入式播放器普遍用 query string 傳封面（?poster= / ?thumbnail= / ?image=），
  // 這比頁面自己的 og:image 更可信：og:image 常是整站共用的分享圖，
  // 而傳給播放器的 poster 必然是「這一頁這支影片」的封面 —— 沒有人會把
  // 站台 logo 當成影片的 poster。所以排在宣告層之上。
  //
  // 只看參數名稱與值的形狀，不看網域。猜錯的成本也很低：
  // 取不下來或解不出圖片，fetchCoverThumbnail 會直接換下一個候選。
  const POSTER_KEYS = ['poster', 'thumbnail', 'thumb', 'image', 'img', 'preview', 'cover'];
  for (const frame of document.querySelectorAll('iframe[src], embed[src]')) {
    const source = frame.getAttribute('src');
    if (source === null) {
      continue;
    }
    let params: URLSearchParams;
    try {
      params = new URL(source, location.href).searchParams;
    } catch {
      continue;
    }
    for (const [key, value] of params) {
      // 值必須是絕對網址；這道檢查同時擋掉 ?image=1 這類同名但無關的參數
      if (POSTER_KEYS.includes(key.toLowerCase()) && /^https?:\/\//i.test(value)) {
        add(value, 1050);
      }
    }
  }

  // ── 第三層：影片封面 ───────────────────────────────────────────
  for (const video of document.querySelectorAll('video[poster]')) {
    add(video.getAttribute('poster'), 900);
  }

  // ── 第四層：什麼都沒宣告時，找頁面上最像封面的圖 ──────────────
  //
  // `<img>` 與 CSS background-image 在**同一個池子裡**依視覺分數競爭，
  // 而不是各自輸出一個扁平分數。原本 <img> 一律 500、背景圖一律 400，
  // 結果是「頁面最頂端、明顯是主體的背景圖」會輸給「捲到一千多像素以下、
  // 推薦列表裡的一張小縮圖」—— 視覺分數算出來了卻沒用在最終排序上。
  //
  // 評分以「使用者實際看到多大」為主（顯示面積），而不是圖檔本身多大 ——
  // 一張 4000px 的圖被縮成 40px 顯示，顯然不是這頁的主體。
  //
  // 三個修正項都不看網域，對任何站台都成立：
  // - 直式加成：書籍與漫畫封面幾乎都是直式
  // - 靠上加成：封面在頁首附近，推薦列表在下面
  // - 全寬懲罰：橫跨整個視窗的圖幾乎都是 hero 或裝飾，不是封面
  const viewportWidth = Math.max(document.documentElement.clientWidth, 1);
  const pageTitle = document.title.toLowerCase();

  const scoreVisual = (
    naturalWidth: number,
    naturalHeight: number,
    rect: DOMRect,
    describedBy: string,
  ): number | null => {
    // 圖示、間隔用的透明圖、追蹤用的 1x1
    if (naturalWidth < 120 || naturalHeight < 120) {
      return null;
    }
    // 實際沒顯示出來（display:none、尺寸為零、或縮得極小）
    if (rect.width < 80 || rect.height < 80) {
      return null;
    }
    // 離頁首太遠的多半是推薦列表或頁尾，不是這一頁的封面
    if (rect.top > 2_000) {
      return null;
    }
    const ratio = naturalWidth / naturalHeight;
    // 橫幅廣告與細長裝飾
    if (ratio > 4 || ratio < 0.25) {
      return null;
    }

    const displayedArea = rect.width * rect.height;
    const portraitBonus = ratio < 0.9 ? 1.4 : 1;
    const positionBonus = 1 / (1 + Math.max(0, rect.top) / 800);
    // 幾乎橫跨整個視窗 → 極可能是 hero 或背景裝飾
    const fullBleedPenalty = rect.width > viewportWidth * 0.9 ? 0.45 : 1;
    // alt / title 與頁面標題有交集 → 很可能就是這個作品的封面
    const described = describedBy.toLowerCase();
    const titleBonus =
      described !== '' && pageTitle !== '' && (pageTitle.includes(described) || described.includes(pageTitle))
        ? 1.3
        : 1;

    return displayedArea * portraitBonus * positionBonus * fullBleedPenalty * titleBonus;
  };

  const pool: { url: string; visual: number }[] = [];

  for (const image of Array.from(document.images)) {
    const source = image.currentSrc === '' ? image.src : image.currentSrc;
    if (source === '') {
      continue;
    }
    const score = scoreVisual(
      image.naturalWidth,
      image.naturalHeight,
      image.getBoundingClientRect(),
      `${image.alt} ${image.title}`,
    );
    if (score !== null) {
      pool.push({ url: source, visual: score });
    }
  }

  // CSS background-image：不少站台把封面放成背景圖，document.images 完全看不到。
  // 只掃視窗上半部的元素，避免走遍整棵 DOM。
  //
  // 背景圖打七折後才進池子：它比 <img> 不可靠 —— 拿不到真實像素尺寸（只能用顯示
  // 尺寸當代理值），而且可能是漸層底紋或裝飾。同尺寸同位置時讓 <img> 勝出，
  // 但差距夠大時（例如頂端的播放器封面 vs 頁面深處的推薦縮圖）背景圖仍能贏。
  for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 100 || rect.top > 1_600) {
      continue;
    }
    const background = getComputedStyle(element).backgroundImage;
    if (background === '' || background === 'none' || !background.includes('url(')) {
      continue;
    }
    const match = /url\((['"]?)(.*?)\1\)/.exec(background);
    const raw = match?.[2];
    if (raw === undefined || raw === '') {
      continue;
    }
    const score = scoreVisual(
      Math.max(120, Math.round(rect.width)),
      Math.max(120, Math.round(rect.height)),
      rect,
      element.getAttribute('aria-label') ?? element.title,
    );
    if (score !== null) {
      pool.push({ url: raw, visual: score * 0.75 });
    }
  }

  // 視覺分數只決定池內順序，不直接當最終分數 —— 它是面積量級的數字，
  // 跟宣告層的 900/1000 不可比。前三名映射到固定的 500/480/460，
  // 讓「宣告層 vs 視覺層」的相對位置保持穩定，例如降級後的全站共用圖
  // （1000 − 600 = 400）仍然墊在所有視覺候選之下。
  const BAND = [500, 480, 460];
  pool.sort((a, b) => b.visual - a.visual);
  const takenVisual = new Set<string>();
  for (const candidate of pool) {
    if (takenVisual.has(candidate.url)) {
      continue;
    }
    const slot = BAND[takenVisual.size];
    if (slot === undefined) {
      break;
    }
    takenVisual.add(candidate.url);
    add(candidate.url, slot);
  }

  found.sort((a, b) => b.score - a.score);

  // 去重並保留前幾名，讓背景頁可以逐一嘗試（第一名可能抓不下來）。
  // 一併帶回分數，背景頁才能判斷哪些屬於「站方宣告」層並在必要時降級。
  const seen = new Set<string>();
  const ordered: { url: string; score: number }[] = [];
  for (const candidate of found) {
    if (!seen.has(candidate.url)) {
      seen.add(candidate.url);
      ordered.push(candidate);
    }
    if (ordered.length >= 6) {
      break;
    }
  }
  return ordered;
}

export interface CoverCandidate {
  url: string;
  score: number;
}

/**
 * 分數在這個門檻以上代表「站方宣告」層
 * （嵌入播放器的 poster 參數、og:image、JSON-LD、video poster）。
 */
export const DECLARED_THRESHOLD = 900;

/**
 * 認定為全站共用圖時要扣掉的分數。
 *
 * 扣完（1000 − 600 = 400）會低於視覺層的三個名次（500 / 480 / 460），
 * 所以順序變成內容圖優先、共用 logo 墊底 —— 但仍保留為候選，
 * 因為某些頁面真的只有那一張圖可用。
 */
export const SITE_WIDE_PENALTY = 600;

const RETRIES = 4;
const RETRY_GAP_MS = 700;

/**
 * 在指定分頁中執行擷取，回傳候選封面網址（依可信度排序）。
 *
 * **會重試幾次。** 延遲載入（`loading="lazy"`、IntersectionObserver）與
 * 前端渲染的站台，在第一次擷取時圖片可能還沒有 naturalWidth，
 * 單次擷取會什麼都找不到。重試比把固定等待時間拉長好 —— 多數頁面第一次就成功，
 * 只有慢的頁面才付出等待成本。
 *
 * **會掃所有 frame。** 嵌入式播放器的 poster 在 iframe 裡，只掃最上層會漏掉。
 * 各 frame 的結果合併，但最上層 frame 的候選優先（那才是這個書籤本身的頁面）。
 *
 * func 需要轉型：型別定義把注入函式宣告成回傳 void，但 executeScript
 * 實際上會把回傳值序列化後放進 result，我們正是靠這個把候選網址帶回來。
 */
export async function coverCandidatesFromTab(tabId: number): Promise<CoverCandidate[]> {
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_GAP_MS));
    }
    const candidates = await runInFrames(tabId);
    if (candidates.length > 0) {
      return candidates;
    }
  }
  return [];
}

async function runInFrames(tabId: number): Promise<CoverCandidate[]> {
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: collectCoverCandidates as unknown as () => void,
    });
    const merged: CoverCandidate[] = [];
    const seen = new Set<string>();
    // results[0] 是最上層 frame。子 frame 的候選一律降一級，
    // 因為那是嵌入內容而不是這個書籤本身的頁面。
    for (const [index, frame] of results.entries()) {
      if (!Array.isArray(frame.result)) {
        continue;
      }
      for (const candidate of frame.result as CoverCandidate[]) {
        if (seen.has(candidate.url)) {
          continue;
        }
        seen.add(candidate.url);
        merged.push(index === 0 ? candidate : { ...candidate, score: candidate.score - 50 });
      }
    }
    merged.sort((a, b) => b.score - a.score);
    return merged;
  } catch {
    // 某些頁面（about:、檢視原始碼、被 CSP 完全封鎖的頁面）無法注入
    return [];
  }
}
