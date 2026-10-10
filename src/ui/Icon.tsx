import type { ReactNode } from 'react';

/**
 * 介面用的 16px 線條圖示（設計稿 `design/*.dc.html` 的那一組）。
 *
 * 一律 `currentColor`、1.5px 線寬，顏色跟著按鈕或選單項目走；圖示本身永遠是裝飾，
 * 可及名稱由外面的按鈕（`aria-label`）或文字負責。
 */
const DOT = { fill: 'currentColor', stroke: 'none' } as const;
const FOLDER = 'M1.75 4.25c0-.55.45-1 1-1h3.5l1.5 1.5h5.5c.55 0 1 .45 1 1v6.5c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1z';

const PATHS = {
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
    </>
  ),
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  back: <path d="M10 3.5 5.5 8l4.5 4.5" />,
  chevron: <path d="m6 3.5 4.5 4.5L6 12.5" />,
  folder: <path d={FOLDER} />,
  'folder-plus': (
    <>
      <path d={FOLDER} />
      <path d="M8 7.5v3.5M6.25 9.25h3.5" />
    </>
  ),
  'folder-move': (
    <>
      <path d={FOLDER} />
      <path d="M6 9.25h4M8.5 7.5l1.75 1.75L8.5 11" />
    </>
  ),
  select: (
    <>
      <rect x="2" y="2" width="12" height="12" rx="2.5" />
      <path d="m5 8 2 2 4-4" />
    </>
  ),
  gallery: <path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" />,
  more: (
    <>
      <circle cx="3.5" cy="8" r="1" {...DOT} />
      <circle cx="8" cy="8" r="1" {...DOT} />
      <circle cx="12.5" cy="8" r="1" {...DOT} />
    </>
  ),
  cards: (
    <>
      <rect x="2.5" y="2" width="11" height="7" rx="1.5" />
      <path d="M2.5 11.5h11M2.5 14h7" />
    </>
  ),
  rows: (
    <>
      <rect x="2" y="3" width="4" height="4" rx="1" />
      <rect x="2" y="9" width="4" height="4" rx="1" />
      <path d="M8 4.5h6M8 10.5h6" />
    </>
  ),
  text: <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />,
  'open-new': <path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />,
  copy: (
    <>
      <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" />
      <path d="M11 5V3.5a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1V10a1 1 0 0 0 1 1H5" />
    </>
  ),
  refresh: <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />,
  image: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <circle cx="6" cy="6.5" r="1" />
      <path d="m2.5 12 4-4 3 3 2-2 2.5 2.5" />
    </>
  ),
  'site-icon': <rect x="3" y="3" width="10" height="10" rx="2.5" />,
  rename: <path d="M10.5 2.5l3 3-8 8H2.5v-3z" />,
  'arrow-up': <path d="M8 13V3M4 7l4-4 4 4" />,
  'arrow-down': <path d="M8 3v10M4 9l4 4 4-4" />,
  'arrow-left': <path d="M13 8H3M7 4 3 8l4 4" />,
  'arrow-right': <path d="M3 8h10M9 4l4 4-4 4" />,
  tag: (
    <>
      <path d="M2.5 2.5h5l6 6-5 5-6-6z" />
      <circle cx="5.5" cy="5.5" r=".75" fill="currentColor" />
    </>
  ),
  trash: <path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6" />,
  lock: (
    <>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1" />
    </>
  ),
  frame: <rect x="1.75" y="3" width="12.5" height="10" rx="2" strokeDasharray="2.5 2" />,
  dissolve: (
    <>
      <rect x="1.75" y="3" width="12.5" height="10" rx="2" strokeDasharray="2.5 2" />
      <path d="M6 8h4" />
    </>
  ),
  'leave-group': (
    <>
      <rect x="2" y="2" width="12" height="12" rx="2.5" strokeDasharray="2 2" />
      <path d="M6 8h4" />
    </>
  ),
  'move-out': <path d="M6 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1H6M10 5l3 3-3 3M13 8H6" />,
  'move-in': (
    <>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2M8 9.5v2" />
    </>
  ),
  warning: (
    <>
      <path d="M8 2 14.5 13.5h-13z" />
      <path d="M8 6.5v3M8 11.5v.01" />
    </>
  ),
  shield: <path d="M8 1.75 13 3.5v4c0 3-2.2 5.3-5 6.75C5.2 12.8 3 10.5 3 7.5v-4z" />,
  key: (
    <>
      <circle cx="5" cy="11" r="2.5" />
      <path d="m7 9 6.5-6.5M11 4.5l1.5 1.5" />
    </>
  ),
  sync: <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />,
  check: <path d="m3.5 8.5 3 3 6-7" />,
  minus: <path d="M3.5 8h9" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  play: <path d="M5 3.5v9l7.5-4.5z" fill="currentColor" stroke="none" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className }: { name: IconName; className?: string | undefined }) {
  return (
    <svg className={className === undefined ? 'ico' : `ico ${className}`} viewBox="0 0 16 16" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
