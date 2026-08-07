import { useState } from 'react';
import type { VaultState } from '@/shared/types';
import { RecoveryKeyPanel } from './RecoveryKeyPanel';

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

const MIN_LENGTH = 8;

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
        <h2 className="gate__title">隱私空間已建立</h2>
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
        <h2 className="gate__title">這個隱私空間是舊格式</h2>
        <div className="notice notice--warn">
          <p>
            <strong>目前的版本已經打不開它了。</strong>
          </p>
          <p className="notice__body">
            開發期間換過加密格式（改成支援救援金鑰與更改主密碼），而舊格式刻意沒有做轉換。
            正確的密碼也開不了，只能清掉它再重新建立一個。
          </p>
        </div>
        {onForget === undefined ? (
          <p className="gate__hint">到設定頁按「放棄這台裝置上的隱私空間」。</p>
        ) : (
          <button type="button" className="gate__submit" onClick={onForget}>
            清掉並重新開始
          </button>
        )}
      </div>
    );
  }

  if (state.status === 'locked') {
    if (usingRecovery) {
      return (
        <div className="gate">
          <h2 className="gate__title">用救援金鑰解鎖</h2>
          <p className="gate__hint">
            就是建立時要你抄下來的那 8 組字元。大小寫與分隔符號都不重要。
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
            解鎖
          </button>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setUsingRecovery(false);
              setRecoveryInput('');
            }}
          >
            改用主密碼
          </button>
        </div>
      );
    }

    return (
      <div className="gate">
        <h2 className="gate__title">隱私空間已上鎖</h2>
        <input
          type="password"
          className="gate__input"
          placeholder="主密碼"
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
          解鎖
        </button>
        <button
          type="button"
          className="link-button"
          onClick={() => {
            setUsingRecovery(true);
          }}
        >
          忘記主密碼？用救援金鑰
        </button>
      </div>
    );
  }

  const tooShort = password.length < MIN_LENGTH;
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
      <h2 className="gate__title">建立隱私空間</h2>

      <div className="notice notice--warn">
        <p>
          <strong>忘記主密碼時，只有救援金鑰能救回資料。</strong>
        </p>
        <p className="notice__body">
          密碼不存在任何地方，我們也無法替你重設。建立後會給你一串
          <strong>救援金鑰</strong>，那是唯一的備用鑰匙，請抄下來。
        </p>
      </div>

      {/* 密碼欄位不包在 <form> 裡：表單送出會觸發 Firefox 的「要儲存密碼嗎？」提示 */}
      <input
        type="password"
        className="gate__input"
        placeholder={`主密碼（至少 ${String(MIN_LENGTH)} 字）`}
        autoComplete="new-password"
        value={password}
        onChange={(event) => {
          setPassword(event.target.value);
        }}
      />
      <input
        type="password"
        className="gate__input"
        placeholder="再次輸入"
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

      {password !== '' && tooShort ? <p className="gate__hint">密碼至少要 {MIN_LENGTH} 個字。</p> : null}
      {confirm !== '' && mismatch ? <p className="gate__hint">兩次輸入不一致。</p> : null}

      <label className="gate__check">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => {
            setAcknowledged(event.target.checked);
          }}
        />
        我了解忘記密碼且遺失救援金鑰將無法救回
      </label>

      <button
        type="button"
        className="gate__submit"
        disabled={tooShort || mismatch || !acknowledged || busy}
        onClick={submit}
      >
        {busy ? '建立中…' : '建立'}
      </button>
    </div>
  );
}
