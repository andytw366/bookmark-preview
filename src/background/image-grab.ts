import { makeCoverThumbnail, type Thumbnail } from './image';

/**
 * 想辦法把「使用者在頁面上看到的那張圖」變成縮圖。
 *
 * 只用背景頁 fetch 是不夠的，實務上會被三種情況打敗：
 *
 * 1. **防盜連。** 擴充套件無法自行設定跨來源的 Referer（fetch 的 referrer 選項
 *    會被瀏覽器丟掉），所以檢查 Referer 的 CDN 會回 403。
 * 2. **需要 cookie 的圖。** session 綁定的圖片在沒有憑證時取不到。
 * 3. **奇怪的 content-type。** 不少 CDN 對圖片回 application/octet-stream。
 *
 * 所以改成依序嘗試三種策略，第一個成功的就用，並回報是哪一種成功
 * （失敗時才知道該往哪裡查）：
 *
 * 1. 背景頁 fetch（帶 cookie、不看 content-type）
 * 2. 在頁面裡 fetch（自動帶正確的 Referer 與 cookie，受 CORS 限制）
 * 3. 從畫面截圖裁下該圖片的範圍 —— 圖就在螢幕上，完全不需要網路請求，
 *    因此不受防盜連、CORS、憑證任何限制。畫質受限於顯示尺寸，
 *    但對「手動指定這張圖當預覽」完全夠用。
 */
export type GrabStrategy = 'fetch' | 'page-fetch' | 'screenshot';

export interface GrabResult {
  thumbnail: Thumbnail;
  strategy: GrabStrategy;
}

export interface GrabOptions {
  /**
   * 低於這個邊緣比例就當成「這不是圖」而換下一個候選（見
   * `shared/image-structure.ts`）。預設 0 ＝不判斷。
   *
   * **手動指定的圖不要設它。** 使用者對著一張圖右鍵說「就用這張」，程式沒有立場
   * 否決 —— 他可能真的想用一張純色圖當標記。這條線是給自動判定的。
   */
  minEdges?: number;
  /**
   * 允許第三段（畫面裁切）。預設允許。
   *
   * **自動判定那條路要關掉它**：裁切前得先 `scrollIntoView` 把那張圖捲進可見範圍，
   * 而自動擷取是使用者只是造訪了一個已加入書籤的頁面就會跑的 —— 頁面自己跳動一下
   * 完全沒道理，那是右鍵手動指定（使用者主動要這張圖）才付得起的代價。
   *
   * 對自動那條路也沒什麼損失：封面全部失敗時，管線本來就會退回整頁截圖。
   */
  allowScreenshot?: boolean;
}

const TIMEOUT_MS = 12_000;
const MAX_IMAGE_BYTES = 12_000_000;

/**
 * 注入一個帶參數的函式並取回它的回傳值。
 *
 * 型別定義把 func 宣告成無參數且回傳 void，所以 args 與回傳值都得繞過型別。
 * 集中在這裡轉型一次，比在每個呼叫點各灑一次乾淨。
 */
async function injectWithArgs<T>(
  tabId: number,
  func: (...args: never[]) => unknown,
  args: unknown[],
): Promise<T | undefined> {
  const inject = browser.scripting.executeScript as unknown as (
    options: { target: { tabId: number }; func: unknown; args: unknown[] },
  ) => Promise<{ result?: unknown }[]>;
  const results = await inject({ target: { tabId }, func, args });
  return results[0]?.result as T | undefined;
}

export async function grabImage(
  tabId: number | undefined,
  imageUrl: string,
  { allowScreenshot = true, minEdges = 0 }: GrabOptions = {},
): Promise<GrabResult | null> {
  const direct = await tryDirectFetch(imageUrl, minEdges);
  if (direct !== null) {
    return { thumbnail: direct, strategy: 'fetch' };
  }
  if (tabId === undefined) {
    return null;
  }
  const viaPage = await tryPageFetch(tabId, imageUrl, minEdges);
  if (viaPage !== null) {
    return { thumbnail: viaPage, strategy: 'page-fetch' };
  }
  if (!allowScreenshot) {
    return null;
  }
  /*
   * 畫面裁切**不套邊緣門檻**：走到這一段時前面兩段都失敗了，而它裁下來的就是
   * 使用者眼前那塊畫面。這時候再挑三揀四只會變成「什麼都拿不到」。
   */
  const viaScreen = await tryScreenshotCrop(tabId, imageUrl);
  if (viaScreen !== null) {
    return { thumbnail: viaScreen, strategy: 'screenshot' };
  }
  return null;
}

