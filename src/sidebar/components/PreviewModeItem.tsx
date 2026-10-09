import type { RefreshReport } from '@/shared/messages';
import type { PreviewMode } from '@/shared/types';
import { peekThumb } from '../lib/thumb-cache';
import { t } from '@/shared/i18n';

interface PreviewModeItemProps {
  /** 縮圖快取的鍵。還不知道（沒畫過）就當成目前不是圖示 */
  thumbKey: string | undefined;
  send: (mode: PreviewMode) => Promise<RefreshReport>;
  onClose: () => void;
  onNotice: (message: string) => void;
}

/**
 * 列選單的「改用網站圖示／改用頁面預覽」，一般書籤與隱私書籤共用。
 *
 * 顯示哪一個看的是**畫面上現在那張**（快取裡縮圖的 `source`），不是規則算出來的：
 * 使用者是看著那張圖決定要換的。選了之後由背景頁記住並重抓（`thumbs/set-mode`、
 * `vault/set-thumb-mode`），不記住的話下次自動擷取又會照入口規則蓋回去。
 */
export function PreviewModeItem({ thumbKey, send, onClose, onNotice }: PreviewModeItemProps) {
  const showingIcon = thumbKey !== undefined && peekThumb(thumbKey)?.source === 'icon';
  const next: PreviewMode = showingIcon ? 'page' : 'icon';
  return (
    <button
      type="button"
      role="menuitem"
      className="rowmenu__item"
      title={showingIcon ? t('row_use_page_preview_hint') : t('row_use_site_icon_hint')}
      onClick={() => {
        onClose();
        onNotice(t('refresh_thumb_running'));
        void send(next).then(
          (report) => {
            onNotice(report.detail);
          },
          (cause: unknown) => {
            onNotice(cause instanceof Error ? cause.message : String(cause));
          },
        );
      }}
    >
      {showingIcon ? t('row_use_page_preview') : t('row_use_site_icon')}
    </button>
  );
}
