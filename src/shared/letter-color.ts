import { hueFromString } from './url';

/**
 * 字母色卡的 8 色色票。每一色對白字都達 WCAG AA 的 4.5:1（`tests/letter-color.test.ts` 檢查），
 * 淺色與深色主題共用 —— 色卡是「預覽圖」，不是介面的一部分，不跟著主題換。
 */
export const LETTER_COLORS = [
  '#5b4fc4',
  '#0061e0',
  '#017a40',
  '#a84d00',
  '#b5006c',
  '#006f8c',
  '#8c3b2f',
  '#4b5563',
] as const;

/** 由網域挑一色：同一個網域永遠同一色，換裝置也一樣 */
export function letterColor(hostname: string): string {
  return LETTER_COLORS[hueFromString(hostname) % LETTER_COLORS.length] ?? LETTER_COLORS[0];
}
