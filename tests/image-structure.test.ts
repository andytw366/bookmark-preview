import { describe, expect, it } from 'vitest';

import { edgeFraction, MIN_COVER_EDGES } from '../src/shared/image-structure';

/**
 * 「這張圖裡有沒有東西」的判準。
 *
 * 這是缺陷 5 的核心：頁面上的評分只看得到版面（面積、位置、長寬比），所以論壇皮膚的
 * 一條裝飾漸層可以贏過一整排真的封面。這裡用合成的像素驗那條線的兩側 ——
 * **兩側都要驗**：只驗「漸層會被擋掉」的話，把門檻訂到 1.0 也會通過，而那會把
 * 每一張真的封面都殺掉。
 */
function fill(width: number, height: number, at: (x: number, y: number) => number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = at(x, y);
      const index = (y * width + x) * 4;
      pixels[index] = value;
      pixels[index + 1] = value;
      pixels[index + 2] = value;
      pixels[index + 3] = 255;
    }
  }
  return pixels;
}

const SIZE = 48;

describe('該被擋掉的（不是圖，是裝飾）', () => {
  it('純色是 0', () => {
    expect(edgeFraction(fill(SIZE, SIZE, () => 128), SIZE, SIZE)).toBe(0);
  });

  /** eyny 論壇皮膚那條淡藍漸層就是這個形狀：又大又靠上，但相鄰像素幾乎沒有差。 */
  it('平滑的垂直漸層遠低於門檻', () => {
    const pixels = fill(SIZE, SIZE, (_x, y) => 200 + (y / SIZE) * 40);
    expect(edgeFraction(pixels, SIZE, SIZE)).toBeLessThan(MIN_COVER_EDGES);
  });

  it('整個亮度範圍都用上的漸層也一樣 —— 變異數大，但沒有跳變', () => {
    const pixels = fill(SIZE, SIZE, (_x, y) => (y / SIZE) * 255);
    expect(edgeFraction(pixels, SIZE, SIZE)).toBeLessThan(MIN_COVER_EDGES);
  });

  it('懶載入用的灰底佔位圖（純色）也擋掉', () => {
    expect(edgeFraction(fill(SIZE, SIZE, () => 235), SIZE, SIZE)).toBeLessThan(MIN_COVER_EDGES);
  });
});

describe('該放過的（真的是圖）', () => {
  it('照片般的雜訊遠高於門檻', () => {
    // 固定的偽隨機：測試不能靠 Math.random，否則偶爾會紅
    let seed = 1;
    const pixels = fill(SIZE, SIZE, () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % 256;
    });
    expect(edgeFraction(pixels, SIZE, SIZE)).toBeGreaterThan(MIN_COVER_EDGES);
  });

  /**
   * 只有幾個字的 logo 是最接近門檻的一側 —— 大片留白加上幾筆銳利的邊。
   * 這一條就是「不要把門檻訂高」的守門人：站台 logo 現在是**沒有更好選擇時的正解**
   * （app 型頁面），不能被當成裝飾殺掉。
   */
  it('大片留白上的一小塊字樣仍然過關', () => {
    const pixels = fill(SIZE, SIZE, (x, y) => {
      const inWordmark = y > SIZE * 0.45 && y < SIZE * 0.55 && x % 4 < 2 && x > SIZE * 0.3 && x < SIZE * 0.7;
      return inWordmark ? 20 : 250;
    });
    // 實測 0.0155 —— 這是門檻該站在哪裡的依據，別把門檻訂到它上面去
    expect(edgeFraction(pixels, SIZE, SIZE)).toBeGreaterThan(MIN_COVER_EDGES);
  });

  /**
   * 門檻要離「純色與漸層」很近、離「有內容的圖」很遠。訂在中間看起來安全，實際上是
   * 拿真的封面去換 —— 上面那個 logo 就在 0.0155，而漸層是 0。
   */
  it('門檻本身就在漸層那一側，不在 logo 那一側', () => {
    const gradient = edgeFraction(fill(SIZE, SIZE, (_x, y) => (y / SIZE) * 255), SIZE, SIZE);
    expect(MIN_COVER_EDGES).toBeGreaterThan(gradient);
    expect(MIN_COVER_EDGES).toBeLessThan(0.0155);
  });

  it('漫畫封面那種有格線與文字的圖過關', () => {
    const pixels = fill(SIZE, SIZE, (x, y) => ((x >> 2) + (y >> 2)) % 2 === 0 ? 40 : 210);
    expect(edgeFraction(pixels, SIZE, SIZE)).toBeGreaterThan(MIN_COVER_EDGES);
  });
});

describe('取樣點不夠時不做判斷', () => {
  it('太小的圖直接放過 —— 誤殺比放過糟', () => {
    expect(edgeFraction(fill(4, 4, () => 128), 4, 4)).toBe(1);
  });

  it('像素資料長度不符也放過，不要憑半份資料下結論', () => {
    expect(edgeFraction(new Uint8ClampedArray(16), SIZE, SIZE)).toBe(1);
  });
});
