import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 靜態檢查：隱私書籤的縮圖不准以明文落地，網址也不准漏進診斷。
 *
 * 這兩件事壞掉都**不會有任何錯誤**。縮圖照樣出現在畫面上，功能看起來完全正常，
 * 只有去翻擴充套件的儲存目錄才會發現：一張看得懂的圖躺在 IndexedDB 裡，
 * 或者一個本來藏起來的網址明文寫在 `storage.local` 的診斷欄位裡。
 * 整個隱私空間的意義就在那一刻沒了。
 *
 * 用靜態檢查而不是單元測試，是因為這幾個模組都要 `browser.*` 才跑得起來
 * （與 `vault-locking.test.ts`、`vault-autolock.test.ts` 同一個理由）。
 */
function bodyOf(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `找不到 ${signature}`).toBeGreaterThan(-1);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1;
    } else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error(`${signature} 的函式體沒有結束`);
}

describe('隱私書籤的縮圖', () => {
  const refresh = readFileSync('src/background/refresh-thumb.ts', 'utf8');
  const capture = readFileSync('src/background/capture.ts', 'utf8');

  /**
   * `putThumb` 寫的是明文。隱私書籤只能走 `storeVaultThumbnail`，它會先 `seal`
   * 再寫，密文與明文從來不會同時存在。
   */
  it('refreshVaultThumbnail 不碰 putThumb', () => {
    const body = bodyOf(refresh, 'export async function refreshVaultThumbnail');
    expect(body).not.toContain('putThumb');
    expect(body).toContain('storeVaultThumbnail');
  });

  /**
   * 截圖那條路是後來才開放給隱私書籤的。它必須是「只回傳位元組」的形狀 ——
   * 一旦有人在裡面順手寫入，隱私書籤就會在加密之前先留下一張明文截圖，
   * 而那正是當初不給它截圖退路的原因。
   */
  it('screenshotThumbnailFor 只回傳位元組，不寫入也不記診斷', () => {
    const body = bodyOf(capture, 'export async function screenshotThumbnailFor');
    expect(body).not.toContain('putThumb');
    expect(body).not.toContain('skip(');
    expect(body).not.toContain('recordCapture');
  });

  /** 同樣的形狀要求，`coverThumbnailFor` 一直都是這樣，一併釘住。 */
  it('coverThumbnailFor 也是', () => {
    const body = bodyOf(capture, 'export async function coverThumbnailFor');
    expect(body).not.toContain('putThumb');
    expect(body).not.toContain('skip(');
  });

  /**
   * 診斷會把網址明文寫進 `storage.local`。一般書籤那條路記，隱私空間那條不能記 ——
   * 藏起來的網址從那個欄位漏出去，與縮圖沒加密是同一級的問題。
   */
  it('隱私空間的重抓不記診斷', () => {
    const body = bodyOf(refresh, 'export async function refreshVaultThumbnail');
    expect(body).not.toContain('recordCapture');
    expect(body).not.toContain('skip(');
  });
});
