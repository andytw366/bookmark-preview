import type { CSSProperties } from 'react';
import { hueFromString, initialOf } from '@/shared/url';
import { useThumb } from '../hooks/useThumb';

interface ThumbProps {
  url: string;
  hostname: string;
}

/**
 * 預覽區塊，實作三層 fallback：
 * 內容封面圖 → 網頁截圖 → 網域色卡。
 *
 * 封面圖與截圖的呈現方式刻意不同：
 * - **封面圖**（漫畫／書籍封面、影片縮圖）採用圖片自己的長寬比並完整顯示。
 *   這種圖被裁掉就失去意義，直式封面裁成 16:9 只會剩下最上面一條。
 * - **截圖**統一裁成 16:9 並填滿，讓清單排列整齊。
 */
export function Thumb({ url, hostname }: ThumbProps) {
  const thumb = useThumb(url);
  const hue = hueFromString(hostname);

  if (thumb !== null) {
    const isCover = thumb.source === 'cover' || thumb.source === 'og';
    return (
      <div
        className={`thumb thumb--image ${isCover ? 'thumb--contain' : 'thumb--fill'}`}
        style={isCover ? ({ '--thumb-ratio': `${String(thumb.width)} / ${String(thumb.height)}` } as CSSProperties) : undefined}
      >
        <img src={thumb.src} alt="" loading="lazy" decoding="async" />
      </div>
    );
  }

  return (
    <div
      className="thumb thumb--placeholder"
      style={{ '--thumb-hue': String(hue) } as CSSProperties}
      aria-hidden="true"
    >
      <span className="thumb__initial">{initialOf(hostname)}</span>
    </div>
  );
}

export function FolderThumb() {
  return (
    <div className="thumb thumb--folder" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h9A1.5 1.5 0 0 1 21 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
      </svg>
    </div>
  );
}
