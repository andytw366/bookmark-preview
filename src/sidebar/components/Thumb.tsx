import type { CSSProperties } from 'react';
import { letterColor } from '@/shared/letter-color';
import { initialOf } from '@/shared/url';
import { Icon } from '../../ui/Icon';
import { useThumb } from '../hooks/useThumb';
import type { CachedImage } from '../lib/thumb-cache';

interface ThumbProps {
  url: string;
  hostname: string;
}

/**
 * 預覽圖：內容封面圖 → 網頁截圖 → 字母色卡，入口網址另有網站圖示。
 *
 * 四種都放進同一個底板（`.thumb`），底板的大小由版面決定（大卡 16:9、小列 40×40），
 * 這裡只決定圖怎麼放進去：
 * - **封面圖**（漫畫／書籍封面、影片縮圖）完整顯示不裁切，兩側露出底板 —— 直式封面裁成
 *   16:9 只會剩下最上面一條。
 * - **截圖**裁成底板的比例並填滿，從頂端對齊。
 * - **網站圖示**置中，見 `IconThumb`。
 * - **字母色卡**整塊填色。
 */
export function Thumb({ url, hostname }: ThumbProps) {
  return <ThumbImage image={useThumb(url)} hostname={hostname} />;
}

/** 一般書籤與隱私書籤共用的畫法（兩邊只是取圖的方式不同） */
export function ThumbImage({ image, hostname }: { image: CachedImage | null; hostname: string }) {
  if (image !== null && image.source === 'icon') {
    return <IconThumb src={image.src} width={image.width} height={image.height} />;
  }
  if (image !== null) {
    const isCover = image.source === 'cover' || image.source === 'og';
    return (
      <div className={`thumb ${isCover ? 'thumb--contain' : 'thumb--fill'}`}>
        <img src={image.src} alt="" loading="lazy" decoding="async" />
      </div>
    );
  }
  return <LetterThumb hostname={hostname} />;
}

export function LetterThumb({ hostname }: { hostname: string }) {
  return (
    <div className="thumb thumb--letter" style={{ background: letterColor(hostname) }} aria-hidden="true">
      <span>{initialOf(hostname)}</span>
    </div>
  );
}

/**
 * 網站圖示：素色底板，圖示置中（入口網址，見 `isEntryUrl`）。
 *
 * 大小跟著底板走（CSS），上限是原圖的兩倍（至少 32px）：多數站台有 180px 以上的
 * touch icon／manifest 圖示，只有一張 16px favicon 的那種放大到滿格只會是一團糊。
 */
export function IconThumb({ src, width, height }: { src: string; width: number; height: number }) {
  const limit = Math.max(Math.max(width, height) * 2, 32);
  return (
    <div className="thumb thumb--icon" style={{ '--icon-limit': `${String(limit)}px` } as CSSProperties}>
      <img src={src} alt="" loading="lazy" decoding="async" />
    </div>
  );
}

export function FolderThumb() {
  return (
    <div className="thumb thumb--folder" aria-hidden="true">
      <Icon name="folder" />
    </div>
  );
}
