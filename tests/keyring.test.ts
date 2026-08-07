import { describe, expect, it } from 'vitest';
import { equalBytes } from '@/crypto/bytes';
import { deriveKey, randomSalt } from '@/crypto/kdf';
import {
  DEK_BYTES,
  generateDek,
  generateRecoveryKey,
  importDek,
  normalizeRecoveryKey,
  recoveryKek,
  RECOVERY_CHARS,
  unwrapDek,
  wrapDek,
  zero,
} from '@/crypto/keyring';
import { seal, unseal } from '@/crypto/aead';
import { utf8, fromUtf8 } from '@/crypto/bytes';

const FAST_ITERATIONS = 1_000;

describe('DEK 的包裹與解包', () => {
  it('同一個 DEK 被兩把鑰匙各包一份，兩把都解得開', async () => {
    const salt = randomSalt();
    const dek = generateDek();
    const passwordKek = await deriveKey('correct horse battery staple', salt, FAST_ITERATIONS);
    const code = generateRecoveryKey();
    const rescueKek = await recoveryKek(code, salt);

    const byPassword = await wrapDek(passwordKek, dek);
    const byRecovery = await wrapDek(rescueKek, dek);

    // 這是整個功能的核心性質：兩條路徑取回的必須是同一把資料金鑰
    expect(equalBytes(await unwrapDek(passwordKek, byPassword), dek)).toBe(true);
    expect(equalBytes(await unwrapDek(rescueKek, byRecovery), dek)).toBe(true);
  });

  it('用救援金鑰解開的 DEK，解得開用密碼那條路加密的資料', async () => {
    const salt = randomSalt();
    const dek = generateDek();
    const passwordKek = await deriveKey('pw', salt, FAST_ITERATIONS);
    const code = generateRecoveryKey();

    // 「用密碼建立、用救援金鑰救回」—— 忘記密碼那個情境
    const wrapped = await wrapDek(await recoveryKek(code, salt), dek);
    const ciphertext = await seal(await importDek(dek), utf8('隱私書籤的內容'));

    const recovered = await unwrapDek(await recoveryKek(code, salt), wrapped);
    const plain = await unseal(await importDek(recovered), ciphertext);
    expect(fromUtf8(new Uint8Array(plain))).toBe('隱私書籤的內容');
    // 密碼那條路當然也還在
    expect(equalBytes(await unwrapDek(passwordKek, await wrapDek(passwordKek, dek)), dek)).toBe(true);
  });

  it('錯的密碼解不開包，而且訊息不會洩漏是哪裡錯', async () => {
    const salt = randomSalt();
    const dek = generateDek();
    const wrapped = await wrapDek(await deriveKey('right', salt, FAST_ITERATIONS), dek);

    await expect(
      unwrapDek(await deriveKey('wrong', salt, FAST_ITERATIONS), wrapped),
    ).rejects.toThrow(/解密失敗/);
  });

  it('錯的救援金鑰解不開包', async () => {
    const salt = randomSalt();
    const dek = generateDek();
    const wrapped = await wrapDek(await recoveryKek(generateRecoveryKey(), salt), dek);

    await expect(unwrapDek(await recoveryKek(generateRecoveryKey(), salt), wrapped)).rejects.toThrow(
      /解密失敗/,
    );
  });

  it('同一串救援金鑰在不同 vault 產出不同的 KEK（salt 不同）', async () => {
    const dek = generateDek();
    const code = generateRecoveryKey();
    const wrapped = await wrapDek(await recoveryKek(code, randomSalt()), dek);

    // 另一個 vault 的 salt → 同一串碼也解不開，所以一份洩漏的救援金鑰不會通用
    await expect(unwrapDek(await recoveryKek(code, randomSalt()), wrapped)).rejects.toThrow();
  });

  it('包裹被篡改就解不開（AES-GCM 的認證標籤）', async () => {
    const salt = randomSalt();
    const kek = await deriveKey('pw', salt, FAST_ITERATIONS);
    const wrapped = await wrapDek(kek, generateDek());
    const tampered = {
      ...wrapped,
      ct: `${wrapped.ct.slice(0, -2)}${wrapped.ct.endsWith('A=') ? 'B=' : 'A='}`,
    };

    await expect(unwrapDek(kek, tampered)).rejects.toThrow();
  });

  it('DEK 是 32 bytes，而且每次都不一樣', () => {
    const a = generateDek();
    const b = generateDek();
    expect(a.length).toBe(DEK_BYTES);
    expect(equalBytes(a, b)).toBe(false);
  });

  it('zero 會把用完的金鑰位元組清掉', () => {
    const dek = generateDek();
    zero(dek);
    expect(dek.every((byte) => byte === 0)).toBe(true);
  });
});

describe('救援金鑰的格式', () => {
  it('產生的是 8 組 4 字元，而且不含容易抄錯的字母', () => {
    const code = generateRecoveryKey();
    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);
    // I、L、O、U 都不在字母表裡：前三個會與 1／0 混淆，U 是為了避免湊出不雅字串
    expect(code).not.toMatch(/[ILOU]/);
  });

  it('每次產生都不同', () => {
    expect(generateRecoveryKey()).not.toBe(generateRecoveryKey());
  });

  it('輸入時寬鬆對待：大小寫、分隔符號、空白都無所謂', () => {
    const code = generateRecoveryKey();
    const canonical = normalizeRecoveryKey(code);
    expect(canonical).not.toBeNull();
    expect(canonical).toHaveLength(RECOVERY_CHARS);

    expect(normalizeRecoveryKey(code.toLowerCase())).toBe(canonical);
    expect(normalizeRecoveryKey(code.replace(/-/g, ''))).toBe(canonical);
    expect(normalizeRecoveryKey(code.replace(/-/g, ' '))).toBe(canonical);
    expect(normalizeRecoveryKey(`  ${code}  `)).toBe(canonical);
  });

  it('把手抄常見的混淆修正回來', () => {
    // 使用者是照著紙抄的，在格式上挑剔沒有任何好處
    expect(normalizeRecoveryKey('I'.repeat(RECOVERY_CHARS))).toBe('1'.repeat(RECOVERY_CHARS));
    expect(normalizeRecoveryKey('L'.repeat(RECOVERY_CHARS))).toBe('1'.repeat(RECOVERY_CHARS));
    expect(normalizeRecoveryKey('O'.repeat(RECOVERY_CHARS))).toBe('0'.repeat(RECOVERY_CHARS));
  });

  it('長度不對就是不合格', () => {
    expect(normalizeRecoveryKey('')).toBeNull();
    expect(normalizeRecoveryKey('ABCD-EFGH')).toBeNull();
    expect(normalizeRecoveryKey('A'.repeat(RECOVERY_CHARS + 1))).toBeNull();
  });

  it('格式不合時 recoveryKek 明確拒絕，而不是派生出一把沒用的金鑰', async () => {
    await expect(recoveryKek('太短', randomSalt())).rejects.toThrow(/格式不正確/);
  });

  it('大小寫與分隔符號不同的同一串碼，派生出同一把 KEK', async () => {
    const salt = randomSalt();
    const code = generateRecoveryKey();
    const dek = generateDek();
    const wrapped = await wrapDek(await recoveryKek(code, salt), dek);

    // 使用者不會照原樣打回來，這一條保證那不影響救援
    const messy = code.toLowerCase().replace(/-/g, ' ');
    expect(equalBytes(await unwrapDek(await recoveryKek(messy, salt), wrapped), dek)).toBe(true);
  });
});
