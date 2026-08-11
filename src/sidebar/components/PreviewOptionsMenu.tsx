import type { PreviewSource } from '@/shared/types';
import type { BackfillKind } from '../hooks/useBackfill';
import { Popover } from './Popover';
import { t } from '@/shared/i18n';

interface PreviewOptionsMenuProps {
  x: number;
  y: number;
  previewSource: PreviewSource;
  onPreviewSourceChange: (source: PreviewSource) => void;
  /** 沒有網站存取權限時無法補抓 */
  canBackfill: boolean;
  backfillBusy: boolean;
  /**
   * 補抓要抓哪一邊。
   *
   * 站在隱私空間時必須是 `vault/backfill` —— 送 `thumbs/backfill` 會去抓一般書籤，
   * 表現成「按了沒反應」。而且隱私書籤的縮圖必須加密寫入，兩者無法共用實作。
   */
  backfillKind: BackfillKind;
  onBackfill: (kind: BackfillKind) => void;
  onClose: () => void;
}

/**
 * 「更多選項」的內容：預覽圖來源與補抓。
 *
 * 側邊欄與全頁瀏覽共用同一份。這兩項是設定一次或偶爾按一次的東西，不值得
 * 長期佔用工具列寬度；而共用元件也讓「兩邊功能不能有缺少」變成結構上的保證，
 * 而不是每次改動都要記得同步兩處。
 */
export function PreviewOptionsMenu({
  x,
  y,
  previewSource,
  onPreviewSourceChange,
  canBackfill,
  backfillBusy,
  backfillKind,
  onBackfill,
  onClose,
}: PreviewOptionsMenuProps) {
  return (
    <Popover x={x} y={y} onClose={onClose}>
      <p className="rowmenu__heading">{t('preview_source')}</p>
      <button
        type="button"
        className={`rowmenu__item${previewSource === 'cover-first' ? ' rowmenu__item--on' : ''}`}
        title={t('preview_cover_first_hint')}
        aria-pressed={previewSource === 'cover-first'}
        onClick={() => {
          onPreviewSourceChange('cover-first');
          onClose();
        }}
      >
        {t('preview_cover_first')}
      </button>
      <button
        type="button"
        className={`rowmenu__item${previewSource === 'screenshot-first' ? ' rowmenu__item--on' : ''}`}
        title={t('preview_capture_first_hint')}
        aria-pressed={previewSource === 'screenshot-first'}
        onClick={() => {
          onPreviewSourceChange('screenshot-first');
          onClose();
        }}
      >
        {t('preview_capture_first')}
      </button>

      <hr className="rowmenu__divider" />

      <button
        type="button"
        className="rowmenu__item"
        disabled={backfillBusy || !canBackfill}
        title={
          canBackfill
            ? t('backfill_hint')
            : t('backfill_needs_permission_hint')
        }
        onClick={() => {
          onBackfill(backfillKind);
          onClose();
        }}
      >
        {backfillBusy ? t('backfill_running') : t('backfill_start')}
      </button>
    </Popover>
  );
}
