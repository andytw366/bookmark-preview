import { t } from '@/shared/i18n';

import type { Bytes } from './bytes';

/** AES-GCM 封裝。GCM 自帶認證標籤，因此篡改一定會在解密時被發現。 */

export const IV_BYTES = 12;

export interface Sealed {
  iv: Bytes;
  ciphertext: ArrayBuffer;
}

export async function seal(key: CryptoKey, plaintext: Bytes): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { iv, ciphertext };
}

export async function unseal(key: CryptoKey, sealed: Sealed): Promise<ArrayBuffer> {
  try {
    return await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, key, sealed.ciphertext);
  } catch {
    // Web Crypto 對認證失敗只丟一個無資訊的 OperationError，
    // 換成使用者看得懂的訊息。密碼錯誤與資料損毀在密碼學上無法區分。
    throw new Error(t('crypto_decrypt_failed'));
  }
}
