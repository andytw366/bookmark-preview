import { useEffect, useState } from 'react';
import { request, subscribe, type BackfillReport } from '@/shared/messages';
import {
  describeCapture,
  getLastCapture,
  onCaptureRecorded,
  type CaptureDiagnostic,
} from '@/storage/diagnostics';
import { t } from '@/shared/i18n';

export type BackfillKind = 'thumbs/backfill' | 'vault/backfill';

export interface BackfillProgress {
  done: number;
  total: number;
  ok: number;
}

/** 剛做完的那一次。提示顯示幾秒就收掉，`id` 讓同樣的結果再來一次時也重新計時 */
export interface BackfillResult {
  id: number;
  kind: BackfillKind;
  /** 一句話（「補抓完成：7 / 8 有預覽圖」、或失敗原因） */
  text: string;
  /** 試過還是沒有預覽圖的（網址或隱私書籤 id）。空的就不提供「查看缺的」 */
  missing: string[];
}

interface BackfillApi {
  busy: boolean;
  /** 進行中的進度（工具列的細進度條、選單裡的「5 / 8」）。沒在跑是 null */
  progress: BackfillProgress | null;
  result: BackfillResult | null;
  dismissResult: () => void;
  /**
   * 背景擷取的診斷（例如沒有權限擷取某一頁）。只在有必要打擾使用者時才有，
   * 成功或「這頁本來就不該截圖」都是 null。
   */
  captureNote: string | null;
  start: (kind: BackfillKind) => void;
}

let nextResultId = 1;

/**
 * 補抓的狀態機。
 *
 * 抽成 hook 是為了讓側邊欄與全頁瀏覽共用同一份 —— 兩邊都要「補抓 + 進度 +
 * 擷取診斷」，各寫一份的話功能遲早會分岔（全頁瀏覽原本就整組缺漏）。
 *
 * `kind` 由呼叫時傳入而不是綁在 hook 上：同一個畫面會在書籤與隱私空間之間
 * 切換，而兩者要抓的是不同的東西。
 */
export function useBackfill(): BackfillApi {
  const [progress, setProgress] = useState<BackfillProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BackfillResult | null>(null);
  const [capture, setCapture] = useState<CaptureDiagnostic | null>(null);

  useEffect(() => subscribe('backfill/progress', setProgress), []);

  useEffect(() => {
    void getLastCapture().then(setCapture, () => undefined);
    return onCaptureRecorded(setCapture);
  }, []);

  const finish = (kind: BackfillKind, text: string, missing: string[]): void => {
    setResult({ id: nextResultId++, kind, text, missing });
    setBusy(false);
    setProgress(null);
  };

  return {
    busy,
    progress: progress !== null && progress.total > 0 && progress.done < progress.total ? progress : null,
    result,
    dismissResult: () => {
      setResult(null);
    },
    captureNote: capture === null ? null : describeCapture(capture),
    start: (kind) => {
      setBusy(true);
      setResult(null);
      request(kind, undefined).then(
        (report: BackfillReport) => {
          finish(
            kind,
            report.total === 0 ? t('backfill_all_done') : t('backfill_finished', report.ok, report.total),
            report.missing,
          );
        },
        (cause: unknown) => {
          finish(kind, cause instanceof Error ? cause.message : String(cause), []);
        },
      );
    },
  };
}
