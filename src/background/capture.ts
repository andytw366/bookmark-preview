import { broadcast } from '@/shared/messages';
import type { PreviewSource } from '@/shared/types';
import { hostnameOf, isPreviewableUrl, normalizeUrl, urlKey } from '@/shared/url';
import { recordCapture, type CaptureStage } from '@/storage/diagnostics';
import { getSettings, isBlocked } from '@/storage/settings';
import { getThumb, putThumb } from '@/storage/thumbs-db';
import { getPreviewChoice } from '@/storage/preview-choice';
import { resolveBookmarkForPage } from './bookmark-index';
import { findOpenTabResolving } from './open-tab';
import { noteDeclaredImages } from '@/storage/site-image-stats';
import { coverCandidatesFromTab, DECLARED_THRESHOLD, SITE_WIDE_PENALTY } from './cover';
import { grabCoverThumbnail } from './cover-grab';
import { makeThumbnail, type Thumbnail } from './image';
import { iconThumbnailFromTab, wantsSiteIcon } from './site-icon';
import { t } from '@/shared/i18n';

/**
 * 被動截圖管線：你正常瀏覽到已加入書籤的頁面時，在背景擷取縮圖。
 *
 * 等 1.5 秒才擷取，是為了讓字體與延遲載入的圖片有時間畫上去 ——
 * status 變成 complete 時圖片常常還是空的。
 */
const SETTLE_MS = 1500;
const DAY_MS = 86_400_000;

const pending = new Map<number, ReturnType<typeof setTimeout>>();

export function startCapturePipeline(): void {
  browser.tabs.onUpdated.addListener(handleUpdate);
  browser.tabs.onRemoved.addListener(forget);
  browser.bookmarks.onCreated.addListener(handleBookmarkCreated);
}

/**
 * 剛加入書籤時立刻擷取預覽圖。
 *
 * 只靠 `tabs.onUpdated` 是不夠的：把「正在看的這一頁」加入書籤時不會有任何
 * 分頁事件（頁面早就載入完成了），於是要等到下次再造訪同一頁才會有縮圖 ——
 * 表現成「新加的書籤一直是色卡」。
 *
 * **只在該網址正開著某個分頁時才動作。** 匯入書籤檔或 Firefox Sync 會一次
 * 建立上百筆，那時不該對上百個網域發出請求 —— 那是「補抓預覽圖」按鈕的工作，
 * 使用者要明確知道自己按了它。
 */
/**
 * 短時間內大量建立就視為匯入／同步，整批跳過。
 *
 * 「只在分頁開著時才擷取」那道條件其實已經擋掉大部分匯入情形，但每一筆仍會
 * 跑一次權限檢查、設定讀取、SHA-256 與 IndexedDB 查詢。匯入上千筆時那個累積
 * 足以讓瀏覽器頓一下，而且完全是白做的。
 */
const BULK_WINDOW_MS = 2_000;
const BULK_THRESHOLD = 5;

let recentCreations: number[] = [];

function handleBookmarkCreated(_id: string, node: browser.bookmarks.BookmarkTreeNode): void {
  const now = Date.now();
  recentCreations = recentCreations.filter((at) => now - at < BULK_WINDOW_MS);
  recentCreations.push(now);
  if (recentCreations.length > BULK_THRESHOLD) {
    return;
  }
  void captureForNewBookmark(node);
}

async function captureForNewBookmark(node: browser.bookmarks.BookmarkTreeNode): Promise<void> {
  const url = node.url;
  // 資料夾沒有 url
  if (url === undefined || url === '' || !isPreviewableUrl(url)) {
    return;
  }
  if (!(await hasHostAccess()) || !captureApiAvailable()) {
    return;
  }

  const settings = await getSettings();
  if (!settings.captureEnabled || isBlocked(hostnameOf(url), settings.captureBlocklist)) {
    return;
  }

  const key = await urlKey(url);
  // 已經有縮圖就不動。從隱私空間「移出」也會觸發 onCreated，而那條路已經
  // 把加密縮圖還原成明文了，不該再重抓一次覆蓋掉。
  if ((await getThumb(key)) !== undefined) {
    return;
  }

  // 與右鍵重抓共用同一套「這一頁開著沒」的判斷（含協定差異與已知的轉址目標）——
  // 兩邊各寫一份的話，放寬了一邊、另一邊還是抓不到，症狀完全看不出來
  const target = await findOpenTabResolving(url, true);
  if (target === undefined) {
    await skip('skipped:not-open', url, t('capture_detail_not_open'));
    return;
  }

  // 往下傳分頁停在的那個網址（`target.pageUrl`），鍵用書籤的 —— 理由見 `OpenTab`
  await produceThumbnailNow(target.tabId, target.pageUrl, key, {
    preference: settings.previewSource,
    icon: wantsSiteIcon(settings, url, await getPreviewChoice(url)),
  });
}

