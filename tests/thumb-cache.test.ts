import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 縮圖快取。
 *
 * 這裡真正危險的是**撤銷了還在顯示的 object URL** —— 那會讓畫面出現破圖，
 * 而且只在快取剛好裝滿、又剛好淘汰到正在看的那一張時才發生。手動測不出來，
 * 所以把「佔用中的不准淘汰」寫成測試。
 *
 * 模組狀態是全域的（就是重點：跨元件共用），每個案例前重新載入一次。
 */
type Cache = typeof import('@/sidebar/lib/thumb-cache');
type Messages = typeof import('@/shared/messages');

let cache: Cache;
let messages: Messages;
let revoked: string[];
let listeners: ((message: unknown) => unknown)[];

beforeEach(async () => {
  revoked = [];
  listeners = [];
  // 只換掉這一個方法：整個 URL 換成物件字面量會讓它不再是建構子
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((src: string) => {
    revoked.push(src);
  });
  /*
   * 假的 `browser.runtime`：`sendMessage` 直接把訊息交給註冊的監聽器。
   *
   * 這樣就能走**真的**協定（`broadcast` → 信封 → `subscribe`）而不是在測試裡
   * 手抄一份信封格式 —— 抄的那份漂走時，測試會繼續全綠。
   */
  vi.stubGlobal('browser', {
    runtime: {
      onMessage: {
        addListener: (fn: (message: unknown) => unknown) => {
          listeners.push(fn);
        },
        removeListener: (fn: (message: unknown) => unknown) => {
          listeners = listeners.filter((each) => each !== fn);
        },
      },
      sendMessage: (message: unknown) => {
        for (const fn of [...listeners]) {
          fn(message);
        }
        return Promise.resolve(undefined);
      },
    },
  });
  vi.resetModules();
  // 順序有意義：thumb-cache 在 import 時就掛上它的監聽器，要先有上面那個 stub
  cache = await import('@/sidebar/lib/thumb-cache');
  messages = await import('@/shared/messages');
});

const image = (src: string) => ({ src, width: 320, height: 180, source: 'capture' as const });

