import { describe, expect, it } from 'vitest';
import { seal, unseal } from '@/crypto/aead';
import { concat, equalBytes, fromBase64, fromUtf8, toBase64, utf8 } from '@/crypto/bytes';
import { CHUNK_CHARS, estimateSyncBytes, fromChunks, toChunks } from '@/crypto/chunk';
import { gunzip, gzip } from '@/crypto/compress';
import { deriveKey, KDF_ITERATIONS, randomSalt } from '@/crypto/kdf';
import { checkVerifier, decodePayload, encodePayload, makeVerifier } from '@/crypto/vault-codec';

/**
 * 這些測試刻意用較低的迭代次數，讓整份測試能在數秒內跑完。
 * 另有一個測試單獨驗證「預設值就是我們聲稱的 600,000」。
 */
const FAST_ITERATIONS = 1_000;

interface Bookmark {
  id: string;
  url: string;
  title: string;
  updatedAt: number;
}

function makeBookmarks(count: number): Bookmark[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `bm-${String(index)}`,
    url: `https://example.com/articles/${String(index)}/some-fairly-long-slug`,
    title: `第 ${String(index)} 篇文章 — 範例網站`,
    updatedAt: 1_700_000_000_000 + index,
  }));
}

async function key(password = 'correct horse battery staple', salt = randomSalt()): Promise<CryptoKey> {
  return deriveKey(password, salt, FAST_ITERATIONS);
}

/** getRandomValues 單次最多 65,536 bytes，要更大就得分段填。 */
function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  const LIMIT = 65_536;
  for (let offset = 0; offset < length; offset += LIMIT) {
    crypto.getRandomValues(out.subarray(offset, Math.min(offset + LIMIT, length)));
  }
  return out;
}

