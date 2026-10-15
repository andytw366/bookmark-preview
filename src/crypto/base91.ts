import type { Bytes } from './bytes';

/**
 * basE91（Joachim Henke 的演算法），字母表換掉 `"` 與 `\`。
 *
 * 只用在 `storage.sync` 的隱私空間副本上。那裡的配額是「鍵名 + JSON 序列化後的值」的位元組數，
 * base64 每個字元帶 6 bits，這裡約 6.5 bits —— 同一份密文少佔約 8%。
 *
 * 字母表必須是**JSON 不會轉義的 ASCII**：`"` 與 `\` 序列化後變兩個字元，控制字元與非 ASCII
 * 也不行（後者在 UTF-8 裡是多位元組）。0x21–0x7E 共 94 個，去掉這兩個還剩 92，取前 91 個。
 */
const ALPHABET = Array.from({ length: 0x7e - 0x21 + 1 }, (_, index) => String.fromCharCode(0x21 + index))
  .filter((char) => char !== '"' && char !== '\\')
  .slice(0, 91)
  .join('');

const DECODE = new Map([...ALPHABET].map((char, index) => [char, index]));

export function toBase91(bytes: Bytes): string {
  let out = '';
  let queue = 0;
  let bits = 0;
  for (const byte of bytes) {
    queue |= byte << bits;
    bits += 8;
    if (bits > 13) {
      let value = queue & 8191;
      if (value > 88) {
        queue >>>= 13;
        bits -= 13;
      } else {
        value = queue & 16383;
        queue >>>= 14;
        bits -= 14;
      }
      out += (ALPHABET[value % 91] as string) + (ALPHABET[Math.floor(value / 91)] as string);
    }
  }
  if (bits > 0) {
    out += ALPHABET[queue % 91] as string;
    if (bits > 7 || queue > 90) {
      out += ALPHABET[Math.floor(queue / 91)] as string;
    }
  }
  return out;
}

export function fromBase91(text: string): Bytes {
  const out: number[] = [];
  let queue = 0;
  let bits = 0;
  let pending = -1;
  for (const char of text) {
    const digit = DECODE.get(char);
    if (digit === undefined) {
      throw new Error(`not base91: ${JSON.stringify(char)}`);
    }
    if (pending === -1) {
      pending = digit;
      continue;
    }
    const value = pending + digit * 91;
    queue |= value << bits;
    bits += (value & 8191) > 88 ? 13 : 14;
    do {
      out.push(queue & 255);
      queue >>>= 8;
      bits -= 8;
    } while (bits > 7);
    pending = -1;
  }
  if (pending !== -1) {
    out.push((queue | (pending << bits)) & 255);
  }
  return new Uint8Array(out);
}
