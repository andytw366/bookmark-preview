import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 靜態檢查：`vault.ts` 裡不能有「在鎖裡再取一次鎖」的呼叫。
 *
 * 為什麼是靜態檢查而不是一般的單元測試：`vault.ts` 要 `browser.*` 才跑得起來，
 * 在 vitest 裡沒辦法直接呼叫；而這個 bug 的代價又特別高 —— 佇列不可重入，
 * 巢狀呼叫會讓整個 vault 佇列**永久卡死**（之後每個寫入都無聲失效），
 * 型別檢查抓不到，畫面上也看不出來。實際發生過一次（`moveManyToFolder`）。
 *
 * 規則：凡是函式體以 `return exclusive(` 開頭的（會自己取鎖），
 * 都不可以出現在另一個會取鎖的函式體裡。要在鎖裡做事就呼叫 `*Locked` 版本。
 */
const SOURCE = readFileSync('src/background/vault.ts', 'utf8');

interface Segment {
  name: string;
  body: string;
}

/** 以頂層 function 宣告切段。夠用了：這個檔案的函式都宣告在頂層。 */
function segments(source: string): Segment[] {
  const lines = source.split('\n');
  const out: Segment[] = [];
  let current: Segment | null = null;
  for (const line of lines) {
    const match = /^(?:export )?(?:async )?function (\w+)/.exec(line);
    if (match?.[1] !== undefined) {
      current = { name: match[1], body: '' };
      out.push(current);
      continue;
    }
    if (current !== null) {
      current.body += `${line}\n`;
    }
  }
  return out;
}

describe('vault.ts 的佇列使用方式', () => {
  const all = segments(SOURCE);
  const lockTaking = all.filter((segment) => /return exclusive\(/.test(segment.body));

  it('找得到會取鎖的函式（防止這個檢查因為改寫而悄悄失效）', () => {
    expect(lockTaking.length).toBeGreaterThan(10);
    expect(lockTaking.map((segment) => segment.name)).toContain('moveBookmarkToFolder');
  });

  it('沒有任何會取鎖的函式在鎖裡呼叫另一個會取鎖的函式', () => {
    const names = new Set(lockTaking.map((segment) => segment.name));
    const offenders: string[] = [];

    for (const segment of lockTaking) {
      for (const name of names) {
        // 委派用的一行包裝（return exclusive(async () => nameLocked(...))）呼叫的是
        // 不取鎖的版本，不會落在這個集合裡，所以不必特別排除
        const called = new RegExp(String.raw`\b(?:await|void|return)\s+${name}\s*\(`);
        if (called.test(segment.body)) {
          offenders.push(`${segment.name} → ${name}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
