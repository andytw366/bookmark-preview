import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { POSTER_KEYS, fromText, fromUrl } from '@/shared/cover-params';
import { JSON_LD_KEYS, imagesInJsonLd } from '@/shared/json-ld';

/**
 * 嵌入式播放器的封面參數。
 *
 * 這一層排在 og:image 之上，而它正是「補抓抓到站台 logo、擷取抓到影片封面」那個
 * 缺陷的核心：擷取看得到渲染後的 `iframe[src]`，補抓只有原始 HTML。
 */
describe('fromUrl（擷取那條路：渲染後的 iframe src）', () => {
  it('取出封面參數', () => {
    expect(fromUrl('https://player.example/e/ABC?poster=https://cdn.example/cover.jpg')).toEqual([
      'https://cdn.example/cover.jpg',
    ]);
  });

  it('相對網址用 base 解析', () => {
    expect(fromUrl('/e/ABC?thumbnail=https://cdn.example/c.jpg', 'https://site.example/v/1')).toEqual([
      'https://cdn.example/c.jpg',
    ]);
  });

  /** 值必須是絕對網址。少了這道檢查，`?image=1` 這種同名但無關的參數會被當成封面。 */
  it('值不是絕對網址就不算', () => {
    expect(fromUrl('https://player.example/e/ABC?image=1')).toEqual([]);
    expect(fromUrl('https://player.example/e/ABC?poster=/relative.jpg')).toEqual([]);
  });

  it('不是網址就回空陣列，不丟例外', () => {
    expect(fromUrl('這不是網址')).toEqual([]);
  });
});

describe('fromText（補抓那條路：原始 HTML）', () => {
  /**
   * 真實案例的形狀（123av.com）。那個 iframe 寫的是 `:src="currentEpisode?.url"`
   * —— 框架綁定，屬性上沒有網址；播放器網址連同 poster 參數被序列化進一段 JSON，
   * `"` 跳脫成 `"`、poster 的值整個 URL 編碼過。
   *
   * **這一條就是整個修正的理由**：解析 `iframe[src]` 在這種頁面上什麼都拿不到。
   */
  it('抓得到序列化進 JSON、且 URL 編碼過的 poster', () => {
    const html = String.raw`<div data-page="[{"url":"https:\/\/player.example\/e\/9N28?poster=https%3A%2F%2Fcdn.example%2Fs500%2Fcover.jpg%3Fv1"}]"></div>`;
    expect(fromText(html)).toEqual(['https://cdn.example/s500/cover.jpg?v1']);
  });

  /**
   * 參數不是第一個時，前面的 `&` 在 HTML 屬性裡是 `&amp;`、在 JS 字串裡是 `&`。
   * 只認 `[?&]` 的話兩種都會整個漏掉 —— 真實案例剛好是 `?poster=`（排第一）才躲過，
   * 是 `embed-spa.html` 那個 fixture 把這個缺口挖出來的。
   */
  it('分隔符被編碼過也認得', () => {
    const entity = '<div data-page="{&quot;url&quot;:&quot;/p?id=1&amp;poster=http%3A%2F%2Fcdn.example%2Fc.png&quot;}"></div>';
    expect(fromText(entity)).toEqual(['http://cdn.example/c.png']);

    const jsEscaped = String.raw`<script>var u = "/p?id=1&poster=http%3A%2F%2Fcdn.example%2Fj.png";</script>`;
    expect(fromText(jsEscaped)).toEqual(['http://cdn.example/j.png']);
  });

  it('也抓得到沒有編碼、直接寫在屬性裡的', () => {
    const html = '<iframe src="https://player.example/e/9N28?poster=https://cdn.example/cover.jpg"></iframe>';
    expect(fromText(html)).toEqual(['https://cdn.example/cover.jpg']);
  });

  /**
   * 精確度：同一頁上的推薦列表有一堆 `cover.jpg`，但它們是普通的 `<img src>`，
   * 不帶封面參數。真實案例數過 —— 整份 HTML 只有一個符合的參數，而 12 張推薦縮圖
   * 一個都沒被誤選。這一條把那個性質釘住。
   */
  it('不會把普通的 img src 當成封面參數', () => {
    const html = `
      <img src="https://cdn.example/s360/other-1/cover.jpg">
      <img src="https://cdn.example/s360/other-2/cover.jpg">
      <iframe src="https://player.example/e/9N28?poster=https://cdn.example/s500/mine/cover.jpg"></iframe>
    `;
    expect(fromText(html)).toEqual(['https://cdn.example/s500/mine/cover.jpg']);
  });

  it('重複的只留一個，依出現順序', () => {
    const html =
      '<a href="?poster=https://cdn.example/a.jpg"></a><a href="?thumb=https://cdn.example/b.jpg"></a>' +
      '<a href="?poster=https://cdn.example/a.jpg"></a>';
    expect(fromText(html)).toEqual(['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg']);
  });

  it('壞掉的百分號編碼不會讓整頁失敗', () => {
    expect(() => fromText('<a href="?poster=https://cdn.example/%zz.jpg">')).not.toThrow();
  });

  it('沒有封面參數的頁面回空陣列', () => {
    expect(fromText('<meta property="og:image" content="https://site.example/logo.png">')).toEqual([]);
  });
});

