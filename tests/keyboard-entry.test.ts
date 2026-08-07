import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 靜態檢查：右鍵選單一律走 `contextMenuHandlers()`。
 *
 * 那個函式做的是「用鍵盤叫出來的 `contextmenu` 沒有游標位置，改用該元素的
 * 邊界」。少了它，選單鍵與 Shift+F10 仍然會開選單，但會開在畫面左上角 ——
 * 而**用滑鼠測完全看不出來**，只有把手從滑鼠上拿開才會發現。新增一種列或
 * 卡片時，順手複製一個 `onContextMenu={(event) => …}` 又是最自然的寫法。
 *
 * 元件之間往上傳遞的那個 `onContextMenu` 回呼不受這條規則管 —— 它收的是
 * (node, x, y)，不是事件。
 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

describe('右鍵選單的鍵盤入口', () => {
  it('沒有任何地方直接掛 DOM 的 contextmenu 處理器', () => {
    const offenders = sourceFiles('src')
      .filter((file) => /onContextMenu=\{\s*\(\s*event/.test(readFileSync(file, 'utf8')))
      .map((file) => `${file}（改用 contextMenuHandlers()）`);
    expect(offenders).toEqual([]);
  });

  it('用得到選單的畫面都引入了那個共用函式（確認上面那條不是因為找不到東西才通過）', () => {
    const users = sourceFiles('src').filter((file) =>
      readFileSync(file, 'utf8').includes('contextMenuHandlers('),
    );
    // 側邊欄的列、隱私空間的列、全頁瀏覽的卡片
    expect(users.length).toBeGreaterThanOrEqual(3);
  });
});
