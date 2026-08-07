/**
 * 位元組與 base64 / UTF-8 之間的轉換。
 *
 * 全部用 `Bytes` 而不是裸的 `Uint8Array`：TypeScript 的 Uint8Array 現在帶
 * buffer 型別參數，預設的 `ArrayBufferLike` 包含 `SharedArrayBuffer`，
 * 因而不符合 Web Crypto 要求的 `BufferSource`。把 buffer 種類釘死在
 * `ArrayBuffer`，就不需要在每個呼叫點灑 `as BufferSource`。
 */
export type Bytes = Uint8Array<ArrayBuffer>;

export function utf8(text: string): Bytes {
  return new TextEncoder().encode(text);
}

export function fromUtf8(bytes: Bytes): string {
  return new TextDecoder().decode(bytes);
}

export function toBase64(bytes: Bytes): string {
  // 分段處理：String.fromCharCode(...bytes) 在資料稍大時會因參數過多而爆堆疊
  const CHUNK = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Bytes {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function concat(...parts: Bytes[]): Bytes {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** 複製成獨立的 ArrayBuffer：subarray 共用原 buffer，直接餵給 Web Crypto 會連到多餘位元組。 */
export function copyBytes(view: Uint8Array): Bytes {
  const out = new Uint8Array(view.length);
  out.set(view);
  return out;
}

/** 定時比較，避免以提早返回洩漏資訊。 */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
}
