import { useEffect, useRef } from 'react';
import type { VaultState } from '@/shared/types';
import { VaultGate } from './VaultGate';
import { t } from '@/shared/i18n';

interface VaultPromptProps {
  state: VaultState;
  /**
   * 密碼錯誤等失敗原因。
   *
   * 這裡**要**顯示錯誤，與原本「打在搜尋框裡靜默失敗」不同：那時的沉默是掩護
   * （看起來就是一次搜不到東西的搜尋）。使用者主動打開密碼畫面之後已經沒有
   * 什麼要掩護的了，這時沉默只會讓人不知道到底成功了沒。
   */
  error: string | null;
  /** 回傳只會出現這一次的救援金鑰（失敗為 null） */
  onCreate: (password: string) => Promise<string | null>;
  onUnlock: (password: string) => void;
  onUnlockWithRecoveryKey: (recoveryKey: string) => void;
  /** 使用者確認已抄下救援金鑰之後 —— 那才是「建立流程結束」的時機 */
  onCreated: () => void;
  onClose: () => void;
}

/**
 * 打出觸發字串後跳出的密碼畫面。
 *
 * 內容直接用 `VaultGate` —— 它已經處理好「尚未建立」與「已建立但上鎖」兩種情形，
 * 包含建立時的不可救回警示、二次輸入與確認勾選。在這裡重寫一份只會讓兩邊的
 * 驗證規則開始各自漂移（尤其是那個警示，那是不能弱化的）。
 *
 * 置中而不是貼著觸發點：這是需要專注輸入的密碼欄位，不是快速選單。
 * 側邊欄很窄，貼著輸入框展開會蓋掉正在打字的地方。
 */
export function VaultPrompt({
  state,
  error,
  onCreate,
  onUnlock,
  onUnlockWithRecoveryKey,
  onCreated,
  onClose,
}: VaultPromptProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      className="overlay"
      // 點背景關閉，但只在點的就是背景本身時 —— 不然在面板裡拖選文字後放開
      // 也會被當成點擊背景而把畫面關掉，正在輸入的密碼就這樣消失了。
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        className="overlay__panel"
        role="dialog"
        aria-modal="true"
        aria-label={state.status === 'absent' ? t('vault_create_title') : t('vault_unlock_action')}
      >
        <VaultGate
          state={state}
          onCreate={onCreate}
          onUnlock={onUnlock}
          onUnlockWithRecoveryKey={onUnlockWithRecoveryKey}
          onCreated={onCreated}
        />
        {error !== null ? (
          <div className="notice notice--error">
            <p>{error}</p>
          </div>
        ) : null}
        <button type="button" className="link-button" onClick={onClose}>
          {t('action_cancel')}
        </button>
      </div>
    </div>
  );
}
