import { useState } from 'react';
import { Button } from '../../ui/Button';
import { CheckField } from '../../ui/Toggles';
import { t } from '@/shared/i18n';
import { Rich } from '../lib/rich';

interface RecoveryKeyPanelProps {
  recoveryKey: string;
  /** 有值時顯示「我已經抄下來了」的勾選與確認按鈕，勾了才能按 */
  onAcknowledge?: () => void;
  /**
   * 有值時顯示「收起」。
   *
   * 建立流程用 `onAcknowledge`（強制確認才能往下走）；「再看一次」與「重新產生」
   * 用這個 —— 少了它，那串碼一旦顯示就再也關不掉，只能重新整理整個設定頁。
   */
  onDismiss?: () => void;
  /** 建立時是第一次；重新產生時要多說一句「舊的已失效」 */
  reason: 'created' | 'regenerated' | 'revealed';
}

/**
 * 顯示救援金鑰。
 *
 * 三個地方都用這一個元件（建立完成、重新產生、事後再看一次），因為這裡的每一句話
 * 都是在防「使用者以為自己不需要抄」。分成三份實作，遲早會有一份的警告比較弱 ——
 * 而最弱的那一份就是實際的保護強度。
 */
export function RecoveryKeyPanel({
  recoveryKey,
  onAcknowledge,
  onDismiss,
  reason,
}: RecoveryKeyPanelProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);

  return (
    <div className="notice notice--warn recovery">
      <p>
        <strong>
          {reason === 'regenerated'
            ? t('recovery_regenerated')
            : t('recovery_write_it_down')}
        </strong>
      </p>
      <p className="notice__body">
        <Rich text={t('recovery_only_way')} />
        {t('recovery_no_reset')}
        
      </p>

      <code className="recovery__code">{recoveryKey}</code>

      <div className="recovery__actions">
        <Button
          icon="copy"
          onClick={() => {
            void navigator.clipboard.writeText(recoveryKey).then(
              () => {
                setCopied(true);
              },
              () => undefined,
            );
          }}
        >
          {copied ? t('action_copied') : t('action_copy')}
        </Button>
        <Button
          onClick={() => {
            // 存成檔案是給「現在沒有紙筆」的人的退路
            const url = URL.createObjectURL(new Blob([`${recoveryKey}\n`], { type: 'text/plain' }));
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = t('recovery_filename');
            anchor.style.display = 'none';
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
            setTimeout(() => {
              URL.revokeObjectURL(url);
            }, 60_000);
          }}
        >
          {t('recovery_save_as_file')}
        </Button>
      </div>

      <p className="notice__body">
        <strong>{t('recovery_keep_apart')}</strong>
        {t('recovery_keep_apart_why')}
        
      </p>

      {onDismiss !== undefined ? (
        <div className="recovery__actions">
          <Button variant="ghost" onClick={onDismiss}>
            {t('action_collapse')}
          </Button>
        </div>
      ) : null}

      {onAcknowledge !== undefined ? (
        <>
          <CheckField checked={acknowledged} onChange={setAcknowledged}>
            {t('recovery_acknowledged')}
          </CheckField>
          <Button variant="primary" disabled={!acknowledged} onClick={onAcknowledge}>
            {t('action_done')}
          </Button>
        </>
      ) : null}
    </div>
  );
}
