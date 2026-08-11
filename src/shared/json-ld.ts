/**
 * JSON-LD（schema.org）裡宣告的圖片網址。
 *
 * 封面判定的第三層（`cover.ts` 給 950，在 og:image 之下、`<video poster>` 之上）。
 * 抽成純函式是為了測得到 —— `og-fetcher.ts` 一路連到 `browser.storage`，
 * 在 vitest 裡 import 不起來。
 *
 * `cover.ts` 有自己的一份（它是被序列化注入頁面的，不能有任何 import），
 * `tests/cover-params.test.ts` 靜態檢查兩邊的欄位清單一致。
 */
export const JSON_LD_KEYS = ['thumbnailUrl', 'image', 'poster', 'contentUrl'];

/** 巢狀深度上限。`@graph` 之類巢個兩三層是常態，8 層綽綽有餘而且擋得住惡意的深樹。 */
const MAX_DEPTH = 8;

/**
 * 走整棵樹，不只看幾個固定路徑。
 *
 * schema.org 的封面可能包在 `@graph`、陣列、或 `VideoObject` 底下，站台之間差異很大；
 * 寫死路徑等於只支援自己看過的那幾種。
 *
 * **壞掉的 JSON-LD 很常見**（多一個逗號、把 HTML 註解寫進去），解析失敗就當這一塊
 * 不存在 —— 不該讓一段爛標記把整條補抓路徑弄掉。
 */
export function imagesInJsonLd(text: string | null | undefined): string[] {
  if (text === null || text === undefined || text.trim() === '') {
    return [];
  }
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return [];
  }

  const found: string[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || node === null || typeof node !== 'object') {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item, depth + 1);
      }
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (JSON_LD_KEYS.includes(key)) {
        if (typeof value === 'string') {
          found.push(value);
        } else if (Array.isArray(value)) {
          // `image` 可以是字串、字串陣列，或 ImageObject 陣列 —— 字串的直接收，
          // 物件的交給下面的 walk（它的 url 欄位不在我們的清單裡，但巢狀的
          // thumbnailUrl 會被收到）
          found.push(...value.filter((item): item is string => typeof item === 'string'));
        }
      }
      walk(value, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}
