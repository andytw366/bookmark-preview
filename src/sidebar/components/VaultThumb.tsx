import { useEffect, useState } from 'react';
import { request, subscribe } from '@/shared/messages';
import { vaultThumbKey } from '@/shared/url';
import { ThumbImage } from './Thumb';
import {
  holdThumb,
  peekThumb,
  releaseThumb,
  storeThumb,
  type CachedImage,
} from '../lib/thumb-cache';

interface VaultThumbProps {
  id: string;
  hostname: string;
}

/**
 * 隱私書籤的縮圖。
 *
 * 這裡不能像一般書籤那樣直接讀 IndexedDB —— 那裡存的是密文，
 * 解密金鑰只在背景頁記憶體。所以向背景頁索取明文位元組，
 * 在側邊欄組成 object URL，明文全程不落地。
 */
export function VaultThumb({ id, hostname }: VaultThumbProps) {
  // 與一般書籤同一套快取，理由也一樣：虛擬滾動之後捲回去的那一列不該閃一下色卡。
  // 這邊的代價更高 —— 每次重讀都是一次跨 context 的訊息往返加一次解密。
  const [loaded, setLoaded] = useState<CachedImage | null>(
    () => peekThumb(vaultThumbKey(id)) ?? null,
  );

  useEffect(() => {
    let cancelled = false;
    const key = vaultThumbKey(id);
    const cached = holdThumb(key);
    if (cached !== undefined) {
      setLoaded(cached);
    }

    const load = (): void => {
      void request('vault/thumb', { id }).then(
        (payload) => {
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
          setLoaded(image);
        },
        () => undefined,
      );
    };

    if (cached === undefined) {
      load();
    }

    /*
     * 訂閱更新。少了這一段的話：補抓與右鍵「重新抓預覽圖」都確實把加密縮圖
     * 寫進去了，也廣播了，但這個元件只在掛載時取過一次 —— 畫面永遠停在舊圖
     * （或色卡），看起來像抓取失敗。一般書籤那邊由 `useThumb` 訂閱，
     * 隱私書籤這條路當初漏掉了。
     *
     * 作廢快取不在這裡做，由 `thumb-cache` 自己訂閱同一則廣播 —— 這裡的訂閱只在
     * 掛載中有效，而快取活得比元件久（見那邊的說明）。這一段管的是「重繪」。
     */
    const unsubscribe = subscribe('thumbs/updated', (payload) => {
      if (payload.key === key) {
        load();
      }
    });

    // 「清除所有預覽圖」是一次清空，不會逐一廣播 thumbs/updated
    const unsubscribeCleared = subscribe('thumbs/cleared', () => {
      load();
    });

    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeCleared();
      releaseThumb(key);
    };
  }, [id]);

  return <ThumbImage image={loaded} hostname={hostname} />;
}
