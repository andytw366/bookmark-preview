import { t } from '@/shared/i18n';

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
      return t('capture_skip_private_window');
    case 'skipped:inactive-tab':
      return t('capture_skip_inactive_tab');
    case 'skipped:no-permission':
      return t('capture_skip_no_permission');
    case 'skipped:api-unavailable':
      return t('capture_skip_api_unavailable');
    case 'skipped:disabled':
      return t('capture_skip_disabled');
    case 'skipped:blocklisted':
      return t('capture_skip_blocklisted');
    case 'skipped:not-open':
      // 值得說一聲：使用者剛加了書籤卻沒有預覽圖，而下一步該做什麼並不明顯
      return t('capture_skip_not_open');
    case 'skipped:not-bookmarked':
    case 'skipped:fresh':
    case 'skipped:unsupported-url':
    case 'skipped:navigated-away':
      return null;
    case 'error':
      return t('capture_failed', diagnostic.detail ?? t('reason_unknown'));
    case 'manual:ok':
      return t('capture_manual_ok');
    case 'manual:not-bookmarked':
      return t('capture_manual_not_bookmarked');
    case 'manual:failed':
      return t('capture_manual_failed', diagnostic.detail ?? t('reason_unknown'));
  }
}
