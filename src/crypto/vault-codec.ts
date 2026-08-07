import { seal, unseal, IV_BYTES } from './aead';
import { concat, copyBytes, equalBytes, fromBase64, fromUtf8, toBase64, utf8 } from './bytes';
import { toChunks, fromChunks } from './chunk';
import { gunzip, gzip } from './compress';

/**
 * 隱私書籤集合的編碼格式。
 *
 * 流程：JSON → UTF-8 → gzip → AES-GCM → 加上信封標頭 → base64 → 分塊
 *
 * 信封標頭讓格式自我描述，日後換壓縮方式或加密參數時舊資料仍能解開：
 *   byte 0     格式版本
 *   byte 1     旗標（bit0 = 內容已 gzip）
 *   byte 2..13 AES-GCM 的 IV（12 bytes）
 *   byte 14..  密文
 */
export const FORMAT_VERSION = 1;
const FLAG_GZIP = 0x01;
const HEADER_BYTES = 2 + IV_BYTES;

const VERIFIER_PLAINTEXT = 'bookmark-preview-vault/v1';

export interface EncodeOptions {
  /** 關閉壓縮主要是為了測試對照；正常情況一律開啟。 */
  compress?: boolean;
}

export async function encodePayload(
  key: CryptoKey,
  payload: unknown,
  options: EncodeOptions = {},
): Promise<string[]> {
  const compress = options.compress ?? true;
  const json = utf8(JSON.stringify(payload));
  const body = compress ? await gzip(json) : json;
  const sealed = await seal(key, body);

  const header = new Uint8Array(2);
  header[0] = FORMAT_VERSION;
  header[1] = compress ? FLAG_GZIP : 0;

  const envelope = concat(header, sealed.iv, new Uint8Array(sealed.ciphertext));
  return toChunks(toBase64(envelope));
}

export async function decodePayload<T>(key: CryptoKey, chunks: readonly string[]): Promise<T> {
  if (chunks.length === 0) {
    throw new Error('沒有可解碼的資料');
  }
  const envelope = fromBase64(fromChunks(chunks));
  if (envelope.length < HEADER_BYTES) {
    throw new Error('資料已損毀：長度不足');
  }

  const version = envelope[0];
  if (version !== FORMAT_VERSION) {
    throw new Error(`不支援的資料格式版本：${String(version)}`);
  }
  const compressed = ((envelope[1] ?? 0) & FLAG_GZIP) !== 0;
  const iv = copyBytes(envelope.subarray(2, HEADER_BYTES));
  const ciphertext = copyBytes(envelope.subarray(HEADER_BYTES));

  const plain = new Uint8Array(await unseal(key, { iv, ciphertext: ciphertext.buffer }));
  const json = compressed ? await gunzip(plain) : plain;
  return JSON.parse(fromUtf8(json)) as T;
}

/**
 * 驗證器：以金鑰加密一段固定的已知明文。
 *
 * 解鎖時只要試著解開這一小段，就能判斷密碼對不對，
 * 不必先把整包書籤解密（那在資料多時明顯較慢）。
 */
export async function makeVerifier(key: CryptoKey): Promise<string> {
  const sealed = await seal(key, utf8(VERIFIER_PLAINTEXT));
  return toBase64(concat(sealed.iv, new Uint8Array(sealed.ciphertext)));
}

export async function checkVerifier(key: CryptoKey, verifier: string): Promise<boolean> {
  try {
    const bytes = fromBase64(verifier);
    if (bytes.length <= IV_BYTES) {
      return false;
    }
    const plain = await unseal(key, {
      iv: copyBytes(bytes.subarray(0, IV_BYTES)),
      ciphertext: copyBytes(bytes.subarray(IV_BYTES)).buffer,
    });
    return equalBytes(new Uint8Array(plain), utf8(VERIFIER_PLAINTEXT));
  } catch {
    return false;
  }
}
