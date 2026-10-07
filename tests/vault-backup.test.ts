import { describe, expect, it } from 'vitest';
import { fromChunks, fitsInSync, SYNC_META_RESERVE, SYNC_TOTAL_BUDGET, toChunks } from '@/crypto/chunk';
import { fromBase64 } from '@/crypto/bytes';
import { deriveKey, randomSalt } from '@/crypto/kdf';
import {
  generateDek,
  generateRecoveryKey,
  importDek,
  recoveryKek,
  sealText,
  unwrapDek,
  wrapDek,
} from '@/crypto/keyring';
import { decodePayload, encodePayload } from '@/crypto/vault-codec';
import { BACKUP_FORMAT, backupFilename, buildBackup, parseBackup } from '@/shared/vault-backup';
import { sanitizeLayout, type VaultLayout } from '@/shared/vault-layout';
import { sanitizeVaultPayload } from '@/shared/vault-merge';
import type { VaultMeta, VaultPayload } from '@/shared/types';

const FAST_ITERATIONS = 1_000;
const NOW = 1_800_000_000_000;

/** 建一個與 `createVault` 同構的中介資料：隨機 DEK，被密碼與救援金鑰各包一份。 */
async function makeMeta(
  password: string,
): Promise<{ meta: VaultMeta; key: CryptoKey; recoveryCode: string }> {
  const salt = randomSalt();
  const dek = generateDek();
  const key = await importDek(dek);
  const recoveryCode = generateRecoveryKey();
  return {
    key,
    recoveryCode,
    meta: {
      version: 2,
      salt: Buffer.from(salt).toString('base64'),
      iterations: FAST_ITERATIONS,
      passwordWrap: await wrapDek(await deriveKey(password, salt, FAST_ITERATIONS), dek),
      recoveryWrap: await wrapDek(await recoveryKek(recoveryCode, salt), dek),
      recoveryCodeSealed: await sealText(key, recoveryCode),
      metaUpdatedAt: NOW,
      createdAt: NOW,
    },
  };
}

const SAMPLE: VaultPayload = {
  version: 1,
  bookmarks: [
    {
      id: '2a1c1f4e-0000-4000-8000-000000000001',
      url: 'https://example.com/漫畫/第一卷',
      title: '第一卷 — 範例',
      folderId: null,
      createdAt: NOW - 10_000,
      updatedAt: NOW - 10_000,
    },
  ],
  folders: [],
};

describe('備份檔往返', () => {
  it('匯出再匯入拿回一模一樣的資料', async () => {
    const password = 'correct horse battery staple';
    const { meta, key } = await makeMeta(password);
    const blob = fromChunks(await encodePayload(key, SAMPLE));

    const file = parseBackup(buildBackup(meta, blob, NOW));

    // 匯入端只有檔案與密碼，資料金鑰必須完全從檔案裡的欄位重建
    const kek = await deriveKey(password, fromBase64(file.vault.salt), file.vault.iterations);
    const restored = await importDek(await unwrapDek(kek, file.vault.passwordWrap));
    expect(sanitizeVaultPayload(await decodePayload(restored, [file.blob]))).toEqual(SAMPLE);
  });

  it('忘記主密碼時，救援金鑰也打得開同一個備份檔', async () => {
    // 少了這條，「忘記密碼」時備份檔一樣是廢的 —— 備份用的是同一組密碼
    const { meta, key, recoveryCode } = await makeMeta('忘記了的密碼');
    const file = parseBackup(buildBackup(meta, fromChunks(await encodePayload(key, SAMPLE)), NOW));

    const kek = await recoveryKek(recoveryCode, fromBase64(file.vault.salt));
    const restored = await importDek(await unwrapDek(kek, file.vault.recoveryWrap));
    expect(sanitizeVaultPayload(await decodePayload(restored, [file.blob]))).toEqual(SAMPLE);
  });

  it('密碼錯誤時解不開那個小包裹，不必嘗試解密整包書籤', async () => {
    const { meta, key } = await makeMeta('right password');
    const file = parseBackup(buildBackup(meta, fromChunks(await encodePayload(key, SAMPLE)), NOW));

    const wrong = await deriveKey('wrong password', fromBase64(file.vault.salt), file.vault.iterations);
    await expect(unwrapDek(wrong, file.vault.passwordWrap)).rejects.toThrow(/crypto_decrypt_failed/);
  });

  it('備份檔裡沒有明文的網址或標題', async () => {
    const { meta, key } = await makeMeta('pw');
    const json = buildBackup(meta, fromChunks(await encodePayload(key, SAMPLE)), NOW);

    expect(json).not.toContain('example.com');
    expect(json).not.toContain('第一卷');
  });

  it('整份中介資料都在檔案裡 —— 少任何一項就永遠打不開', async () => {
    const { meta, key } = await makeMeta('pw');
    const parsed = JSON.parse(buildBackup(meta, fromChunks(await encodePayload(key, SAMPLE)), NOW));

    expect(parsed.vault).toEqual(meta);
  });
  it('版面（排列）跟著備份走，加密、與書籤同一把金鑰', async () => {
    const { meta, key } = await makeMeta('pw');
    const layout: VaultLayout = {
      version: 1,
      sections: { order: { '~root': { ids: ['2a1c1f4e-0000-4000-8000-000000000001'], updatedAt: NOW } } },
    };
    const json = buildBackup(
      meta,
      fromChunks(await encodePayload(key, SAMPLE)),
      NOW,
      fromChunks(await encodePayload(key, layout)),
    );
    expect(json).not.toContain('~root');
    const file = parseBackup(json);
    expect(file.layout).toBeDefined();
    expect(sanitizeLayout(await decodePayload(key, [file.layout ?? '']))).toEqual(layout);
  });

  it('舊版的備份檔沒有版面，照樣讀得進來', async () => {
    const { meta, key } = await makeMeta('pw');
    const file = parseBackup(buildBackup(meta, fromChunks(await encodePayload(key, SAMPLE)), NOW));
    expect(file.layout).toBeUndefined();
  });

  it('加了版面欄位但沒有升版本號 —— 舊版的 parseBackup 會拒絕版本較新的檔案', () => {
    expect(JSON.parse(buildBackup({} as VaultMeta, 'x', NOW, 'y')).version).toBe(1);
  });
});

