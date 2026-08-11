import { t } from '@/shared/i18n';

import { utf8, type Bytes } from './bytes';

/**
 * 主密碼 → AES-GCM 金鑰。
 *
 * 用 PBKDF2-SHA256 而不是 Argon2：Web Crypto 原生支援 PBKDF2，Argon2 需要
 * 引入 WASM 二進位。對一個以隱私為賣點、且要通過 AMO 審核的擴充套件來說，
 * 少一個第三方二進位依賴，比 KDF 的理論強度更值得。
 *
 * 600,000 次是 OWASP 目前對 PBKDF2-SHA256 的建議值。迭代次數一併存進
 * metadata，日後調高時舊資料仍能以原本的參數解開。
 */
export const KDF_ITERATIONS = 600_000;
export const SALT_BYTES = 16;

export function randomSalt(): Bytes {
  return crypto.getRandomValues(new Uint8Array(SALT_BYTES));
}

export async function deriveKey(
  password: string,
  salt: Bytes,
  iterations: number = KDF_ITERATIONS,
): Promise<CryptoKey> {
  if (password === '') {
    throw new Error(t('crypto_password_empty'));
  }
  const base = await crypto.subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    // extractable: false —— 金鑰不能被匯出，即使程式碼有漏洞也拿不到原始位元組
    false,
    ['encrypt', 'decrypt'],
  );
}
