/**
 * 最近一次擷取嘗試的結果。
 *
 * 擷取是完全被動發生的，失敗時使用者只會看到「預覽圖一直沒出現」而
 * 無從得知原因。把最後一次的結果記下來並在 UI 顯示，讓「為什麼沒有預覽」
 * 這個問題可以自己回答，不必翻瀏覽器主控台。
 */
export type CaptureStage =
  | 'skipped:private-window'
  | 'skipped:inactive-tab'
  | 'skipped:unsupported-url'
  | 'skipped:no-permission'
  | 'skipped:api-unavailable'
  | 'skipped:disabled'
  | 'skipped:blocklisted'
  | 'skipped:not-bookmarked'
  | 'skipped:fresh'
  | 'skipped:navigated-away'
  /** 剛加入書籤，但那個網址沒有開著的分頁可供擷取 */
  | 'skipped:not-open'
  | 'ok'
  | 'error'
  | 'manual:ok'
  | 'manual:not-bookmarked'
  | 'manual:failed';

export interface CaptureDiagnostic {
  stage: CaptureStage;
  url: string;
  at: number;
  detail?: string;
}

const KEY = 'lastCapture';

export async function recordCapture(diagnostic: CaptureDiagnostic): Promise<void> {
  await browser.storage.local.set({ [KEY]: diagnostic });
}

export async function getLastCapture(): Promise<CaptureDiagnostic | null> {
  const stored = await browser.storage.local.get(KEY);
  return (stored[KEY] as CaptureDiagnostic | undefined) ?? null;
}

export function onCaptureRecorded(handler: (diagnostic: CaptureDiagnostic) => void): () => void {
  const listener = (
    changes: Record<string, browser.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'local' || !(KEY in changes)) {
      return;
    }
    const next = changes[KEY]?.newValue as CaptureDiagnostic | undefined;
    if (next !== undefined) {
      handler(next);
    }
  };
  browser.storage.onChanged.addListener(listener);
  return () => {
    browser.storage.onChanged.removeListener(listener);
  };
}

/** 給使用者看的說明。回傳 null 表示這個狀態不值得打擾使用者。 */
export function describeCapture(diagnostic: CaptureDiagnostic): string | null {
  switch (diagnostic.stage) {
    case 'ok':
      return null;
    case 'skipped:private-window':
      return '隱私瀏覽視窗不擷取畫面。';
    case 'skipped:inactive-tab':
      return '背景分頁未實際繪製，不擷取（避免存到空白畫面）。';
    case 'skipped:no-permission':
      return '缺少網站存取權限，無法擷取畫面。';
    case 'skipped:api-unavailable':
      return '剛取得權限，正在重新啟用畫面擷取，請稍候再瀏覽一次該頁面。';
    case 'skipped:disabled':
      return '自動擷取已在設定中關閉。';
    case 'skipped:blocklisted':
      return '這個網域在擷取黑名單中。';
    case 'skipped:not-open':
      // 值得說一聲：使用者剛加了書籤卻沒有預覽圖，而下一步該做什麼並不明顯
      return '剛加入的書籤沒有開啟中的分頁，無法擷取。可用「補抓預覽圖」抓 og:image。';
    case 'skipped:not-bookmarked':
    case 'skipped:fresh':
    case 'skipped:unsupported-url':
    case 'skipped:navigated-away':
      return null;
    case 'error':
      return `擷取畫面失敗：${diagnostic.detail ?? '未知原因'}`;
    case 'manual:ok':
      return '已把你選的圖片設為這個書籤的預覽圖。';
    case 'manual:not-bookmarked':
      return '這個頁面還沒有加入書籤，無法設定預覽圖。';
    case 'manual:failed':
      return `設定預覽圖失敗：${diagnostic.detail ?? '未知原因'}`;
  }
}
