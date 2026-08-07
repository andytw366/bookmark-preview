import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 靜態檢查：自動上鎖的期限不能被「不是使用者操作」的東西推回去。
 *
 * 為什麼是靜態檢查：`vault-lock.ts` 與 `index.ts` 都要 `browser.*` 才跑得起來，
 * 在 vitest 裡沒辦法直接呼叫（與 `vault-locking.test.ts` 同一個理由）。而這個
 * bug 類別的代價很高，**而且已經發生過一次**：2026-08-07 之前自動上鎖只綁在
 * `browser.idle`（整台電腦沒有鍵鼠輸入）上，所以只要人還在用電腦，隱私空間就
 * 永遠不會上鎖 —— 型別檢查與其他測試全都抓不到，畫面上也完全看不出來。
 *
 * 會讓它再壞掉的兩種改動，各對應下面一組測試：
 *
 * 1. 讓**心跳**算成使用者活動。心跳每 15 秒固定發生，與有沒有人在操作無關，
 *    算進去的話期限永遠不會到。
 * 2. 讓**讀取類訊息**算成使用者活動。`vault-sync` 收到遠端變動會廣播
 *    `vault/changed`，UI 就會重讀 `vault/list` 與 `vault/folders` —— 那會讓
 *    另一台裝置的同步無聲地把期限一直往後推。
 */
const LOCK = readFileSync('src/background/vault-lock.ts', 'utf8');
const INDEX = readFileSync('src/background/index.ts', 'utf8');
const HOOK = readFileSync('src/sidebar/hooks/useVault.ts', 'utf8');

/** 取出 `serve({ ... })` 裡某一則訊息的 handler 那一段文字。 */
function handlerOf(kind: string): string {
  const start = INDEX.indexOf(`'${kind}':`);
  expect(start, `index.ts 裡找不到 ${kind} 的 handler`).toBeGreaterThan(-1);
  // 到下一個 'xxx/yyy': 為止。夠用了：handler 都是連續列出來的
  const rest = INDEX.slice(start + kind.length + 3);
  const next = /\n {2}'[a-z-]+\/[a-z-]+':/.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

describe('自動上鎖：期限只能被使用者的操作推回去', () => {
  it('vault-lock.ts 真的有一個以閒置時間決定上鎖的檢查（防止這個檢查悄悄失效）', () => {
    expect(LOCK).toContain('noteVaultActivity');
    expect(LOCK).toMatch(/autoLockMinutes \* 60_000/);
    // 系統閒置那一道要留著：它涵蓋的是「人離開電腦了」
    expect(LOCK).toContain('browser.idle.onStateChanged');
  });

  it('心跳（ping）不算使用者活動 —— port 訊息必須先分辨 type', () => {
    const listener = /port\.onMessage\.addListener\(([\s\S]*?)\n {4}\}\);/.exec(LOCK);
    expect(listener, 'vault-lock.ts 裡找不到 port.onMessage 的 listener').not.toBeNull();
    const body = listener?.[1] ?? '';
    expect(body).toContain('noteVaultActivity');
    // 關鍵：必須有 'activity' 的判斷把 ping 擋在外面。
    // 少了它就等於「收到任何 port 訊息都算活動」，心跳會讓期限永遠不到。
    expect(body).toContain("'activity'");
  });

  it('UI 的心跳送的是 ping 而不是 activity', () => {
    const heartbeat = /const heartbeat = setInterval\(([\s\S]*?)\}, KEEPALIVE_PING_MS\);/.exec(HOOK);
    expect(heartbeat, 'useVault.ts 裡找不到心跳').not.toBeNull();
    const body = heartbeat?.[1] ?? '';
    expect(body).toContain("type: 'ping'");
    expect(body).not.toContain('activity');
  });

  it('UI 只在隱私空間那一頁前景時才回報活動', () => {
    // 在書籤那一頁翻書籤不該延後隱私空間的自動上鎖
    expect(HOOK).toContain('vaultInView');
    const effect = /if \(status !== 'unlocked' \|\| !vaultInView\) \{/.exec(HOOK);
    expect(effect, '回報活動的 effect 必須同時看 status 與 vaultInView').not.toBeNull();
  });

  it('讀取類的 vault 訊息不記活動', () => {
    // 這些會在沒有人操作時發生：vault/changed 廣播後 UI 自動重讀、
    // 捲動時 VaultThumb 逐張取圖、UI 回到前景時重問狀態。
    for (const kind of ['vault/state', 'vault/list', 'vault/folders', 'vault/thumb', 'vault/sync-status']) {
      const body = handlerOf(kind);
      expect(body, `${kind} 不該被 acted() 包起來`).not.toContain('acted(');
      expect(body, `${kind} 不該記活動`).not.toContain('noteVaultActivity');
      expect(body, `${kind} 不該廣播狀態（announceVault 會記活動）`).not.toContain('announceVault');
    }
  });

  it('會改動隱私空間的訊息都記活動', () => {
    // announceVault() 自己會記一次，所以走它的那些不必額外包 acted()
    const mutations = [
      'vault/folder-create',
      'vault/folder-rename',
      'vault/folder-delete',
      'vault/folder-move',
      'vault/move',
      'vault/move-many',
      'vault/backfill',
      'vault/refresh-thumb',
      'vault/import',
      'vault/import-many',
      'vault/remove',
      'vault/export',
    ];
    const missing = mutations.filter((kind) => {
      const body = handlerOf(kind);
      return !body.includes('acted(') && !body.includes('announceVault');
    });
    expect(missing).toEqual([]);
  });
});
