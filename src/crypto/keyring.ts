import { t } from '@/shared/i18n';

import { seal, unseal, type Sealed } from './aead';
import { copyBytes, fromBase64, fromUtf8, toBase64, utf8, type Bytes } from './bytes';

/**
 * 金鑰環：資料金鑰（DEK）與包裹它的兩把鑰匙。
 *
 * 原本的設計是「主密碼派生的金鑰**直接**加密資料」。那讓兩件事變成不可能：
 *
 * - **忘記主密碼就永久遺失。** 沒有第二條路能解開，而備份檔用的是同一組密碼，
 *   所以「有備份卻忘記密碼」時備份也沒用。
 * - **改主密碼等於整包重新加密**（連每一張縮圖），中途失敗就是一堆解不開的資料。
 *
 * 改成中間多一層：
 *
 * ```
 * 主密碼 ──PBKDF2──→ KEK(密碼) ──包裹──→ ┐
 *                                      ├─→ DEK ──加密──→ 書籤與縮圖
 * 救援金鑰 ──HKDF──→ KEK(救援) ──包裹──→ ┘
 * ```
 *
 * DEK 是隨機產生的，兩把 KEK 各包一份。任一把都能解開同一個 DEK，所以：忘記密碼還有
 * 救援金鑰；改密碼只要重新包一次 DEK（資料一個位元都不用動）。
 *
 * **驗證器因此可以拿掉。** 原本存一小段已知明文來判斷密碼對不對；現在「解不開包」
 * 本身就是答案，而且更便宜（解一個 32 bytes 的包，而不是整包書籤）。少一個要維護的
 * 欄位，也少一個可能與實際金鑰不同步的地方。
 */

export const DEK_BYTES = 32;

/**
 * 救援金鑰的長度：20 bytes = 160 bit。
 *
 * 這是要抄在紙上的東西，所以長度與可讀性都重要。160 bit 剛好編成 32 個 base32 字元
 * （160 / 5 = 32），可以整齊分成 8 組 4 字元。熵遠高於任何人記得住的密碼 ——
 * 多一條解鎖路徑就是多一個攻擊面，所以這條路徑必須強到不可能被猜。
 */
export const RECOVERY_BYTES = 20;
export const RECOVERY_CHARS = 32;

/** 已包裹的金鑰，兩個欄位都是 base64（要放進 JSON）。 */
export interface WrappedKey {
  iv: string;
  ct: string;
}

export function generateDek(): Bytes {
  return crypto.getRandomValues(new Uint8Array(DEK_BYTES));
}

/**
 * 把 DEK 的原始位元組變成可用的金鑰。
 *
 * `extractable: false` —— 匯入之後就再也拿不出原始位元組。原始位元組只在產生與解包
 * 的那一瞬間存在於 JS 記憶體，呼叫端應該用完就 `zero()` 掉。
 */
export async function importDek(raw: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function wrapDek(kek: CryptoKey, raw: Bytes): Promise<WrappedKey> {
  const sealed = await seal(kek, raw);
  return { iv: toBase64(sealed.iv), ct: toBase64(new Uint8Array(sealed.ciphertext)) };
}

/**
 * 解開包裹，取回 DEK 的原始位元組。
 *
 * 用錯的鑰匙會讓 AES-GCM 的認證失敗 —— 那就是「密碼錯誤」的判斷依據，不需要另外的
 * 驗證器。訊息由 `unseal` 統一給出（密碼錯誤與資料損毀在密碼學上無法區分）。
 */
export async function unwrapDek(kek: CryptoKey, wrapped: WrappedKey): Promise<Bytes> {
  const sealed: Sealed = {
    iv: copyBytes(fromBase64(wrapped.iv)),
    ciphertext: copyBytes(fromBase64(wrapped.ct)).buffer,
  };
  const raw = new Uint8Array(await unseal(kek, sealed));
  if (raw.length !== DEK_BYTES) {
    throw new Error(t('crypto_dek_length_invalid'));
  }
  return raw;
}

/** 把用完的金鑰位元組覆寫成 0。無法保證 GC，但沒有理由讓它們留在那裡。 */
export function zero(bytes: Bytes): void {
  bytes.fill(0);
}

/**
 * 加密一小段文字成同樣的 `WrappedKey` 形狀。
 *
 * 用途是把救援金鑰本身存起來（以資料金鑰加密），讓使用者事後還能再看一次。
 * 不能借用 `wrapDek`／`unwrapDek` —— 那兩個會檢查長度必須是 32 bytes，
 * 那個檢查對「金鑰」是對的，對一段文字則會直接誤判成資料損毀。
 */
export async function sealText(key: CryptoKey, text: string): Promise<WrappedKey> {
  const sealed = await seal(key, utf8(text));
  return { iv: toBase64(sealed.iv), ct: toBase64(new Uint8Array(sealed.ciphertext)) };
}

export async function unsealText(key: CryptoKey, wrapped: WrappedKey): Promise<string> {
  const plain = await unseal(key, {
    iv: copyBytes(fromBase64(wrapped.iv)),
    ciphertext: copyBytes(fromBase64(wrapped.ct)).buffer,
  });
  return fromUtf8(new Uint8Array(plain));
}

// ── 救援金鑰 ──────────────────────────────────────────────────────────

/**
 * Crockford base32：刻意不含 I、L、O、U。
 *
 * 前三個是為了避免手抄時與 1、0 混淆（這串字的用途就是被抄在紙上、幾個月後再打回來），
 * U 則是為了避免湊出不雅的英文字。
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeBase32(bytes: Bytes): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

function decodeBase32(text: string): Bytes | null {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) {
      return null;
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

/** 產生救援金鑰，格式為 8 組 4 字元：`XXXX-XXXX-…`。 */
export function generateRecoveryKey(): string {
  const raw = crypto.getRandomValues(new Uint8Array(RECOVERY_BYTES));
  return formatRecoveryKey(encodeBase32(raw));
}

export function formatRecoveryKey(code: string): string {
  return (code.match(/.{1,4}/g) ?? []).join('-');
}

/**
 * 把使用者打進來的字串轉成標準形式，不合格時回傳 null。
 *
 * 寬鬆到底：忽略大小寫、忽略任何分隔符號與空白，並且把手抄常見的混淆修正回來
 * （`I`／`L` → `1`、`O` → `0`）。使用者是照著紙抄的，在這裡挑剔格式沒有任何好處 ——
 * 真正的把關是解不開包就是不對。
 */
export function normalizeRecoveryKey(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  if (cleaned.length !== RECOVERY_CHARS) {
    return null;
  }
  return decodeBase32(cleaned) === null ? null : cleaned;
}

/**
 * 救援金鑰 → KEK。
 *
 * 用 HKDF 而不是 PBKDF2：PBKDF2 的高迭代次數是為了讓**低熵**的人選密碼難以暴力破解，
 * 而救援金鑰本身就有 160 bit 的熵，慢慢派生完全沒有意義。HKDF 才是「已經是高熵的
 * 秘密 → 金鑰」該用的原語。
 *
 * salt 沿用該隱私空間的 KDF salt，讓同一串救援金鑰在不同 vault 產出不同的 KEK。
 */
export async function recoveryKek(code: string, salt: Bytes): Promise<CryptoKey> {
  const normalized = normalizeRecoveryKey(code);
  if (normalized === null) {
    throw new Error(t('crypto_recovery_key_length', RECOVERY_CHARS));
  }
  const raw = decodeBase32(normalized);
  if (raw === null) {
    throw new Error(t('crypto_recovery_key_format'));
  }
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('vault-recovery-kek') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
