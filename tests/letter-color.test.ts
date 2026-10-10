import { describe, expect, it } from 'vitest';
import { LETTER_COLORS, letterColor } from '@/shared/letter-color';

function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

describe('letter colors', () => {
  it('every swatch keeps white text at 4.5:1 or better', () => {
    for (const color of LETTER_COLORS) {
      const ratio = 1.05 / (luminance(color) + 0.05);
      expect(ratio, color).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('is stable per hostname and stays inside the palette', () => {
    expect(letterColor('github.com')).toBe(letterColor('github.com'));
    for (const host of ['a.com', 'example.org', 'news.ycombinator.com', '']) {
      expect(LETTER_COLORS).toContain(letterColor(host));
    }
  });
});
