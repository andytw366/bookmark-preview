import { useState } from 'react';

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
            ? '這是新的救援金鑰，舊的那一串已經失效。'
            : '把這串救援金鑰抄下來，收在安全的地方。'}
        </strong>
      </p>
      <p className="notice__body">
        忘記主密碼時，<strong>這是唯一能救回資料的東西</strong>。
        兩個都沒有的話，隱私空間裡的書籤就永久打不開了 —— 沒有任何人能替你重設，
        包括我們。
      </p>

      <code className="recovery__code">{recoveryKey}</code>

      <div className="recovery__actions">
        <button
          type="button"
          className="chip"
          onClick={() => {
            void navigator.clipboard.writeText(recoveryKey).then(
              () => {
                setCopied(true);
              },
              () => undefined,
            );
          }}
        >
          {copied ? '已複製' : '複製'}
        </button>
        <button
          type="button"
          className="chip"
          onClick={() => {
            // 存成檔案是給「現在沒有紙筆」的人的退路
            const url = URL.createObjectURL(new Blob([`${recoveryKey}\n`], { type: 'text/plain' }));
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = '隱私空間救援金鑰.txt';
            anchor.style.display = 'none';
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
            setTimeout(() => {
              URL.revokeObjectURL(url);
            }, 60_000);
          }}
        >
          存成文字檔
        </button>
      </div>

      <p className="notice__body">
        <strong>不要和加密備份檔放在同一個地方。</strong>
        兩者放在一起（例如同一個雲端硬碟或同一個 Google 帳號），誰拿到那個帳號就同時
        拿到密文和鑰匙，兩層保護會一起失效。
      </p>

      {onDismiss !== undefined ? (
        <div className="recovery__actions">
          <button type="button" className="chip" onClick={onDismiss}>
            收起
          </button>
        </div>
      ) : null}

      {onAcknowledge !== undefined ? (
        <>
          <label className="gate__check">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => {
                setAcknowledged(event.target.checked);
              }}
            />
            我已經抄下來或存好了
          </label>
          <button
            type="button"
            className="gate__submit"
            disabled={!acknowledged}
            onClick={onAcknowledge}
          >
            完成
          </button>
        </>
      ) : null}
    </div>
  );
}