describe('parseBackup 的錯誤訊息', () => {
  const wrap = { iv: 'aXY=', ct: 'Y3Q=' };
  const valid = {
    format: BACKUP_FORMAT,
    version: 1,
    createdAt: NOW,
    vault: {
      version: 2,
      salt: 'c2FsdA==',
      iterations: 600_000,
      passwordWrap: wrap,
      recoveryWrap: wrap,
      recoveryCodeSealed: wrap,
      metaUpdatedAt: NOW,
      createdAt: NOW,
    },
    blob: 'YmxvYg==',
  };

  it('不是 JSON', () => {
    expect(() => parseBackup('這不是 JSON')).toThrow(/backup_invalid_json/);
  });

  it('是 JSON 但不是這個擴充套件的備份檔', () => {
    expect(() => parseBackup('{"hello":1}')).toThrow(/backup_wrong_extension/);
  });

  it('版本比擴充套件新時明確要求更新，而不是硬解', () => {
    expect(() => parseBackup(JSON.stringify({ ...valid, version: 99 }))).toThrow(/backup_newer_version/);
  });

  it('缺 salt 時說清楚是缺 salt', () => {
    expect(() =>
      parseBackup(JSON.stringify({ ...valid, vault: { ...valid.vault, salt: '' } })),
    ).toThrow(/salt/);
  });

  it('iterations 無效時擋下來（0 次迭代等於沒有 KDF）', () => {
    expect(() =>
      parseBackup(JSON.stringify({ ...valid, vault: { ...valid.vault, iterations: 0 } })),
    ).toThrow(/backup_bad_iterations/);
  });

  it('缺任一個包裹都要明講，因為那決定了還原得不了', () => {
    expect(() =>
      parseBackup(JSON.stringify({ ...valid, vault: { ...valid.vault, passwordWrap: undefined } })),
    ).toThrow(/backup_missing_password_wrap/);
    expect(() =>
      parseBackup(JSON.stringify({ ...valid, vault: { ...valid.vault, recoveryWrap: undefined } })),
    ).toThrow(/backup_missing_recovery_wrap/);
  });

  it('沒有資料本體', () => {
    expect(() => parseBackup(JSON.stringify({ ...valid, blob: '' }))).toThrow(/backup_missing_blob/);
  });

  it('合法的檔案原樣通過', () => {
    expect(parseBackup(JSON.stringify(valid)).blob).toBe('YmxvYg==');
  });
});

describe('backupFilename', () => {
  it('帶日期，讓多份備份看得出先後', () => {
    // 文案在 _locales，Node 裡沒有 browser.i18n，所以拿到的是「鍵名(代入的值)」——
    // 這一條要釘住的本來就是日期算得對不對，不是檔名長什麼樣子
    expect(backupFilename(new Date(2026, 7, 4))).toBe('backup_filename(2026-08-04)');
  });
});

describe('storage.sync 的配額判斷', () => {
  it('小份資料放得進去', () => {
    expect(fitsInSync(toChunks('a'.repeat(10_000)), 'vaultSyncC')).toBe(true);
  });

  it('超過額度時回報放不進去，而不是靜靜地寫一半上去', () => {
    expect(fitsInSync(toChunks('a'.repeat(SYNC_TOTAL_BUDGET)), 'vaultSyncC')).toBe(false);
  });

  it('邊界：剛好用完扣掉中介資料餘裕後的空間', () => {
    // 一塊 7500 字元 + 鍵名長度，湊到剛好等於預算
    const usable = SYNC_TOTAL_BUDGET - SYNC_META_RESERVE;
    const chunks = toChunks('a'.repeat(usable - 200));
    expect(fitsInSync(chunks, 'vaultSyncC')).toBe(true);
    expect(fitsInSync(toChunks('a'.repeat(usable + 200)), 'vaultSyncC')).toBe(false);
  });

  it('分塊後接回來與原字串相同（同步的塊組裝走這條路）', () => {
    const text = 'x'.repeat(20_000) + 'END';
    expect(fromChunks(toChunks(text))).toBe(text);
  });
});
