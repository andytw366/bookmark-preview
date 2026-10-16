import { useLayoutEffect, useRef, type SVGProps } from 'react';
import { t } from '@/shared/i18n';

/**
 * 一行 SVG 文字，超過 `maxWidth`（viewBox 單位）就從尾巴截斷並加省略號。
 *
 * SVG 的 `<text>` 不會自己換行或截斷，而英文的字串比中文長得多 —— 不量的話，資料夾名稱會
 * 壓到右邊的窗格、右側的註解會跑出 viewBox。文字由這裡直接寫進 DOM（不交給 React 的 children），
 * 量完再寫一次也不會跟 React 打架。在畫面外量不到寬度（回 0）時就照原樣顯示。
 */
function FitText({ text, maxWidth, ...props }: SVGProps<SVGTextElement> & { text: string; maxWidth: number }) {
  const ref = useRef<SVGTextElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) {
      return;
    }
    el.textContent = text;
    if (el.getComputedTextLength() <= maxWidth) {
      return;
    }
    const chars = Array.from(text);
    const cut = (n: number): string => `${chars.slice(0, n).join('').trimEnd()}…`;
    // 最長的、量起來放得下的前綴
    let lo = 0;
    let hi = chars.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      el.textContent = cut(mid);
      if (el.getComputedTextLength() <= maxWidth) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    el.textContent = cut(lo);
  }, [text, maxWidth]);
  return <text ref={ref} {...props} />;
}

/** 右邊窗格右緣（留一點邊）。所有往右長的文字都不能超過這裡 */
const RIGHT_EDGE = 600;

/**
 * 「改用書籤同步」的範例圖：打開之後 Firefox 的書籤管理員裡會多出什麼。
 *
 * 照 `bookmark-preview-ui/design/sync-bookmarks/example.html`（使用者看過並同意的版本）畫，
 * 顏色全用 `tokens.css` 的變數，深色主題自動跟上。圖下那兩行說明改成一般的段落而不是 SVG 文字：
 * 英文版會比 608 寬，SVG 不會換行。
 */
export function SyncBookmarksExample() {
  const folderTitle = t('sync_bookmarks_folder_title');
  return (
    <figure className="sync-example">
      <svg viewBox="0 0 608 200" role="img" aria-label={t('sync_example_label')}>
        {/* 視窗 */}
        <rect x="0.5" y="0.5" width="607" height="199" rx="8" fill="var(--surface)" stroke="var(--border-strong)" />
        {/* 標題列 */}
        <path d="M0.5 8.5a8 8 0 0 1 8-8h591a8 8 0 0 1 8 8v19.5h-607z" fill="var(--surface-2)" />
        <line x1="0.5" y1="28" x2="607.5" y2="28" stroke="var(--border)" />
        <circle cx="16" cy="14" r="4" fill="var(--border-strong)" />
        <circle cx="30" cy="14" r="4" fill="var(--border-strong)" />
        <circle cx="44" cy="14" r="4" fill="var(--border-strong)" />
        <FitText
          text={t('sync_example_window')}
          maxWidth={400}
          x="304"
          y="18"
          textAnchor="middle"
          fontSize="11"
          fill="var(--text-2)"
        />

        {/* 左邊的樹 */}
        <rect x="1" y="28.5" width="186" height="170.5" fill="var(--bg)" />
        <line x1="187.5" y1="28" x2="187.5" y2="199.5" stroke="var(--border)" />
        <g fontSize="12" fill="var(--text)">
          <g transform="translate(12 46)">
            <use href="#sync-example-folder" />
            <FitText text={t('sync_example_menu')} maxWidth={145} x="22" y="9" />
          </g>
          <g transform="translate(12 70)">
            <use href="#sync-example-folder" />
            <FitText text={t('sync_example_toolbar')} maxWidth={145} x="22" y="9" />
          </g>
          <g transform="translate(12 94)">
            <use href="#sync-example-folder" />
            <FitText text={t('sync_example_other')} maxWidth={145} x="22" y="9" />
          </g>
        </g>
        {/* 選中的：同步資料夾 */}
        <rect x="20" y="112" width="160" height="24" rx="4" fill="var(--accent-tint)" />
        <g transform="translate(28 118)" fontSize="12" fill="var(--text)">
          <use href="#sync-example-folder" />
          <FitText text={folderTitle} maxWidth={126} x="22" y="9" />
        </g>

        {/* 右邊窗格：標題與欄名 */}
        <FitText
          text={folderTitle}
          maxWidth={RIGHT_EDGE - 204}
          x="204"
          y="50"
          fontSize="12"
          fontWeight="600"
          fill="var(--text)"
        />
        <line x1="188" y1="62.5" x2="607" y2="62.5" stroke="var(--border)" />
        <FitText
          text={t('sync_example_name')}
          maxWidth={RIGHT_EDGE - 228}
          x="228"
          y="80"
          fontSize="11"
          fill="var(--text-2)"
        />
        <line x1="188" y1="88.5" x2="607" y2="88.5" stroke="var(--border)" />
        {/* 三筆：標題空白，Firefox 顯示 data: 網址 */}
        <g fontSize="11" fill="var(--text-2)" className="sync-example__mono">
          <g transform="translate(204 98)">
            <use href="#sync-example-globe" />
            <text x="22" y="10">data:,6endoe7s66pnq3xkz2m4fa7tq…</text>
          </g>
          <g transform="translate(204 122)">
            <use href="#sync-example-globe" />
            <text x="22" y="10">data:,h2vqa5ri4zx7mnc3ple6dwo…</text>
          </g>
          <g transform="translate(204 146)">
            <use href="#sync-example-globe" />
            <text x="22" y="10">data:,p7kd4lu2f6sxa3qe5ymvhtn…</text>
          </g>
        </g>
        {/* 括號與註解 */}
        <path d="M468 100v58" stroke="var(--accent)" strokeWidth="1.5" fill="none" />
        <path d="M468 100h-6M468 158h-6M468 129h8" stroke="var(--accent)" strokeWidth="1.5" fill="none" />
        <FitText
          text={t('sync_example_callout')}
          maxWidth={RIGHT_EDGE - 482}
          x="482"
          y="125"
          fontSize="11"
          fill="var(--accent)"
          fontWeight="600"
        />
        <FitText
          text={t('sync_example_size')}
          maxWidth={RIGHT_EDGE - 482}
          x="482"
          y="140"
          fontSize="11"
          fill="var(--accent)"
        />

        <defs>
          <g id="sync-example-folder">
            <path
              d="M1 3.5a1.5 1.5 0 0 1 1.5-1.5h4l1.5 1.8h5.5a1.5 1.5 0 0 1 1.5 1.5v6.7a1.5 1.5 0 0 1-1.5 1.5h-11a1.5 1.5 0 0 1-1.5-1.5z"
              fill="none"
              stroke="var(--text-2)"
              strokeWidth="1.2"
            />
          </g>
          <g id="sync-example-globe">
            <circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--text-3)" strokeWidth="1.1" />
            <path
              d="M1.5 7h11M7 1.5c-2 2-2 9 0 11M7 1.5c2 2 2 9 0 11"
              fill="none"
              stroke="var(--text-3)"
              strokeWidth="1.1"
            />
          </g>
        </defs>
      </svg>
      <figcaption>
        <p>{t('sync_example_footnote_1')}</p>
        <p>{t('sync_example_footnote_2')}</p>
      </figcaption>
    </figure>
  );
}
