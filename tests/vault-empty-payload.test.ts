import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 靜態檢查：`vault.ts` 不能有模組層的 payload 常數。
 *
 * 2026-10-16 實機抓到：`const EMPTY: VaultPayload = {…}` 再 `payload = { ...EMPTY }` 是淺拷貝，
 * 新建隱私空間的 `bookmarks` 就是那個常數的陣列。第一次移入 push 進去之後，同一個背景頁裡
 * 「刪除整個隱私空間 → 重新建立」的新隱私空間一開始就帶著舊的書籤。
 * `vault.ts` 要 `browser.*` 才跑得起來，所以用讀原始碼的方式守住（理由同 vault-locking.test.ts）。
 */
const SOURCE = readFileSync('src/background/vault.ts', 'utf8');

describe('vault.ts 的空 payload', () => {
  it('沒有模組層的 VaultPayload 常數', () => {
    expect(SOURCE).not.toMatch(/^const \w+: VaultPayload = /m);
  });

  it('沒有用展開運算拷貝共用的空 payload', () => {
    expect(SOURCE).not.toMatch(/\{ \.\.\.EMPTY \}/);
    expect(SOURCE).toMatch(/function emptyPayload\(\): VaultPayload \{\n\s+return \{ version: 1, bookmarks: \[\], folders: \[\] \};/);
  });
});
