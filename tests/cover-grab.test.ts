import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 取得封面**位元組**的那三段策略，以及自動判定用的是哪幾段。
 *
 * 這裡測的不是「哪張圖該當封面」（那是 `cover.ts` 的分數，另外驗），而是
 * 「選好的那張圖到底拿不拿得下來」。自動與手動兩條路曾經在這一點上分岔：
 * 手動有三段策略、自動只做一次背景頁 fetch，於是**同一張圖右鍵指定得到、
 * 自動判定拿不到**，而且失敗是安靜的 —— 往下試到站台 logo 就停了。
 *
 * 解碼那一步（`makeCoverThumbnail`）在這裡換掉：它要 `createImageBitmap` 與
 * `OffscreenCanvas`，Node 沒有。被測的東西是**策略的順序與取捨**，不是解碼。
 *
 * **這裡測不到的部分**：被注入到頁面裡執行的那兩個函式（`fetchInPage`、
 * `locateImageInPage`）的函式體。假的 `executeScript` 只回傳結果，不會真的去跑它們 ——
 * 而它們跑的地方有 Xray 邊界，行為與 Node 裡完全不同（第二段策略就是在那裡靜靜壞了
 * 很久：請求成功、轉換位元組時丟 `Permission denied to access property "constructor"`，
 * 然後被 catch 成 null）。那一段只有真的瀏覽器驗得到，fixture 是
 * `tests/fixtures/site/hotlink.html`。下面用靜態檢查把已知的地雷釘住。
 */
/** 解碼結果的「邊緣比例」，由各案例決定（見 `shared/image-structure.ts`）。 */
let stubEdges = 0.5;

vi.mock('@/background/image', () => ({
  makeCoverThumbnail: (blob: Blob) =>
    Promise.resolve({
      bytes: new ArrayBuffer(blob.size),
      mime: 'image/webp',
      width: 400,
      height: 600,
      edges: stubEdges,
    }),
}));

type Grab = typeof import('@/background/image-grab');
type CoverGrab = typeof import('@/background/cover-grab');

let grab: Grab;
let coverGrab: CoverGrab;
/** 圖片網址 → 這個網址該怎麼回應（背景頁 fetch 的那一段） */
let direct: Map<string, { status: number; type: string }>;
/** 頁面內 fetch 拿得到的網址（第二段），值是回傳的 data: URL */
let inPage: Map<string, string>;
let injected: number;
let captured: number;
/** 背景頁 fetch 依序要過哪些網址 */
let requested: string[];

beforeEach(async () => {
  direct = new Map();
  inPage = new Map();
  injected = 0;
  captured = 0;
  requested = [];
  stubEdges = 0.5;

  vi.stubGlobal('fetch', (url: string) => {
    /*
     * 第二段策略回來的是 `data:` URL，背景頁再 fetch 它一次把位元組拿出來 ——
     * 那一次不走網路，所以不記進 requested，也不受上面那張回應表管。
     */
    if (url.startsWith('data:')) {
      const payload = atob(url.slice(url.indexOf(',') + 1));
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => 'image/png' },
        blob: () => Promise.resolve(new Blob([payload])),
      });
    }
    requested.push(url);
    const reply = direct.get(url);
    if (reply === undefined) {
      return Promise.reject(new Error('連不上'));
    }
    return Promise.resolve({
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? reply.type : null) },
      blob: () => Promise.resolve(new Blob([new Uint8Array(64)])),
    });
  });

  vi.stubGlobal('browser', {
    scripting: {
      /*
       * 第二段（頁面內 fetch）與第三段（找出圖片在畫面上的位置）都是
       * `executeScript({ target, func, args: [imageUrl] })`，用注入的函式名稱分辨。
       */
      executeScript: ({ func, args }: { func: { name: string }; args: unknown[] }) => {
        injected += 1;
        const imageUrl = args[0] as string;
        if (func.name === 'locateImageInPage') {
          // 圖就在畫面上（第三段有東西可裁）
          return Promise.resolve([{ result: { x: 10, y: 20, width: 400, height: 600, ratio: 1 } }]);
        }
        return Promise.resolve([{ result: inPage.get(imageUrl) ?? null }]);
      },
    },
    tabs: {
      get: () => Promise.resolve({ id: 7, windowId: 1, url: 'https://site.test/page' }),
      captureVisibleTab: () => {
        captured += 1;
        return Promise.reject(new Error('容器裡截不到，也不必截'));
      },
    },
  });

  vi.resetModules();
  grab = await import('@/background/image-grab');
  coverGrab = await import('@/background/cover-grab');
});