/**
 * 靜態檢查：`cover.ts` 裡那份複製的 `POSTER_KEYS` 要與這裡一致。
 *
 * 它**必須**複製一份 —— `collectCoverCandidates` 是用 `executeScript({ func })`
 * 序列化注入頁面執行的，被序列化的函式看不到任何模組層的 import。
 *
 * 兩份漂走的症狀很難查：兩條路會對「什麼是封面參數」有不同意見，表現成「某些站台
 * 補抓抓不到、開著分頁卻抓得到」，而型別檢查與其他測試全綠。
 */
describe('cover.ts 的那份複製', () => {
  it('與 shared/cover-params 的清單一致', () => {
    const source = readFileSync('src/background/cover.ts', 'utf8');
    const match = /const POSTER_KEYS = \[([^\]]*)\]/.exec(source);
    expect(match, 'cover.ts 裡找不到 POSTER_KEYS').not.toBeNull();
    const inline = [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(inline).toEqual(POSTER_KEYS);
  });

  it('cover.ts 仍然零 import（注入的函式不能有模組相依）', () => {
    const source = readFileSync('src/background/cover.ts', 'utf8');
    expect(source.split('\n').filter((line) => line.startsWith('import '))).toEqual([]);
  });

  it('JSON-LD 的欄位清單也與 shared/json-ld 一致', () => {
    const source = readFileSync('src/background/cover.ts', 'utf8');
    const match = /const KEYS = \[([^\]]*)\]/.exec(source);
    expect(match, 'cover.ts 裡找不到 JSON-LD 的 KEYS').not.toBeNull();
    const inline = [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((item) => item[1]);
    expect(inline).toEqual(JSON_LD_KEYS);
  });
});

describe('JSON-LD 裡的圖片', () => {
  it('取出常見欄位', () => {
    expect(imagesInJsonLd('{"thumbnailUrl":"https://cdn.example/t.jpg"}')).toEqual([
      'https://cdn.example/t.jpg',
    ]);
  });

  /** `@graph` 與陣列都是實際會遇到的形狀，寫死路徑就只支援自己看過的那幾種。 */
  it('走得進 @graph 與陣列', () => {
    const text = JSON.stringify({
      '@graph': [
        { '@type': 'VideoObject', image: ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'] },
      ],
    });
    expect(imagesInJsonLd(text)).toEqual(['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg']);
  });

  it('陣列裡的物件不會被當成網址收進去', () => {
    const text = JSON.stringify({
      image: [{ url: 'https://cdn.example/o.jpg' }, 'https://cdn.example/s.jpg'],
    });
    expect(imagesInJsonLd(text)).toEqual(['https://cdn.example/s.jpg']);
  });

  /** 壞掉的 JSON-LD 很常見，不該讓它把整條補抓路徑弄掉。 */
  it('解析失敗就當這一塊不存在', () => {
    expect(imagesInJsonLd('{"image": "x",}')).toEqual([]);
    expect(imagesInJsonLd(null)).toEqual([]);
    expect(imagesInJsonLd('   ')).toEqual([]);
  });

  it('深度有上限，不會被巢很深的資料拖住', () => {
    let node: unknown = { thumbnailUrl: 'https://cdn.example/deep.jpg' };
    for (let index = 0; index < 30; index += 1) {
      node = { nested: node };
    }
    expect(imagesInJsonLd(JSON.stringify(node))).toEqual([]);
  });
});