async function decode(blob: Blob, minEdges = 0): Promise<Thumbnail | null> {
  if (blob.size === 0 || blob.size > MAX_IMAGE_BYTES) {
    return null;
  }
  try {
    const thumbnail = await makeCoverThumbnail(blob);
    // 純色、平滑漸層、被拉開的裝飾條 —— 換下一個候選（`shared/image-structure.ts`）
    return thumbnail.edges < minEdges ? null : thumbnail;
  } catch {
    return null;
  }
}

async function tryDirectFetch(imageUrl: string, minEdges = 0): Promise<Thumbnail | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);
  try {
    // credentials: 'include' —— 有些圖片綁 session。這是使用者主動指定的圖片，
    // 帶上該站台自己的 cookie 是合理的（而且不會外流給第三方）。
    // 刻意不檢查 content-type：真正的判斷標準是「能不能解碼成圖片」。
    const response = await fetch(imageUrl, {
      credentials: 'include',
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return await decode(await response.blob(), minEdges);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 在頁面裡抓，回傳 `data:` URL。頁面的請求會自動帶對的 Referer 與 cookie。
 *
 * **不要在這裡自己把位元組轉成 base64。** 這段程式是被注入到頁面裡跑的，而
 * `String.fromCharCode(...bytes.subarray(...))` 這種展開跨不過 Xray 邊界 ——
 * 展開需要取得迭代器，Firefox 的安全包裝會丟
 * `Permission denied to access property "constructor"`。
 *
 * 原本就是這樣寫的，於是第二段策略**從來沒有真正成功過**：請求送出去了、伺服器
 * 也回 200，位元組卻在轉換那一步死掉，而 `catch` 把它變成安靜的 null。從外面看
 * 只知道「手動指定會拿到畫面裁切的結果」，看不出中間那段根本沒運作 ——
 * 當初驗證階段 2 時只看伺服器的請求記錄，那還不足以證明位元組回到了背景頁。
 *
 * 交給 `FileReader` 讓瀏覽器自己編碼：完全不必碰位元組，也就沒有邊界問題。
 */
function fetchInPage(url: string): Promise<string | null> {
  return fetch(url, { credentials: 'include' })
    .then(async (response) => {
      if (!response.ok) {
        return null;
      }
      const blob = await response.blob();
      if (blob.size === 0 || blob.size > 12_000_000) {
        return null;
      }
      return await new Promise<string | null>((done) => {
        const reader = new FileReader();
        reader.onload = () => {
          done(typeof reader.result === 'string' ? reader.result : null);
        };
        reader.onerror = () => {
          done(null);
        };
        reader.readAsDataURL(blob);
      });
    })
    .catch(() => null);
}

async function tryPageFetch(tabId: number, imageUrl: string, minEdges = 0): Promise<Thumbnail | null> {
  try {
    const dataUrl = await injectWithArgs<string>(tabId, fetchInPage as never, [imageUrl]);
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
      return null;
    }
    // data: URL 不走網路，這個 fetch 只是把它變回位元組（截圖那一段也是這樣做的）
    return await decode(await (await fetch(dataUrl)).blob(), minEdges);
  } catch {
    return null;
  }
}

interface ImageRect {
  x: number;
  y: number;
  width: number;
  height: number;
  ratio: number;
}

/** 找出畫面上那張圖的位置，並先捲動到可見範圍。 */
function locateImageInPage(url: string): ImageRect | null {
  const match = Array.from(document.images).find(
    (image) => image.currentSrc === url || image.src === url,
  );
  if (match === undefined) {
    return null;
  }
  match.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = match.getBoundingClientRect();
  if (rect.width < 16 || rect.height < 16) {
    return null;
  }
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    ratio: window.devicePixelRatio,
  };
}

async function tryScreenshotCrop(tabId: number, imageUrl: string): Promise<Thumbnail | null> {
  try {
    const rect = await injectWithArgs<ImageRect | null>(tabId, locateImageInPage as never, [
      imageUrl,
    ]);
    if (rect === null || rect === undefined) {
      return null;
    }
    // scrollIntoView 之後要等一個繪製週期，否則截到的是捲動前的畫面
    await new Promise((resolve) => setTimeout(resolve, 400));

    const tab = await browser.tabs.get(tabId);
    if (tab.windowId === undefined) {
      return null;
    }
    const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const shot = await createImageBitmap(await (await fetch(dataUrl)).blob());
    try {
      const scale = rect.ratio;
      const width = Math.round(rect.width * scale);
      const height = Math.round(rect.height * scale);
      if (width < 16 || height < 16) {
        return null;
      }
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (context === null) {
        return null;
      }
      context.drawImage(
        shot,
        Math.round(rect.x * scale),
        Math.round(rect.y * scale),
        width,
        height,
        0,
        0,
        width,
        height,
      );
      const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
      return await decode(blob);
    } finally {
      shot.close();
    }
  } catch {
    return null;
  }
}