describe('bytes', () => {
  it('base64 往返後位元組完全相同', () => {
    const original = crypto.getRandomValues(new Uint8Array(1_024));
    expect(equalBytes(fromBase64(toBase64(original)), original)).toBe(true);
  });

  it('大量資料的 base64 不會爆堆疊', () => {
    // 分段實作存在的理由：String.fromCharCode(...bytes) 在這個大小會拋 RangeError
    const original = randomBytes(300_000);
    expect(equalBytes(fromBase64(toBase64(original)), original)).toBe(true);
  });

  it('UTF-8 往返保留中文與 emoji', () => {
    const text = '隱私空間 🔒 bookmark';
    expect(fromUtf8(utf8(text))).toBe(text);
  });

  it('equalBytes 對長度不同回傳 false', () => {
    expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe('gzip', () => {
  it('壓縮往返無損', async () => {
    const data = utf8(JSON.stringify(makeBookmarks(200)));
    expect(equalBytes(await gunzip(await gzip(data)), data)).toBe(true);
  });

  it('書籤資料的壓縮率明顯優於 2:1', async () => {
    // 這是 storage.sync 容量估算的依據，退化了要知道
    const data = utf8(JSON.stringify(makeBookmarks(500)));
    const compressed = await gzip(data);
    expect(compressed.length).toBeLessThan(data.length / 2);
  });
});

describe('AES-GCM', () => {
  it('封裝後可用同一把金鑰解開', async () => {
    const k = await key();
    const message = utf8('隱私書籤');
    const sealed = await seal(k, message);
    expect(equalBytes(new Uint8Array(await unseal(k, sealed)), message)).toBe(true);
  });

  it('每次封裝都用不同的 IV', async () => {
    const k = await key();
    const a = await seal(k, utf8('same'));
    const b = await seal(k, utf8('same'));
    expect(equalBytes(a.iv, b.iv)).toBe(false);
  });

  it('篡改密文會解密失敗', async () => {
    const k = await key();
    const sealed = await seal(k, utf8('隱私書籤'));
    const tampered = new Uint8Array(sealed.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    await expect(unseal(k, { iv: sealed.iv, ciphertext: tampered.buffer })).rejects.toThrow(
      /crypto_decrypt_failed/,
    );
  });

  it('篡改 IV 會解密失敗', async () => {
    const k = await key();
    const sealed = await seal(k, utf8('隱私書籤'));
    const iv = Uint8Array.from(sealed.iv);
    iv[0] = (iv[0] ?? 0) ^ 0xff;
    await expect(unseal(k, { iv, ciphertext: sealed.ciphertext })).rejects.toThrow();
  });
});

describe('金鑰派生', () => {
  it('同密碼同 salt 派生出可互通的金鑰', async () => {
    const salt = randomSalt();
    const a = await deriveKey('pw', salt, FAST_ITERATIONS);
    const b = await deriveKey('pw', salt, FAST_ITERATIONS);
    const sealed = await seal(a, utf8('hello'));
    expect(fromUtf8(new Uint8Array(await unseal(b, sealed)))).toBe('hello');
  });

  it('不同 salt 派生出不同金鑰 —— 所以 salt 必須跨裝置共享', async () => {
    const a = await deriveKey('pw', randomSalt(), FAST_ITERATIONS);
    const b = await deriveKey('pw', randomSalt(), FAST_ITERATIONS);
    const sealed = await seal(a, utf8('hello'));
    await expect(unseal(b, sealed)).rejects.toThrow();
  });

  it('拒絕空密碼', async () => {
    await expect(deriveKey('', randomSalt(), FAST_ITERATIONS)).rejects.toThrow(/crypto_password_empty/);
  });

  it('金鑰不可匯出', async () => {
    const k = await key();
    expect(k.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', k)).rejects.toThrow();
  });

  it('預設迭代次數為 600,000（OWASP 對 PBKDF2-SHA256 的建議值）', () => {
    expect(KDF_ITERATIONS).toBe(600_000);
  });
});

describe('分塊', () => {
  it('切開再接回等於原字串', () => {
    const text = 'x'.repeat(20_000);
    expect(fromChunks(toChunks(text))).toBe(text);
  });

  it('每一塊都不超過上限', () => {
    const chunks = toChunks('y'.repeat(50_000));
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_CHARS);
    }
  });

  it('剛好等於塊大小整數倍時不會產生空塊', () => {
    const chunks = toChunks('z'.repeat(CHUNK_CHARS * 3));
    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.length === CHUNK_CHARS)).toBe(true);
  });

  it('剛好多一個字元時會多出一塊', () => {
    expect(toChunks('z'.repeat(CHUNK_CHARS + 1))).toHaveLength(2);
  });

  it('空字串產生零塊', () => {
    expect(toChunks('')).toEqual([]);
  });

  it('拒絕非正數的塊大小', () => {
    expect(() => toChunks('abc', 0)).toThrow();
  });

  it('每塊都在 storage.sync 的單筆 8,192 bytes 上限之內（含鍵名）', () => {
    const chunks = toChunks('w'.repeat(100_000));
    for (const [index, chunk] of chunks.entries()) {
      expect(chunk.length + `pv_${String(index)}`.length).toBeLessThanOrEqual(8_192);
    }
  });

  it('配額估算把鍵名算進去', () => {
    expect(estimateSyncBytes(['aaa', 'bb'], 'pv_')).toBe(3 + 4 + 2 + 4);
  });
});

describe('vault 編碼', () => {
  it('往返後內容完全相同', async () => {
    const k = await key();
    const payload = { version: 1, bookmarks: makeBookmarks(50) };
    const decoded = await decodePayload<typeof payload>(k, await encodePayload(k, payload));
    expect(decoded).toEqual(payload);
  });

  it('大量書籤會切成多塊且仍能還原', async () => {
    const k = await key();
    const payload = { version: 1, bookmarks: makeBookmarks(2_000) };
    const chunks = await encodePayload(k, payload);
    expect(chunks.length).toBeGreaterThan(1);
    expect(await decodePayload<typeof payload>(k, chunks)).toEqual(payload);
  });

  it('關閉壓縮也能往返，且壓縮版本明顯較小', async () => {
    const k = await key();
    const payload = { version: 1, bookmarks: makeBookmarks(300) };
    const plainChunks = await encodePayload(k, payload, { compress: false });
    const gzipChunks = await encodePayload(k, payload, { compress: true });
    expect(await decodePayload(k, plainChunks)).toEqual(payload);
    expect(fromChunks(gzipChunks).length).toBeLessThan(fromChunks(plainChunks).length / 2);
  });

  it('錯誤的密碼無法解開', async () => {
    const salt = randomSalt();
    const right = await deriveKey('right', salt, FAST_ITERATIONS);
    const wrong = await deriveKey('wrong', salt, FAST_ITERATIONS);
    const chunks = await encodePayload(right, { secret: true });
    await expect(decodePayload(wrong, chunks)).rejects.toThrow(/crypto_decrypt_failed/);
  });

  it('缺少任一塊都會失敗，不會靜默回傳部分資料', async () => {
    const k = await key();
    const chunks = await encodePayload(k, { version: 1, bookmarks: makeBookmarks(2_000) });
    await expect(decodePayload(k, chunks.slice(0, -1))).rejects.toThrow();
  });

  it('塊順序錯亂會失敗', async () => {
    const k = await key();
    const chunks = await encodePayload(k, { version: 1, bookmarks: makeBookmarks(2_000) });
    const swapped = [chunks[1] ?? '', chunks[0] ?? '', ...chunks.slice(2)];
    await expect(decodePayload(k, swapped)).rejects.toThrow();
  });

  it('沒有塊時明確失敗', async () => {
    const k = await key();
    await expect(decodePayload(k, [])).rejects.toThrow(/crypto_no_data/);
  });

  it('不支援的格式版本會明確失敗', async () => {
    const k = await key();
    const chunks = await encodePayload(k, { a: 1 });
    const bytes = fromBase64(fromChunks(chunks));
    bytes[0] = 99;
    await expect(decodePayload(k, toChunks(toBase64(bytes)))).rejects.toThrow(/crypto_unsupported_version/);
  });
});

describe('驗證器', () => {
  it('正確金鑰通過', async () => {
    const k = await key();
    expect(await checkVerifier(k, await makeVerifier(k))).toBe(true);
  });

  it('錯誤金鑰不通過，且不拋錯', async () => {
    const salt = randomSalt();
    const right = await deriveKey('right', salt, FAST_ITERATIONS);
    const wrong = await deriveKey('wrong', salt, FAST_ITERATIONS);
    expect(await checkVerifier(wrong, await makeVerifier(right))).toBe(false);
  });

  it('垃圾輸入回傳 false 而不是爆掉', async () => {
    const k = await key();
    expect(await checkVerifier(k, 'not-base64!!!')).toBe(false);
    expect(await checkVerifier(k, toBase64(new Uint8Array(4)))).toBe(false);
  });

  it('驗證器每次產生的內容不同（IV 隨機）', async () => {
    const k = await key();
    expect(await makeVerifier(k)).not.toBe(await makeVerifier(k));
  });
});

describe('真實參數的整合檢查', () => {
  it('用 600,000 次迭代跑一次完整往返', async () => {
    const salt = randomSalt();
    const k = await deriveKey('a real master password', salt, KDF_ITERATIONS);
    const payload = { version: 1, bookmarks: makeBookmarks(500) };
    const verifier = await makeVerifier(k);
    const chunks = await encodePayload(k, payload);

    // 模擬另一台裝置：只有相同的密碼與同步過來的 salt
    const other = await deriveKey('a real master password', salt, KDF_ITERATIONS);
    expect(await checkVerifier(other, verifier)).toBe(true);
    expect(await decodePayload(other, chunks)).toEqual(payload);
  }, 30_000);

  it('500 筆書籤壓縮加密後仍在 storage.sync 的 100 KB 額度內', async () => {
    const k = await key();
    const chunks = await encodePayload(k, { version: 1, bookmarks: makeBookmarks(500) });
    const bytes = estimateSyncBytes(chunks, 'pv_');
    expect(bytes).toBeLessThan(102_400);
  });
});

describe('concat', () => {
  it('依序串接', () => {
    const joined = concat(new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5]));
    expect(Array.from(joined)).toEqual([1, 2, 3, 4, 5]);
  });
});
