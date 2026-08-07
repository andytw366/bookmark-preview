import { useEffect, useState } from 'react';
import { request, subscribe, type ThumbPayload } from '@/shared/messages';
import { urlKey } from '@/shared/url';
import { getThumb } from '@/storage/thumbs-db';
import {
  holdThumb,
  invalidateThumb,
  knownDigest,
  peekThumb,
  rememberDigest,
  releaseThumb,
  storeThumb,
  type CachedImage,
} from '../lib/thumb-cache';

export type LoadedThumb = CachedImage;

/**
 * 無痕視窗的擴充套件頁面拿到的是**另一個、空的 IndexedDB**。
 *
 * 直接讀資料庫的快路徑在那裡永遠讀到 undefined —— 縮圖確實抓到並寫進背景頁
 * 那一份了，畫面卻只有色卡，看起來像抓取失敗。隱私書籤的縮圖反而正常，
 * 因為那條路本來就是向背景頁索取位元組。
 *
 * 只在無痕視窗改走訊息：一般視窗維持直接讀取，省下每張圖的序列化來回。
 */
const NEEDS_MESSAGING = browser.extension.inIncognitoContext;

async function readThumb(key: string): Promise<ThumbPayload | null> {
  if (NEEDS_MESSAGING) {
    try {
      return await request('thumbs/get', { key });
    } catch {
      return null;
    }
  }
  const record = await getThumb(key);
  // 加密的縮圖（隱私書籤）在這裡一律視為沒有縮圖 —— 解密金鑰只存在
  // 背景頁記憶體，要透過訊息取得明文，那是 VaultThumb 的事。
  if (record === undefined || record.encrypted) {
    return null;
  }
  return {
    bytes: record.bytes,
    mime: record.mime,
    width: record.width,
    height: record.height,
    source: record.source,
  };
}

/**
 * 讀取某個書籤的縮圖。
 *
 * 側邊欄直接讀 IndexedDB 而不透過訊息向背景頁索取圖片：兩者同屬一個
 * 擴充套件 origin，共用同一個資料庫，省掉每張圖的序列化來回。
 *
 * 一併回傳原始尺寸，讓卡片能採用圖片自己的長寬比 —— 封面圖是直式的，
 * 硬套 16:9 會把它裁成一條。
 *
 * **結果放在模組層的快取裡**（`lib/thumb-cache.ts`）。虛擬滾動之後捲動會不停
 * 掛載／卸載同一批列，沒有快取的話捲回去的每一列都會先閃一下色卡再換成圖 ——
 * 實測捲動一小段就重讀了數百次。
 */
export function useThumb(url: string): LoadedThumb | null {
  /*
   * 已經在快取裡就同步拿到。
   *
   * 這是「捲回去不閃」的關鍵：圖要在**第一次繪製時就在**，而不是繪製完了再補上。
   * 只要慢一拍，那一格就會先出現色卡。
   */
  const [thumb, setThumb] = useState<LoadedThumb | null>(() => {
    const key = knownDigest(url);
    return key === undefined ? null : (peekThumb(key) ?? null);
  });

  useEffect(() => {
    let cancelled = false;
    /** 這個元件目前佔用的 key，卸載時要還回去 */
    let held: string | null = null;

    const load = async (): Promise<void> => {
      let key = knownDigest(url);
      if (key === undefined) {
        key = await urlKey(url);
        rememberDigest(url, key);
      }
      if (cancelled) {
        return;
      }
      if (held === null) {
        held = key;
        const cached = holdThumb(key);
        if (cached !== undefined) {
          setThumb(cached);
          return;
        }
      }

      const payload = await readThumb(key);
      if (cancelled) {
        return;
      }
      const image: CachedImage | null =
        payload === null
          ? null
          : {
              src: URL.createObjectURL(new Blob([payload.bytes], { type: payload.mime })),
              width: payload.width,
              height: payload.height,
              source: payload.source,
            };
      storeThumb(key, image);
      setThumb(image);
    };

    void load();

    const unsubscribe = subscribe('thumbs/updated', (payload) => {
      // key 還沒算出來時無法比對，那就一律重讀 —— 這個視窗很短（一個
      // microtask 加一次 IndexedDB 讀取），但重抓速度快時廣播真的可能落在裡面，
      // 而丟掉那則通知的後果就是預覽圖永遠不更新。重讀的成本遠低於漏掉。
      const key = knownDigest(url);
      if (key !== undefined && payload.key !== key) {
        return;
      }
      if (key !== undefined) {
        invalidateThumb(key);
      }
      void load();
    });

    return () => {
      cancelled = true;
      unsubscribe();
      if (held !== null) {
        releaseThumb(held);
      }
    };
  }, [url]);

  return thumb;
}
