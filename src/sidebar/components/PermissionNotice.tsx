interface PermissionNoticeProps {
  onGrant: () => void;
}

/**
 * 沒有 `<all_urls>` 時的說明。
 *
 * 刻意講清楚「為什麼要這個權限」而不只是丟一個按鈕 —— 一個主打隱私的
 * 擴充套件跟使用者要全網站存取權，有義務先說明用途。
 */
export function PermissionNotice({ onGrant }: PermissionNoticeProps) {
  return (
    <div className="notice notice--info">
      <p>
        <strong>目前只能顯示網域色卡。</strong>
      </p>
      <p className="notice__body">
        產生真實預覽需要「存取所有網站」的權限。縮圖只存在你的裝置上，不會上傳。
      </p>
      <p className="notice__body">授權後擴充套件會自動重新啟動一次。</p>
      <button type="button" onClick={onGrant}>
        授予權限
      </button>
    </div>
  );
}
