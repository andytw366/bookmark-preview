/**
 * 「這張圖裡到底有沒有東西」。
 *
 * 為什麼需要它：頁面上的評分只看得到**版面資訊**（顯示面積、位置、長寬比），
 * 看不到圖的內容。於是一張被拉開的裝飾漸層可以贏過一整排真的封面縮圖 ——
 * 論壇皮膚的那條漸層在版面上又大又靠上，分數自然高。CSS 背景圖更是完全繞過
 * 「原始尺寸小於 120px 就排除」那道關卡：背景圖拿不到真實像素尺寸，`cover.ts`
 * 只能拿顯示尺寸當代理值，而一張 1×40 的漸層被拉成 1200×300 時，代理值是 1200。
 *
 * **判準放在下載並解碼之後**，不放在頁面裡：頁面裡讀不到跨來源圖片的像素
 * （canvas 會被污染），而背景頁手上是自己抓下來的位元組，沒有這個限制。
 *
 * 用「邊緣比例」而不是變異數：一條從深藍到淺藍的漸層**變異數很大**，但相鄰像素的
 * 差都很小；純色是 0；真的圖片（照片、封面、有字的 logo）到處都有明顯的跳變。
 * 所以數的是「相鄰像素差超過門檻的比例」。
 */

/** 相鄰像素亮度差超過這個值就算一個邊緣。8/255 約 3%，肉眼幾乎看不出來的漸層階梯不會超過。 */
const EDGE_DELTA = 8;

/**
 * 邊緣比例，0 到 1。
 *
 * `pixels` 是 RGBA（`getImageData().data` 的格式），長度必須是 `width * height * 4`。
 * 尺寸太小就直接回 1（不做判斷）—— 取樣點不夠時任何統計都沒有意義，而
 * 「寧可放過也不要誤殺」在這裡是對的：誤殺的代價是使用者本來抓得到的封面消失。
 */
export function edgeFraction(pixels: ArrayLike<number>, width: number, height: number): number {
  if (width < 8 || height < 8 || pixels.length < width * height * 4) {
    return 1;
  }
  const luminance = (index: number): number => {
    const at = index * 4;
    // 不用精確的 Rec.709 係數：這裡只需要「有沒有跳變」，整數權重快而且夠準
    return ((pixels[at] ?? 0) * 3 + (pixels[at + 1] ?? 0) * 6 + (pixels[at + 2] ?? 0)) / 10;
  };

  let edges = 0;
  let pairs = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const here = luminance(y * width + x);
      if (x + 1 < width) {
        pairs += 1;
        if (Math.abs(here - luminance(y * width + x + 1)) > EDGE_DELTA) {
          edges += 1;
        }
      }
      if (y + 1 < height) {
        pairs += 1;
        if (Math.abs(here - luminance((y + 1) * width + x)) > EDGE_DELTA) {
          edges += 1;
        }
      }
    }
  }
  return pairs === 0 ? 1 : edges / pairs;
}

/**
 * 自動判定要求的最低邊緣比例。
 *
 * 0.5% 刻意訂得很低，因為兩側的距離不對稱：純色與平滑漸層是 **0**（連一個跳變都
 * 沒有），而最接近門檻的合法圖片 —— 大片留白上只有一小塊字樣的 logo —— 實測是
 * 0.0155。訂在 0.02 會把那種 logo 殺掉，而站台 logo 正是「這一頁真的沒有封面」時
 * 的正解（app 型的頁面就是這樣）。這條線只用來擋「根本不是圖」的東西。
 *
 * 手動指定的圖**不套這條線**：那是使用者自己挑的，不需要被程式否決。
 */
export const MIN_COVER_EDGES = 0.005;

/**
 * 自動判定要求的最短邊（原始像素）。
 *
 * 邊緣比例擋不掉一種東西：**來源本身極小、被版面拉開的圖**。一張 1×8 的高對比
 * 漸層每一個相鄰像素都在跳變，比例接近 1，可是它仍然只是一條裝飾。
 * `cover.ts` 對 `<img>` 要求 120px，但 CSS 背景圖拿不到真實尺寸（只能拿顯示尺寸
 * 當代理值），那道關卡等於沒有 —— 這裡補上，而且是在拿到真正的位元組之後量的。
 *
 * 64 而不是 120：這裡的目的只是擋掉「明顯不是圖片」的來源，不要順手把
 * `cover.ts` 已經放行的東西再收緊一次。
 */
export const MIN_COVER_SIDE = 64;