function cancel(tabId: number): void {
  const timer = pending.get(tabId);
  if (timer !== undefined) {
    clearTimeout(timer);
    pending.delete(tabId);
  }
}

function handleUpdate(
  tabId: number,
  changeInfo: browser.tabs._OnUpdatedChangeInfo,
  tab: browser.tabs.Tab,
): void {
  if (changeInfo.status === 'loading') {
    // 又開始載入 → 取消前一次排程，避免擷取到已離開的頁面
    cancel(tabId);
    return;
  }
  if (changeInfo.status !== 'complete') {
    return;
  }
  void schedule(tabId, tab);
}

async function skip(stage: CaptureStage, url: string, detail?: string): Promise<void> {
  await recordCapture({ stage, url, at: Date.now(), ...(detail === undefined ? {} : { detail }) });
}

async function schedule(tabId: number, tab: browser.tabs.Tab): Promise<void> {
  const url = tab.url ?? '';

  // 隱私瀏覽視窗絕不擷取 —— 使用者的明確意圖是不留痕跡
  if (tab.incognito) {
    await skip('skipped:private-window', url);
    return;
  }
  // 非作用中分頁可能從未實際繪製過，captureTab 會拿到空白或殘影，
  // 寧可不存也不要存錯的縮圖
  if (tab.active !== true) {
    await skip('skipped:inactive-tab', url);
    return;
  }
  if (url === '' || !isPreviewableUrl(url)) {
    await skip('skipped:unsupported-url', url);
    return;
  }
  if (!(await hasHostAccess())) {
    await skip('skipped:no-permission', url);
    return;
  }
  if (!captureApiAvailable()) {
    await skip('skipped:api-unavailable', url);
    return;
  }

  const settings = await getSettings();
  if (!settings.captureEnabled) {
    await skip('skipped:disabled', url);
    return;
  }
  if (isBlocked(hostnameOf(url), settings.captureBlocklist)) {
    await skip('skipped:blocklisted', url);
    return;
  }
  /*
   * 用**書籤自己的網址**算鍵，不是分頁這個網址。
   *
   * 書籤存 `http://x/`、分頁停在 `https://x/`（或首頁被轉到語系路徑）是很常見的，
   * 而縮圖要能被那個書籤讀到，就必須寫在它的鍵上。配不上時借這個分頁解析一次轉址
   * —— 頁面就在眼前，那是唯一能拿到「帶 cookie 與語系的轉址結果」的地方。
   */
  const match = await resolveBookmarkForPage(url, tabId);
  if (match === null) {
    await skip('skipped:not-bookmarked', url);
    return;
  }

  const key = await urlKey(match.bookmarkUrl);
  const existing = await getThumb(key);
  const maxAge = settings.thumbMaxAgeDays * DAY_MS;
  const choice = await getPreviewChoice(match.bookmarkUrl);
  // 右鍵指定過的圖不讓自動擷取蓋掉。沒有縮圖（被清掉了）時照常抓
  if (choice === 'manual' && existing !== undefined) {
    await skip('skipped:manual', url);
    return;
  }
  // 入口網址看的是**書籤的**網址：分頁可能已被轉到更深的路徑（Drive → /drive/my-drive）
  const icon = wantsSiteIcon(settings, match.bookmarkUrl, choice);
  // 只有「自動產生的」縮圖才會因為過期而重抓。手動補抓的 og 圖不主動覆蓋。
  const autoSource =
    existing?.source === 'capture' || existing?.source === 'cover' || existing?.source === 'icon';
  /*
   * 入口網址的既有縮圖還不是圖示 → 不算「還很新」，這次就換掉。升級後第一次造訪地圖
   * 就會變成圖示，不必等 `thumbMaxAgeDays`。代價：抓不到圖示的入口網址每次造訪都會重跑
   * 整條管線（圖示失敗後照舊寫入封面／截圖，下次又不是 icon），接受。
   */
  // 手動選了「頁面預覽」而手上還是圖示，也一樣換掉。只看手動選擇：設定關掉時不主動換回來
  const staleForIcon =
    existing !== undefined &&
    (icon ? existing.source !== 'icon' : choice === 'page' && existing.source === 'icon');
  if (
    autoSource &&
    !staleForIcon &&
    !justCaptured(tabId, key) &&
    Date.now() - existing.capturedAt < maxAge
  ) {
    await skip('skipped:fresh', url);
    return;
  }

  cancel(tabId);
  remember(tabId, key);
  pending.set(
    tabId,
    setTimeout(() => {
      pending.delete(tabId);
      void produceThumbnailNow(tabId, url, key, { preference: settings.previewSource, icon });
    }, SETTLE_MS),
  );
}