const IMAGE = 'https://cdn.test/cover.jpg';

describe('三段策略', () => {
  it('第一段（背景頁 fetch）成功時完全不碰頁面', async () => {
    direct.set(IMAGE, { status: 200, type: 'image/jpeg' });

    const result = await grab.grabImage(7, IMAGE);

    expect(result?.strategy).toBe('fetch');
    expect(injected).toBe(0);
  });

  /**
   * 防盜連的實際樣子：CDN 檢查 Referer，而擴充套件無法自行設定跨來源的 Referer
   * （`fetch` 的 `referrer` 選項會被瀏覽器丟掉）。頁面內的請求才帶得到對的 Referer。
   */
  it('第一段 403 就改在頁面裡抓', async () => {
    direct.set(IMAGE, { status: 403, type: 'text/html' });
    inPage.set(IMAGE, `data:image/png;base64,${btoa('pretend-image-bytes')}`);

    const result = await grab.grabImage(7, IMAGE);

    expect(result?.strategy).toBe('page-fetch');
  });

  /**
   * 不少 CDN 對圖片回 `application/octet-stream`。硬檢查 content-type 會把那些
   * 圖全部丟掉，而真正的判斷標準是「能不能解碼成圖片」。
   */
  it('content-type 不是 image/* 也照樣採用', async () => {
    direct.set(IMAGE, { status: 200, type: 'application/octet-stream' });

    const result = await grab.grabImage(7, IMAGE);

    expect(result?.strategy).toBe('fetch');
  });

  it('沒有分頁時只有第一段可用', async () => {
    direct.set(IMAGE, { status: 403, type: 'text/html' });
    inPage.set(IMAGE, `data:image/png;base64,${btoa('reachable, but there is no tab to inject into')}`);

    expect(await grab.grabImage(undefined, IMAGE)).toBeNull();
    expect(injected).toBe(0);
  });

  it('預設會走到第三段（畫面裁切）—— 手動指定時圖就在螢幕上', async () => {
    direct.set(IMAGE, { status: 403, type: 'text/html' });

    await grab.grabImage(7, IMAGE);

    expect(captured).toBeGreaterThan(0);
  });

  /**
   * 自動那條路的關鍵取捨。裁切前得先 `scrollIntoView`，而自動擷取只是因為使用者
   * 造訪了一個已加入書籤的頁面就會跑 —— 頁面自己跳一下完全沒道理。
   */
  it('allowScreenshot: false 時前兩段失敗就放棄，不截圖也不捲動頁面', async () => {
    direct.set(IMAGE, { status: 403, type: 'text/html' });

    const result = await grab.grabImage(7, IMAGE, { allowScreenshot: false });

    expect(result).toBeNull();
    expect(captured).toBe(0);
  });
});

