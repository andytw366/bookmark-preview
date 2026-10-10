import { Button } from '../../ui/Button';
import { t } from '@/shared/i18n';

interface PermissionNoticeProps {
  onGrant: () => void;
  /** 「先不要」：收起這則說明 */
  onDismiss?: (() => void) | undefined;
}

/**
 * 沒有 `<all_urls>` 時的說明。
 *
 * 刻意講清楚「為什麼要這個權限」而不只是丟一個按鈕 —— 一個主打隱私的
 * 擴充套件跟使用者要全網站存取權，有義務先說明用途。
 */
export function PermissionNotice({ onGrant, onDismiss }: PermissionNoticeProps) {
  return (
    <div className="notice notice--info">
      <p>
        <strong>{t('permission_swatches_only')}</strong>
      </p>
      <p className="notice__body">
        {t('permission_why')}
      </p>
      <p className="notice__body">{t('permission_reload_note')}</p>
      <div className="notice__actions">
        <Button variant="primary" onClick={onGrant}>
          {t('permission_grant')}
        </Button>
        {onDismiss === undefined ? null : (
          <Button variant="ghost" onClick={onDismiss}>
            {t('permission_dismiss')}
          </Button>
        )}
      </div>
    </div>
  );
}