/**
 * 剛才才為這個分頁抓過同一個鍵。
 *
 * 為什麼需要這個例外：**不少站台會先給一頁 JS 檢查或閃屏，再自己導向真正的內容。**
 * 那一頁載入完成得比誰都快，於是抓到的是「瀏覽器安全檢查中…」而不是內容；等真正的
 * 頁面載入完成時，剛才那張截圖已經是「很新的縮圖」，於是 `skipped:fresh` 把它釘住
 * 整整 `thumbMaxAgeDays` 天。實測 eyny 論壇就是這樣（它的檢查頁還會導向同一個網址，
 * 所以連換頁都看不出來）。
 *
 * 判準刻意不去猜「這一頁是不是檢查頁」（那要看內容，而且怎麼猜都會有例外）：
 * 只要「同一個分頁、同一個鍵、剛才才抓過」就允許再抓一次，後到的那張蓋掉先前的。
 * 一次瀏覽最多多抓幾張，而且每一張都覆蓋同一個鍵，不會累積。
 */
const RECAPTURE_WINDOW_MS = 60_000;

const recent = new Map<number, { key: string; at: number }>();

function remember(tabId: number, key: string): void {
  recent.set(tabId, { key, at: Date.now() });
}

function justCaptured(tabId: number, key: string): boolean {
  const last = recent.get(tabId);
  return last !== undefined && last.key === key && Date.now() - last.at < RECAPTURE_WINDOW_MS;
}

/**
 * 分頁關掉了。
 *
 * 與 `cancel` 分開：`cancel` 也用在「又開始載入」那條路上，而**那正是檢查頁導向真正
 * 內容的時候** —— 在那裡把記錄清掉，上面那個例外就永遠不會生效。
 */
function forget(tabId: number): void {
  cancel(tabId);
  recent.delete(tabId);
}

/**
 * 依偏好順序產生縮圖：封面圖優先，或截圖優先。入口網址（`icon`）先試網站圖示，
 * 失敗才走原本的順序。
 *
 * 封面圖之所以值得排在前面：對漫畫、影片、書籍、商品這類「內容頁」，
 * 頁面上的封面遠比一張網頁截圖更能代表這個書籤 —— 截圖裡通常只看到
 * 導覽列與一小塊內容。找不到封面才退回截圖（例如文件站、後台頁面，
 * 那些反而是截圖更有用）。
 */
export async function produceThumbnailNow(
  tabId: number,
  url: string,
  key: string,
  { preference, icon }: { preference: PreviewSource; icon: boolean },
): Promise<boolean> {
  const order: ('icon' | 'cover' | 'capture')[] =
    preference === 'cover-first' ? ['cover', 'capture'] : ['capture', 'cover'];
  if (icon) {
    order.unshift('icon');
  }

  for (const attempt of order) {
    const ok =
      attempt === 'icon'
        ? await tryIcon(tabId, url, key)
        : attempt === 'cover'
          ? await tryCover(tabId, url, key)
          : await tryCapture(tabId, url, key);
    if (ok) {
      return true;
    }
  }
  await skip('error', url, t('capture_detail_no_cover'));
  return false;
}

