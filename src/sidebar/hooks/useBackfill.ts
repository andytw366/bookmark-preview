import { useEffect, useState } from 'react';
import { request, subscribe, type BackfillReport } from '@/shared/messages';
import {
  describeCapture,
  getLastCapture,
  onCaptureRecorded,
  type CaptureDiagnostic,
} from '@/storage/diagnostics';

export type BackfillKind = 'thumbs/backfill' | 'vault/backfill';

interface Progress {
  done: number;
  total: number;
  ok: number;
}

interface BackfillApi {
  busy: boolean;
  /**
   * 一行狀態文字，依「進行中 → 剛完成 → 背景診斷」的優先序。
   * 沒事時是 null，呼叫端就整行不畫 —— 三則各佔一行會讓工具列高度跳動。
   */
  status: string | null;
  start: (kind: BackfillKind) => void;
}

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
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [capture, setCapture] = useState<CaptureDiagnostic | null>(null);

  useEffect(() => subscribe('backfill/progress', setProgress), []);

  useEffect(() => {
    void getLastCapture().then(setCapture, () => undefined);
    return onCaptureRecorded(setCapture);
  }, []);

  // 只在有必要打擾使用者時顯示（例如擷取失敗、權限不足），
  // 成功或「這頁本來就不該截圖」都不顯示
  const captureNote = capture === null ? null : describeCapture(capture);

  const status =
    progress !== null && progress.total > 0
      ? `補抓中 ${String(progress.done)} / ${String(progress.total)}（成功 ${String(progress.ok)}）`
      : (message ?? captureNote);

  return {
    busy,
    status,
    start: (kind) => {
      setBusy(true);
      setMessage(null);
      request(kind, undefined).then(
        (report: BackfillReport) => {
          setMessage(
            report.total === 0
              ? '每個書籤都已經有預覽圖了。'
              : `補抓完成：${String(report.ok)} / ${String(report.total)} 個書籤取得預覽圖。`,
          );
          setBusy(false);
          setProgress(null);
        },
        (cause: unknown) => {
          setMessage(cause instanceof Error ? cause.message : String(cause));
          setBusy(false);
          setProgress(null);
        },
      );
    },
  };
}