describe('縮圖快取', () => {
  it('存進去之後 peek 拿得到 —— 這就是「捲回去不閃」的來源', () => {
    cache.storeThumb('a', image('blob:a'));
    expect(cache.peekThumb('a')).toEqual(image('blob:a'));
  });

  it('「查過了、沒有縮圖」與「還沒查過」是兩件事', () => {
    expect(cache.peekThumb('never')).toBeUndefined();
    cache.storeThumb('none', null);
    expect(cache.peekThumb('none')).toBeNull();
  });

  it('hold 對還沒讀過的 key 回傳 undefined，呼叫端才知道要自己去讀', () => {
    expect(cache.holdThumb('fresh')).toBeUndefined();
  });

  it('hold 對已經讀過的 key 直接回傳內容', () => {
    cache.storeThumb('a', image('blob:a'));
    expect(cache.holdThumb('a')).toEqual(image('blob:a'));
  });

  describe('淘汰', () => {
    /** 塞滿到超過上限（300），全部都沒有人在用 */
    const fill = (count: number): void => {
      for (let i = 0; i < count; i += 1) {
        cache.storeThumb(`fill-${String(i)}`, image(`blob:fill-${String(i)}`));
      }
    };

    it('超過上限就淘汰最久沒用到的，並撤銷它的 object URL', () => {
      fill(320);
      expect(revoked.length).toBeGreaterThan(0);
      // 最早存進去的那幾筆該不見了
      expect(cache.peekThumb('fill-0')).toBeUndefined();
      expect(cache.peekThumb('fill-319')).toEqual(image('blob:fill-319'));
    });

    it('正在被使用的項目不會被淘汰 —— 撤銷它會讓畫面出現破圖', () => {
      cache.storeThumb('watched', image('blob:watched'));
      cache.holdThumb('watched');
      fill(400);
      expect(cache.peekThumb('watched')).toEqual(image('blob:watched'));
      expect(revoked).not.toContain('blob:watched');
    });

    it('放開之後就可以被淘汰了', () => {
      cache.storeThumb('watched', image('blob:watched'));
      cache.holdThumb('watched');
      cache.releaseThumb('watched');
      fill(400);
      expect(cache.peekThumb('watched')).toBeUndefined();
    });
  });

  describe('內容換掉（補抓、重新抓）', () => {
    it('標記過時之後 peek 拿不到，呼叫端才會重新去讀', () => {
      cache.storeThumb('a', image('blob:old'));
      cache.invalidateThumb('a');
      expect(cache.peekThumb('a')).toBeUndefined();
    });

    it('舊圖先留著不撤銷 —— 正在顯示它的那一列還沒重繪', () => {
      cache.storeThumb('a', image('blob:old'));
      cache.invalidateThumb('a');
      expect(revoked).not.toContain('blob:old');
    });

    it('新的存進來時才撤銷舊的', () => {
      cache.storeThumb('a', image('blob:old'));
      cache.invalidateThumb('a');
      cache.storeThumb('a', image('blob:new'));
      expect(revoked).toContain('blob:old');
      expect(cache.peekThumb('a')).toEqual(image('blob:new'));
    });

    it('過時不會弄丟佔用數 —— 同一個網址可能有兩列同時在顯示', () => {
      cache.storeThumb('a', image('blob:old'));
      cache.holdThumb('a');
      cache.holdThumb('a');
      cache.invalidateThumb('a');
      cache.storeThumb('a', image('blob:new'));
      // 只有一邊卸載時，另一邊還在看，不能被淘汰
      cache.releaseThumb('a');
      for (let i = 0; i < 400; i += 1) {
        cache.storeThumb(`fill-${String(i)}`, image(`blob:fill-${String(i)}`));
      }
      expect(cache.peekThumb('a')).toEqual(image('blob:new'));
    });
  });

  describe('清除所有預覽圖', () => {
    it('全部標記過時 —— 否則設定頁清空之後，開著的側邊欄還在顯示已經不存在的圖', () => {
      cache.storeThumb('a', image('blob:a'));
      cache.storeThumb('b', image('blob:b'));
      expect(cache.peekThumb('a')).toEqual(image('blob:a'));

      cache.invalidateAllThumbs();

      // undefined 是「要重讀一次」，與 null（讀過了、沒有縮圖）不同
      expect(cache.peekThumb('a')).toBeUndefined();
      expect(cache.peekThumb('b')).toBeUndefined();
    });

    it('不立刻撤銷 object URL —— 正在顯示的那幾列還沒重繪，撤銷會出現破圖', () => {
      cache.storeThumb('a', image('blob:a'));
      cache.holdThumb('a');
      cache.invalidateAllThumbs();
      expect(revoked).not.toContain('blob:a');
      // 重讀之後才換掉（這次讀到的是「沒有縮圖」）
      cache.storeThumb('a', null);
      expect(revoked).toContain('blob:a');
      expect(cache.peekThumb('a')).toBeNull();
    });
  });

  /**
   * 作廢要和快取同一層。
   *
   * 這幾條釘的是一個**不會有任何錯誤**的缺陷：作廢原本靠元件在 `useEffect` 裡訂閱，
   * 只有掛載中的那幾列聽得到。於是「看過那一列 → 捲走 → 補抓成功 → 再看那一列」
   * 會停在色卡上，因為快取裡那筆「這個書籤沒有縮圖」沒有人去作廢，而呼叫端一命中
   * 快取就不讀 IndexedDB 了。圖在資料庫裡，畫面上沒有，關掉側邊欄重開才會出現。
   *
   * 所以這裡刻意**不掛任何元件**，只發廣播。
   */
  describe('廣播來的作廢（不依賴任何元件掛載中）', () => {
    it('沒有人在用那個 key 時，補抓的廣播照樣讓它過時', () => {
      // 「查過了、這個書籤沒有縮圖」—— 缺陷卡住的就是這一筆
      cache.storeThumb('a', null);
      expect(cache.peekThumb('a')).toBeNull();

      messages.broadcast('thumbs/updated', { key: 'a' });

      // undefined 是「要重讀一次」。留成 null 的話呼叫端會判定「快取有答案」
      expect(cache.peekThumb('a')).toBeUndefined();
    });

    it('已經有圖的那筆也一樣會過時 —— 補抓可能換成另一張', () => {
      cache.storeThumb('a', image('blob:old'));
      messages.broadcast('thumbs/updated', { key: 'a' });
      expect(cache.peekThumb('a')).toBeUndefined();
    });

    it('只動廣播指名的那個 key —— 一則通知不該讓整份快取重讀', () => {
      cache.storeThumb('a', image('blob:a'));
      cache.storeThumb('b', image('blob:b'));

      messages.broadcast('thumbs/updated', { key: 'a' });

      expect(cache.peekThumb('a')).toBeUndefined();
      expect(cache.peekThumb('b')).toEqual(image('blob:b'));
    });

    it('「清除所有預覽圖」的廣播讓全部過時', () => {
      cache.storeThumb('a', image('blob:a'));
      cache.storeThumb('b', null);

      messages.broadcast('thumbs/cleared', undefined);

      expect(cache.peekThumb('a')).toBeUndefined();
      expect(cache.peekThumb('b')).toBeUndefined();
    });

    it('不撤銷正在顯示的 object URL —— 那一列還沒重繪，撤銷就是破圖', () => {
      cache.storeThumb('a', image('blob:a'));
      cache.holdThumb('a');

      messages.broadcast('thumbs/updated', { key: 'a' });

      expect(revoked).not.toContain('blob:a');
    });

    it('不是自己的訊息一概不理 —— 兩個 channel 都掛在同一個 onMessage 上', () => {
      cache.storeThumb('a', image('blob:a'));
      // 請求（不是事件）與別的事件都不該碰到快取
      messages.broadcast('bookmarks/invalidated', undefined);
      expect(cache.peekThumb('a')).toEqual(image('blob:a'));
    });
  });

  describe('網址 → SHA 鍵的對照', () => {
    it('記住之後就不必再算一次 —— 雜湊是非同步的，重算會讓快取慢一拍才生效', () => {
      expect(cache.knownDigest('https://example.test/')).toBeUndefined();
      cache.rememberDigest('https://example.test/', 'abc123');
      expect(cache.knownDigest('https://example.test/')).toBe('abc123');
    });
  });
});
