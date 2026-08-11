/**
 * 嵌入式播放器用 query string 傳的封面參數（`?poster=` / `?thumbnail=` / …）。
 *
 * 這是整套封面判定裡最可信的一層：`og:image` 常是整站共用的分享圖，而傳給播放器的
 * poster 必然是「這一頁這支影片」的封面 —— 沒有人會把站台 logo 當成影片的 poster。
 * 所以它排在宣告層之上（`cover.ts` 給 1050，og:image 是 1000）。
 *
 * 判準只有兩條，**都不看網域**：參數名稱在 `POSTER_KEYS` 裡，而且值是絕對網址。
 * 猜錯的成本很低 —— 取不下來或解不出圖片，呼叫端會直接換下一個候選。
 *
 * ## 為什麼有兩個取法
 *
 * 兩條路拿到的東西不一樣：
 *
 * - **擷取**（頁面開著）拿到的是**渲染後的 DOM**，`iframe[src]` 上是真的網址，
 *   `fromUrl()` 解析它就好。
 * - **補抓**（頁面沒開）拿到的是**原始 HTML 文字**，那裡的 `iframe` 很可能還是個
 *   框架綁定（實際遇到的是 `:src="currentEpisode?.url"`），屬性上根本沒有網址。
 *   但播放器網址連同 poster 參數往往**就在那份 HTML 裡**，只是被序列化進一段
 *   JSON（Vue / Inertia 之類把初始資料寫進屬性）。所以那條路只能整份掃文字，
 *   見 `fromText()`。
 *
 * ## `cover.ts` 為什麼不 import 這裡
 *
 * `cover.ts` 的擷取函式是用 `executeScript({ func })` **序列化注入頁面**執行的，
 * 被序列化的函式看不到任何模組層的 import —— 那也是那個檔案至今零 import 的原因。
 * 所以它必須留一份自己的 `POSTER_KEYS`，而 `tests/cover-params.test.ts` 靜態檢查
 * 兩份一致：清單漂走的話，兩條路會開始對「什麼是封面參數」有不同意見，
 * 而症狀只是「某些站台補抓抓不到」，不會有任何錯誤。
 */
export const POSTER_KEYS = ['poster', 'thumbnail', 'thumb', 'image', 'img', 'preview', 'cover'];

function isAbsoluteImageUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** 這個網址的 query 裡帶的封面參數。`base` 用來解析相對網址。 */
export function fromUrl(source: string, base?: string): string[] {
  let params: URLSearchParams;
  try {
    params = new URL(source, base).searchParams;
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const [key, value] of params) {
    // 值必須是絕對網址；這道檢查同時擋掉 `?image=1` 這類同名但無關的參數
    if (POSTER_KEYS.includes(key.toLowerCase()) && isAbsoluteImageUrl(value)) {
      found.push(value);
    }
  }
  return found;
}

/**
 * 整段文字裡的封面參數，依出現順序去重。
 *
 * 給沒有 DOM 的那條路用。掃文字比解析屬性粗糙，但**能看到框架還沒展開的資料** ——
 * 那正是需要它的情境。
 *
 * 值分兩種形態，兩種都要接住：
 * - 直接寫在網址裡：`?poster=https://cdn/x.jpg`
 * - 被 URL 編碼過（塞進另一個網址的 query 時必然如此）：`?poster=https%3A%2F%2Fcdn%2Fx.jpg`
 *
 * 字元類刻意排除 `\`：實際案例裡這段字串是被序列化進 JSON 屬性的，值的後面
 * 緊接著 `"`（跳脫的引號），不排除的話會把它一起吃進網址。
 *
 * **分隔符先正規化。** 參數不是第一個時，前面那個 `&` 在 HTML 屬性裡會寫成
 * `&amp;`、在 JS 字串裡會寫成 `&` —— 兩種情況下 `poster` 前面都不是 `&`，
 * 只認 `[?&]` 就會整個漏掉。真實案例剛好是 `?poster=`（排第一）才躲過這一點，
 * 是 `embed-spa.html` 這個 fixture 把它挖出來的。
 *
 * 沒有處理「整個容器網址又被百分號編碼一次」的情況（`%26poster=`）：那時值是
 * 雙重編碼的，解一次也還原不出網址，要處理得連解碼層一起改。目前沒遇到過。
 */
export function fromText(html: string): string[] {
  const normalized = html.replace(/&amp;|&#0*38;|\\u0026/gi, '&');
  const pattern = new RegExp(String.raw`[?&](${POSTER_KEYS.join('|')})=([^"'\s&\\<>]+)`, 'gi');
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of normalized.matchAll(pattern)) {
    const raw = match[2];
    if (raw === undefined) {
      continue;
    }
    let value: string;
    try {
      value = decodeURIComponent(raw);
    } catch {
      // 壞掉的百分號編碼（`%` 後面不是兩位十六進位）—— 用原樣再試一次
      value = raw;
    }
    if (isAbsoluteImageUrl(value) && !seen.has(value)) {
      seen.add(value);
      found.push(value);
    }
  }
  return found;
}
