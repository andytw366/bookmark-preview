import { describe, expect, it } from 'vitest';
import {
  iconsFromManifest,
  looksLikeSvg,
  parseSizes,
  rankIconCandidates,
  SCALABLE_SIZE,
} from '@/shared/site-icon-rank';

/**
 * 網站圖示的候選排序：尺寸大的優先、偏好正方形。
 * 真正能不能用要取下來解碼才知道，這裡只決定試的順序。
 */
describe('parseSizes', () => {
  it('取最大那組的最短邊', () => {
    expect(parseSizes('16x16 32x32 192x192')).toEqual({ size: 192, oblong: false });
  });

  it('any 當作很大', () => {
    expect(parseSizes('any')).toEqual({ size: SCALABLE_SIZE, oblong: false });
  });

  it('長方形記下來', () => {
    expect(parseSizes('310x150')).toEqual({ size: 150, oblong: true });
  });

  it('沒寫或寫壞回 null', () => {
    expect(parseSizes(null)).toBeNull();
    expect(parseSizes('')).toBeNull();
    expect(parseSizes('big')).toBeNull();
  });
});

describe('looksLikeSvg', () => {
  it('看副檔名、type 與 data:', () => {
    expect(looksLikeSvg('https://x.com/a/icon.svg')).toBe(true);
    expect(looksLikeSvg('https://x.com/icon', 'image/svg+xml')).toBe(true);
    expect(looksLikeSvg('data:image/svg+xml;base64,AAAA')).toBe(true);
    expect(looksLikeSvg('https://x.com/favicon.ico')).toBe(false);
  });
});

describe('iconsFromManifest', () => {
  const manifestUrl = 'https://www.google.com/maps/manifest.json';

  it('src 相對於 manifest 自己的網址解析', () => {
    const icons = iconsFromManifest(
      { icons: [{ src: 'icons/192.png', sizes: '192x192' }] },
      manifestUrl,
    );
    expect(icons).toEqual([{ url: 'https://www.google.com/maps/icons/192.png', size: 192 }]);
  });

  it('只有 monochrome 的不要，maskable 標記下來', () => {
    const icons = iconsFromManifest(
      {
        icons: [
          { src: '/mono.png', sizes: '512x512', purpose: 'monochrome' },
          { src: '/mask.png', sizes: '512x512', purpose: 'maskable' },
          { src: '/both.png', sizes: '256x256', purpose: 'any maskable' },
        ],
      },
      manifestUrl,
    );
    expect(icons.map((icon) => icon.url)).toEqual([
      'https://www.google.com/mask.png',
      'https://www.google.com/both.png',
    ]);
    expect(icons[0]?.maskable).toBe(true);
    expect(icons[1]?.maskable).toBeUndefined();
  });

  it('不是 manifest 的東西回空陣列', () => {
    expect(iconsFromManifest(null, manifestUrl)).toEqual([]);
    expect(iconsFromManifest({ icons: 'nope' }, manifestUrl)).toEqual([]);
    expect(iconsFromManifest({ icons: [{ sizes: '16x16' }, 42] }, manifestUrl)).toEqual([]);
  });
});

describe('rankIconCandidates', () => {
  it('大的優先、去重', () => {
    expect(
      rankIconCandidates([
        { url: 'https://x.com/favicon.ico', size: 32 },
        { url: 'https://x.com/apple.png', size: 180 },
        { url: 'https://x.com/favicon.ico', size: 16 },
        { url: 'https://x.com/logo.svg', size: SCALABLE_SIZE },
      ]),
    ).toEqual(['https://x.com/logo.svg', 'https://x.com/apple.png', 'https://x.com/favicon.ico']);
  });

  it('長方形與 maskable 排在同尺寸的正方形後面', () => {
    expect(
      rankIconCandidates([
        { url: 'https://x.com/wide.png', size: 192, oblong: true },
        { url: 'https://x.com/mask.png', size: 192, maskable: true },
        { url: 'https://x.com/square.png', size: 128 },
      ]),
    ).toEqual(['https://x.com/square.png', 'https://x.com/wide.png', 'https://x.com/mask.png']);
  });

  it('只收網頁協定與 data:image', () => {
    expect(
      rankIconCandidates([
        { url: 'chrome://branding/icon.png', size: 64 },
        { url: 'data:image/png;base64,AAAA', size: 16 },
        { url: 'javascript:alert(1)', size: 999 },
      ]),
    ).toEqual(['data:image/png;base64,AAAA']);
  });
});
