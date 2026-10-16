import type { Bytes } from './bytes';

/**
 * base32（RFC 4648 的字母表，改小寫、不補 `=`）。
 *
 * 只用在書籤同步（`storage/bookmark-store`）：密文放在 `data:,` 網址裡。
 *
 * - 不用 base91：實測 Firefox 會把 `data:` 網址裡的部分字元跳脫，讀回來不一樣。
 * - 不用 base64url：`-` `_` 是網址列自動完成的「單字分界」，密文裡處處是單字開頭，
 *   使用者打什麼都可能跳出這些書籤。只有英數字的話，整串是一個單字，只比對得到開頭。
 *
 * 比 base64 大約 20%，但書籤沒有配額，這不重要。
 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

const DECODE = new Map([...ALPHABET].map((char, index) => [char, index]));

export function toBase32(bytes: Bytes): string {
  // 幾 MB 的密文：逐段 join，避免一個字元一個字元地串接長字串
  const parts: string[] = [];
  let line = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      line += ALPHABET[(buffer >>> bits) & 31] as string;
    }
    if (line.length >= 8192) {
      parts.push(line);
      line = '';
    }
  }
  if (bits > 0) {
    line += ALPHABET[(buffer << (5 - bits)) & 31] as string;
  }
  parts.push(line);
  return parts.join('');
}

/**
 * 遇到字母表以外的字元（含大寫與 `=`）就丟錯，不略過 —— 書籤被改過的話要看得出來，
 * 不能默默解出一份少了幾個 byte 的東西。
 */
export function fromBase32(text: string): Bytes {
  // 8 個字元 = 5 bytes；餘 1、3、6 個字元湊不出完整的 byte，不可能是 toBase32 的輸出
  const rest = text.length % 8;
  if (rest === 1 || rest === 3 || rest === 6) {
    throw new Error(`not base32: length ${String(text.length)}`);
  }
  const out = new Uint8Array(Math.floor((text.length * 5) / 8));
  let at = 0;
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    const digit = DECODE.get(char);
    if (digit === undefined) {
      throw new Error(`not base32: ${JSON.stringify(char)}`);
    }
    buffer = ((buffer << 5) | digit) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[at] = (buffer >>> bits) & 255;
      at += 1;
    }
  }
  return out;
}