/**
 * 從已渲染的分頁找出封面並做成縮圖，**只回傳、不寫入**。
 *
 * 抽出來是為了讓隱私書籤也能用同一套判定：它的縮圖必須加密寫入
 * （`storeVaultThumbnail`），不能走下面 `tryCover` 的明文 `putThumb`。
 * 若把這段邏輯複製一份到隱私空間那條路，全站共用圖的降級判定就會分岔。
 *
 * 網址比對用正規化後的形式：`tabs.query` 允許尾端斜線與 fragment 的差異，
 * 嚴格字串比對會讓「書籤存 `https://x.com`、分頁顯示 `https://x.com/`」
 * 這種完全正常的情況被誤判成「使用者已經換頁」。
 */
export async function coverThumbnailFor(
  tabId: number,
  url: string,
  { learn }: { learn: boolean },
): Promise<Thumbnail | null> {
  const fresh = await browser.tabs.get(tabId);
  if (normalizeUrl(fresh.url ?? '') !== normalizeUrl(url)) {
    return null;
  }
  const candidates = await coverCandidatesFromTab(tabId);
  if (candidates.length === 0) {
    return null;
  }

  // 認出「全站共用圖」並降級。很多網站的 og:image 是整站共用的 logo，
  // 那種圖當預覽比截圖還糟 —— 一整排書籤全都是同一個 logo。
  // 判斷方式是同一張圖在同一網域的兩個以上不同頁面出現過，會自動學習。
  const declared = candidates
    .filter((candidate) => candidate.score >= DECLARED_THRESHOLD)
    .map((candidate) => candidate.url);
  const siteWide = await noteDeclaredImages(url, declared, { learn });
  const ranked = candidates
    .map((candidate) =>
      siteWide.has(candidate.url)
        ? { ...candidate, score: candidate.score - SITE_WIDE_PENALTY }
        : candidate,
    )
    .sort((a, b) => b.score - a.score)
    .map((candidate) => candidate.url);

  // 帶著 tabId 進去：候選是從這個分頁的 DOM 讀出來的，而那個分頁也正是取得圖片
  // 位元組的第二條路 —— 防盜連與 Cloudflare 只有在頁面的脈絡裡才穿得過去。
  return grabCoverThumbnail(ranked, tabId);
}

async function tryCover(tabId: number, url: string, key: string): Promise<boolean> {
  try {
    const thumbnail = await coverThumbnailFor(tabId, url, { learn: true });
    if (thumbnail === null) {
      return false;
    }
    await putThumb({
      key,
      ...thumbnail,
      source: 'cover',
      capturedAt: Date.now(),
      encrypted: false,
      iv: null,
    });
    await skip('ok', url);
    broadcast('thumbs/updated', { key });
    return true;
  } catch (cause) {
    console.warn('[bookmark-preview] cover grab failed', url, cause);
    return false;
  }
}

/** 網站圖示沒有「學習」：不碰 `site-image-stats` */
async function tryIcon(tabId: number, url: string, key: string): Promise<boolean> {
  try {
    const thumbnail = await iconThumbnailFromTab(tabId, url);
    if (thumbnail === null) {
      return false;
    }
    await putThumb({
      key,
      ...thumbnail,
      source: 'icon',
      capturedAt: Date.now(),
      encrypted: false,
      iv: null,
    });
    await skip('ok', url);
    broadcast('thumbs/updated', { key });
    return true;
  } catch (cause) {
    console.warn('[bookmark-preview] site icon grab failed', url, cause);
    return false;
  }
}

async function tryCapture(tabId: number, url: string, key: string): Promise<boolean> {
  await capture(tabId, url, key);
  const stored = await getThumb(key);
  return stored?.source === 'capture';
}

/**
 * 截這個分頁的畫面做成縮圖，**只回傳、不寫入**。
 *
 * 與 `coverThumbnailFor` 是一對：兩者都產生位元組而不決定要寫去哪裡，
 * 於是隱私書籤能拿同一份結果走加密寫入（`storeVaultThumbnail`），
 * 明文完全不必落地。
 *
 * **也刻意不記診斷。** `recordCapture` 會把網址明文寫進 `storage.local`，
 * 對隱私書籤來說那等於把藏起來的網址又漏出去一次。要不要記由呼叫端決定 ——
 * 一般書籤那條路（`capture`）記，隱私空間那條不記。
 *
 * 回傳 null 只有一個原因：那個分頁已經不是這個網址、或不是作用中的分頁。
 * 截圖失敗會往上丟。
 */
