import { useState } from 'react';
import type { VaultState } from '@/shared/types';
import { RecoveryKeyPanel } from './RecoveryKeyPanel';
import { t } from '@/shared/i18n';
import { Rich } from '../lib/rich';
import { MIN_PASSWORD_LENGTH } from '@/shared/vault-entry';

interface VaultGateProps {
  state: VaultState;
  /** 回傳只會出現這一次的救援金鑰；失敗時回傳 null（表單留著讓人重試） */
  onCreate: (password: string) => Promise<string | null>;
  onUnlock: (password: string) => void;
  onUnlockWithRecoveryKey: (recoveryKey: string) => void;
  /** 使用者確認已抄下救援金鑰之後 */
  onCreated?: () => void;
  /** 放棄這台裝置上的隱私空間（舊格式時唯一的出路） */
  onForget?: () => void;
}



/** 尚未建立隱私空間、已建立但上鎖、或資料是舊格式時的介面。 */
export function VaultGate({
  state,
  onCreate,
  onUnlock,
  onUnlockWithRecoveryKey,
  onCreated,
  onForget,
}: VaultGateProps) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [usingRecovery, setUsingRecovery] = useState(false);
  const [recoveryInput, setRecoveryInput] = useState('');

  /*
   * 剛建立完成 —— 先把救援金鑰攤出來，勾了「已抄下」才往下走。
   *
   * 這一步刻意擋在流程中間而不是做成事後可選的設定。做成選填的話幾乎沒有人會設，
   * 而會忘記主密碼的人正好也是不會主動去設救援金鑰的那些人。
   */
  if (recoveryKey !== null) {
    return (
      <div className="gate">
        <h2 className="gate__title">{t('vault_created_title')}</h2>
        <RecoveryKeyPanel
          recoveryKey={recoveryKey}
          reason="created"
          onAcknowledge={() => {
            setRecoveryKey(null);
            onCreated?.();
          }}
        />
      </div>
    );
  }

  if (state.status === 'legacy') {
    return (
      <div className="gate">
        <h2 className="gate__title">{t('vault_legacy_title')}</h2>
        <div className="notice notice--warn">
          <p>
            <strong>{t('vault_legacy_cannot_open')}</strong>
          </p>
          <p className="notice__body">
            {t('vault_legacy_why')}
            
          </p>
        </div>
        {onForget === undefined ? (
          <p className="gate__hint">{t('vault_legacy_how')}</p>
        ) : (
          <button type="button" className="gate__submit" onClick={onForget}>
            {t('vault_legacy_action')}
          </button>
        )}
      </div>
    );
  }

  if (state.status === 'locked') {
    if (usingRecovery) {
      return (
        <div className="gate">
          <h2 className="gate__title">{t('vault_unlock_recovery_title')}</h2>
          <p className="gate__hint">
            {t('vault_unlock_recovery_hint')}
          </p>
          {/* 不包在 <form> 裡：表單送出會觸發 Firefox 的存密碼提示 */}
          <input
            type="text"
            className="gate__input"
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            value={recoveryInput}
            onChange={(event) => {
              setRecoveryInput(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && recoveryInput.trim() !== '') {
                onUnlockWithRecoveryKey(recoveryInput);
              }
            }}
          />
          <button
            type="button"
            className="gate__submit"
            disabled={recoveryInput.trim() === ''}
            onClick={() => {
              onUnlockWithRecoveryKey(recoveryInput);
            }}
          >
            {t('vault_unlock_action')}
          </button>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setUsingRecovery(false);
              setRecoveryInput('');
            }}
          >
            {t('vault_use_password_instead')}
          </button>
        </div>
      );
    }

    return (
      <div className="gate">
        <h2 className="gate__title">{t('vault_locked_title')}</h2>
        <input
          type="password"
          className="gate__input"
          placeholder={t('vault_secret_password')}
          autoComplete="off"
          autoFocus
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && password !== '') {
              onUnlock(password);
              setPassword('');
            }
          }}
        />
        <button
          type="button"
          className="gate__submit"
          disabled={password === ''}
          onClick={() => {
            onUnlock(password);
            setPassword('');
          }}
        >
          {t('vault_unlock_action')}
        </button>
        <button
          type="button"
          className="link-button"
          onClick={() => {
            setUsingRecovery(true);
          }}
        >
          {t('vault_forgot_password')}
        </button>
      </div>
    );
  }

  const tooShort = password.length < MIN_PASSWORD_LENGTH;
  const mismatch = password !== confirm;

  const submit = (): void => {
    setBusy(true);
    void onCreate(password).then(
      (code) => {
        setBusy(false);
        if (code === null) {
          return;
        }
        setPassword('');
        setConfirm('');
        setAcknowledged(false);
        setRecoveryKey(code);
      },
      () => {
        setBusy(false);
      },
    );
  };

  return (
    <div className="gate">
      <h2 className="gate__title">{t('vault_create_title')}</h2>

      <div className="notice notice--warn">
        <p>
          <strong>{t('vault_create_warning')}</strong>
        </p>
        <p className="notice__body">
          <Rich text={t('vault_create_body')} />
          
        </p>
      </div>

      {/* 密碼欄位不包在 <form> 裡：表單送出會觸發 Firefox 的「要儲存密碼嗎？」提示 */}
      <input
        type="password"
        className="gate__input"
        placeholder={t('vault_password_placeholder', MIN_PASSWORD_LENGTH)}
        autoComplete="new-password"
        value={password}
        onChange={(event) => {
          setPassword(event.target.value);
        }}
      />
      <input
        type="password"
        className="gate__input"
        placeholder={t('vault_password_again')}
        autoComplete="new-password"
        value={confirm}
        onChange={(event) => {
          setConfirm(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !tooShort && !mismatch && acknowledged && !busy) {
            submit();
          }
        }}
      />

      {password !== '' && tooShort ? <p className="gate__hint">{t('vault_password_too_short', MIN_PASSWORD_LENGTH)}</p> : null}
      {confirm !== '' && mismatch ? <p className="gate__hint">{t('vault_password_mismatch')}</p> : null}

      <label className="gate__check">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => {
            setAcknowledged(event.target.checked);
          }}
        />
        {t('vault_create_acknowledge')}
      </label>

      <button
        type="button"
        className="gate__submit"
        disabled={tooShort || mismatch || !acknowledged || busy}
        onClick={submit}
      >
        {busy ? t('action_creating') : t('action_create')}
      </button>
    </div>
  );
}