describe('依候選順序取封面', () => {
  const FIRST = 'https://cdn.test/a.jpg';
  const SECOND = 'https://cdn.test/b.jpg';

  it('第一個取不下來就換下一個', async () => {
    direct.set(FIRST, { status: 404, type: 'text/html' });
    direct.set(SECOND, { status: 200, type: 'image/jpeg' });

    expect(await coverGrab.grabCoverThumbnail([FIRST, SECOND], 7)).not.toBeNull();
  });

  it('依序試、不並發 —— 分數排前面的候選成功了就不該再碰後面的', async () => {
    direct.set(FIRST, { status: 200, type: 'image/jpeg' });
    direct.set(SECOND, { status: 200, type: 'image/jpeg' });

    await coverGrab.grabCoverThumbnail([FIRST, SECOND], 7);

    expect(requested).toEqual([FIRST]);
  });

  it('全部失敗回 null，交給截圖那條退路', async () => {
    expect(await coverGrab.grabCoverThumbnail([FIRST, SECOND], 7)).toBeNull();
  });

  /**
   * 純色與平滑漸層不是圖，是裝飾。實測 eyny 論壇的版面底圖就是這樣贏過整排真的縮圖的
   * （那一張最後是靠長寬比擋掉的，但懶載入的灰底佔位圖只有這條線擋得住）。
   */
  it('解出來根本不是圖（純色／漸層）就換下一個候選', async () => {
    stubEdges = 0.001;
    direct.set(FIRST, { status: 200, type: 'image/jpeg' });

    expect(await coverGrab.grabCoverThumbnail([FIRST], 7)).toBeNull();
    // 有去抓，只是抓回來之後判定它不是圖
    expect(requested).toEqual([FIRST]);
  });

  it('手動指定不套那條線 —— 使用者說要這張就是這張', async () => {
    stubEdges = 0.001;
    direct.set(FIRST, { status: 200, type: 'image/jpeg' });

    expect(await grab.grabImage(7, FIRST)).not.toBeNull();
  });

  /** 自動那條路必須關掉畫面裁切，理由見上面。 */
  it('自動路徑不會截圖', async () => {
    direct.set(FIRST, { status: 403, type: 'text/html' });

    await coverGrab.grabCoverThumbnail([FIRST], 7);

    expect(captured).toBe(0);
  });
});

/**
 * 靜態檢查：自動那條路不准自己去 fetch。
 *
 * 這是兩條路當初漂走的方式 —— 各自寫一份下載邏輯，於是手動那邊補上的策略
 * 自動那邊完全不知道。漂走的症狀是「某些站台右鍵抓得到、自動抓不到」，
 * 型別檢查與其他測試全綠。
 */
describe('自動與手動共用同一份下載邏輯', () => {
  const source = readFileSync('src/background/cover-grab.ts', 'utf8');
  // 註解裡本來就會提到 fetch、recordCapture 這些名字（那正是說明為什麼不用它們），
  // 所以先把註解消掉再檢查，否則這幾條會被自己的說明文字絆倒
  const code = source.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');

  it('cover-grab 自己不呼叫 fetch，一律走 grabImage', () => {
    expect(code).toContain('grabImage');
    expect(code).not.toContain('fetch(');
  });

  /**
   * 隱私書籤的重抓也會走到這裡。`recordCapture` 會把網址明文寫進 `storage.local`，
   * 對隱私書籤來說那等於把藏起來的網址又漏出去一次；`putThumb` 寫的則是明文縮圖。
   * 兩者壞掉都不會有任何錯誤 —— 縮圖照樣出現，功能看起來完全正常。
   */
  it('cover-grab 只回傳位元組：不寫入、不記診斷', () => {
    expect(code).not.toContain('putThumb');
    expect(code).not.toContain('recordCapture');
    expect(code).not.toContain('skip(');
  });
});

/**
 * 靜態檢查：注入到頁面裡跑的那段不准自己轉位元組。
 *
 * 這是一個**只在真瀏覽器裡才會出現、而且完全安靜**的失敗。注入的程式跨在 Xray
 * 邊界上，`String.fromCharCode(...bytes.subarray(...))` 需要取得迭代器，Firefox 會丟
 * `Permission denied to access property "constructor"`，接著被 `catch` 變成 null ——
 * 於是第二段策略看起來只是「這張圖抓不到」。從伺服器記錄看得到 200，位元組卻從來
 * 沒有回到背景頁。編碼交給 `FileReader`（瀏覽器自己做），回傳 `data:` URL。
 */
describe('注入頁面的那段不碰位元組', () => {
  const source = readFileSync('src/background/image-grab.ts', 'utf8');
  const start = source.indexOf('function fetchInPage');
  const body = source.slice(start, source.indexOf('\n}', start));

  it('用 FileReader 編碼，不自己拼 base64', () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain('readAsDataURL');
    expect(body).not.toContain('String.fromCharCode');
    expect(body).not.toContain('btoa');
    expect(body).not.toContain('Uint8Array');
  });
});
