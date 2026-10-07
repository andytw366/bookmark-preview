import { describe, expect, it } from 'vitest';
import {
  VaultTokens,
  folderHash,
  historyEntry,
  historyStep,
  parseFolderHash,
  placeFromHistory,
} from '@/sidebar/lib/gallery-history';

/**
 * 全頁瀏覽的歷史紀錄。
 *
 * 書籤那邊錯了只是「上一頁跳到奇怪的地方」；隱私空間那邊錯了是隱私資訊被
 * session restore 寫到磁碟上 —— 所以「state 與網址裡沒有隱私空間的東西」寫成測試釘住。
 */
describe('#folder= 的解析與產生', () => {
  it('來回一致，含需要編碼的字元', () => {
    for (const id of ['toolbar_____', 'aB3-_x9Qz', 'a b/c#d']) {
      expect(parseFolderHash(folderHash(id))).toBe(id);
    }
  });

  it('最上層不帶 hash', () => {
    expect(folderHash(null)).toBe('');
    expect(parseFolderHash('')).toBeNull();
  });

  it('不認得或壞掉的 hash 當最上層，而不是丟例外', () => {
    expect(parseFolderHash('#something=else')).toBeNull();
    expect(parseFolderHash('#folder=')).toBeNull();
    expect(parseFolderHash('#folder=%E0%A4%A')).toBeNull();
  });
});

describe('push 還是 replace', () => {
  const root = { mode: 'bookmarks', folderId: null } as const;
  const inA = { mode: 'bookmarks', folderId: 'A' } as const;

  it('使用者導覽 push、程式退回 replace', () => {
    expect(historyStep(root, inA, 'user')).toBe('push');
    expect(historyStep(inA, root, 'fallback')).toBe('replace');
  });

  it('目的地就是現在的位置時不寫', () => {
    expect(historyStep(inA, { ...inA }, 'user')).toBe('none');
  });

  it('同一個 id 但換了空間仍然算移動', () => {
    expect(historyStep(root, { mode: 'vault', folderId: null }, 'user')).toBe('push');
  });
});

describe('隱私空間的歷史項目', () => {
  let counter = 0;
  const tokens = () => new VaultTokens(() => `t${String(++counter)}`);

  it('state 只有代號、網址不帶 hash —— 資料夾 id 只在記憶體裡', () => {
    const table = tokens();
    const entry = historyEntry({ mode: 'vault', folderId: 'secret-folder' }, table);
    expect(Object.keys(entry.state)).toEqual(['n']);
    expect(JSON.stringify(entry)).not.toContain('secret-folder');
    expect(JSON.stringify(entry)).not.toContain('vault');
    expect(entry.hash).toBe('');
  });

  it('解鎖中認得自己發的代號', () => {
    const table = tokens();
    const { state } = historyEntry({ mode: 'vault', folderId: 'F' }, table);
    expect(placeFromHistory(state, '', table, true)).toEqual({
      place: { mode: 'vault', folderId: 'F' },
      known: true,
    });
    const rootEntry = historyEntry({ mode: 'vault', folderId: null }, table);
    expect(placeFromHistory(rootEntry.state, '', table, true).place).toEqual({
      mode: 'vault',
      folderId: null,
    });
  });

  it('上鎖（代號表清空）後回到書籤最上層，不是解鎖畫面', () => {
    const table = tokens();
    const { state } = historyEntry({ mode: 'vault', folderId: 'F' }, table);
    table.clear();
    expect(placeFromHistory(state, '', table, true)).toEqual({
      place: { mode: 'bookmarks', folderId: null },
      known: false,
    });
  });

  it('代號還在但已經上鎖，同樣回書籤最上層', () => {
    const table = tokens();
    const { state } = historyEntry({ mode: 'vault', folderId: 'F' }, table);
    expect(placeFromHistory(state, '', table, false).place).toEqual({
      mode: 'bookmarks',
      folderId: null,
    });
  });

  it('重新整理後（新的代號表）不認得舊代號', () => {
    const { state } = historyEntry({ mode: 'vault', folderId: 'F' }, tokens());
    expect(placeFromHistory(state, '', tokens(), true).known).toBe(false);
  });
});

describe('書籤的歷史項目', () => {
  it('以網址的 hash 為準 —— 使用者手改網址列也有效', () => {
    const table = new VaultTokens();
    expect(placeFromHistory({ f: 'A' }, '#folder=B', table, false).place).toEqual({
      mode: 'bookmarks',
      folderId: 'B',
    });
    expect(placeFromHistory(null, '', table, false).place).toEqual({
      mode: 'bookmarks',
      folderId: null,
    });
  });

  it('寫出來的項目帶 hash 與 { f }', () => {
    expect(historyEntry({ mode: 'bookmarks', folderId: 'A' }, new VaultTokens())).toEqual({
      state: { f: 'A' },
      hash: '#folder=A',
    });
  });
});
