import { describe, expect, it } from 'vitest';
import { isEntryUrl, isSamePage } from '@/shared/url';

/**
 * 「這個網址現在有沒有開著」的判準。
 *
 * 這一組測試的由來：原本是用 `tabs.query({ url })` 找分頁，而 match pattern 有
 * 兩個硬性限制 —— 主機不能帶連接埠、路徑不能省略。實測連續踩到兩次：
 * `https://news.ycombinator.com/`（去掉尾端斜線就沒有路徑）與
 * `http://127.0.0.1:8899/`（帶連接埠）都會讓 `tabs.query` 丟
 * `Invalid url pattern`，於是「重新抓預覽圖」對這些網址永遠失敗，
 * 而且一般書籤那條路會在丟例外之前就先把舊縮圖刪掉。
 *
 * 改成把分頁全部拿回來、用這個函式自己比對，就沒有語法上的地雷了。
 */
describe('isSamePage', () => {
  it('尾端斜線的差異不算不同頁', () => {
    expect(isSamePage('https://example.com', 'https://example.com/')).toBe(true);
  });

  it('fragment 不算不同頁', () => {
    expect(isSamePage('https://example.com/a#top', 'https://example.com/a')).toBe(true);
  });

  it('主機名大小寫不算不同頁', () => {
    expect(isSamePage('https://Example.COM/a', 'https://example.com/a')).toBe(true);
  });

  it('帶連接埠的網址比得出來（match pattern 做不到的那一種）', () => {
    expect(isSamePage('http://127.0.0.1:8899/', 'http://127.0.0.1:8899')).toBe(true);
    expect(isSamePage('http://127.0.0.1:8899/', 'http://127.0.0.1:8898/')).toBe(false);
  });

  it('不同路徑就是不同頁', () => {
    expect(isSamePage('https://example.com/a', 'https://example.com/b')).toBe(false);
  });

  it('查詢字串有差就是不同頁（?id=1 與 ?id=2 是兩本書）', () => {
    expect(isSamePage('https://example.com/v?id=1', 'https://example.com/v?id=2')).toBe(false);
  });
});

/**
 * 「入口網址」：書籤指的是一個網站／App，預覽改用網站圖示。
 * 判準只看形狀（路徑最多一層、沒有 query），例子都是 NEXT.md 定案時列的。
 */
describe('isEntryUrl', () => {
  it.each([
    'https://www.google.com.tw/maps',
    'https://google.com/maps',
    'https://drive.google.com',
    'https://www.youtube.com/',
    'https://twitch.tv',
    'https://www.reddit.com/',
    'https://example.com/#section',
    // 使用者接受的誤判：一層的個人頁
    'https://x.com/someone',
    'https://github.com/someone',
  ])('%s 是入口', (url) => {
    expect(isEntryUrl(url)).toBe(true);
  });

  it.each([
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://github.com/u/repo',
    'https://example.com/comic/123/chapter-4',
    'https://developer.mozilla.org/en-US/docs/Web/API',
    // 抓不到的：三層路徑，留給手動切換
    'https://mail.google.com/mail/u/0/',
    'https://example.com/?q=1',
  ])('%s 不是入口', (url) => {
    expect(isEntryUrl(url)).toBe(false);
  });

  it('解析不了或不是網頁協定就不是', () => {
    expect(isEntryUrl('not a url')).toBe(false);
    expect(isEntryUrl('about:blank')).toBe(false);
    expect(isEntryUrl('javascript:void(0)')).toBe(false);
  });
});