export async function screenshotThumbnailFor(tabId: number, url: string): Promise<Thumbnail | null> {
  // 等待期間使用者可能已經換頁，確認還在同一個網址才擷取。
  // 比對用正規化後的形式，與 `coverThumbnailFor` 一致 —— 嚴格字串比對會把
  // 「書籤存 https://x.com、分頁顯示 https://x.com/」誤判成使用者換頁了。
  const fresh = await browser.tabs.get(tabId);
  if (
    normalizeUrl(fresh.url ?? '') !== normalizeUrl(url) ||
    fresh.active !== true ||
    fresh.windowId === undefined
  ) {
    return null;
  }
  // captureVisibleTab 而非 captureTab：後者是 Firefox 專屬且在 Firefox 153
  // 已經不存在（型別定義還留著，執行期會丟 "is not a function"）。
  // captureVisibleTab 只能截視窗目前可見的分頁，這正好符合上面
  // 「只截作用中分頁」的設計，沒有功能損失。
  const dataUrl = await browser.tabs.captureVisibleTab(fresh.windowId, {
    format: 'jpeg',
    quality: 90,
  });
  const response = await fetch(dataUrl);
  return makeThumbnail(await response.blob());
}

async function capture(tabId: number, url: string, key: string): Promise<void> {
  try {
    const thumbnail = await screenshotThumbnailFor(tabId, url);
    if (thumbnail === null) {
      await skip('skipped:navigated-away', url);
      return;
    }
    await putThumb({
      key,
      ...thumbnail,
      source: 'capture',
      capturedAt: Date.now(),
      encrypted: false,
      iv: null,
    });
    broadcast('thumbs/updated', { key });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    console.warn('[bookmark-preview] screenshot capture failed', url, cause);
    await skip('error', url, detail);
  }
}

// 擷取與 OG 抓取都需要 host 權限，那是執行期才請求的選用權限。
//
// 用萬用網址樣式而不是 <all_urls>：後者在 Firefox 會被拆成兩個開關，
// 額外要求「存取您電腦上的檔案」（file://）—— 我們不需要為本機檔案截圖。
// （這段用行註解而非區塊註解：樣式字串裡的 star-slash 會提早關閉區塊註解。）
export async function hasHostAccess(): Promise<boolean> {
  return browser.permissions.contains({ origins: ['<all_urls>'] });
}

/**
 * captureVisibleTab 是否真的存在。
 *
 * WebExtension 的 API 表面是依「該 context 建立時已授予的權限」計算的。
 * 背景頁在沒有 host 權限時啟動，captureVisibleTab 根本不會被注入；
 * 事後才授予權限並不會補進已經建立的 API 物件，呼叫會得到
 * 「is not a function」。這不是 API 改名或版本問題。
 */
function captureApiAvailable(): boolean {
  const candidate: unknown = (browser.tabs as { captureVisibleTab?: unknown }).captureVisibleTab;
  return typeof candidate === 'function';
}

function historyApiAvailable(): boolean {
  const candidate: unknown = (browser as { history?: { deleteUrl?: unknown } }).history?.deleteUrl;
  return typeof candidate === 'function';
}

/**
 * 使用者剛授予選用權限後，重啟擴充套件讓對應的 API 進入 API 表面。
 *
 * 用 runtime.reload() 而不是要求使用者自己重新載入：這只會在剛授權的那一次
 * 發生，重啟後條件不再成立，不會形成迴圈。此時側邊欄還沒有值得保留的狀態。
 *
 * 同一個陷阱對 history 權限也成立（授權後 browser.history 仍然不存在），
 * 所以兩者都要檢查。
 */
export function startPermissionWatcher(): void {
  browser.permissions.onAdded.addListener(() => {
    void (async () => {
      const needsCapture = (await hasHostAccess()) && !captureApiAvailable();
      const needsHistory =
        (await browser.permissions.contains({ permissions: ['history'] })) && !historyApiAvailable();
      if (needsCapture || needsHistory) {
        console.info('[bookmark-preview] new permission granted, reloading to enable the feature');
        browser.runtime.reload();
      }
    })();
  });
}
