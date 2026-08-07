import { useEffect, useState } from 'react';
import type { BookmarkNode } from '@/shared/types';
import { hostnameOf } from '@/shared/url';
import { Popover } from './Popover';

interface MoveInPromptProps {
  /** 要移入的項目；書籤或資料夾、一筆或多筆，文案會跟著變 */
  nodes: BookmarkNode[];
  /** 觸發點的視窗座標（單筆是那一列的鎖圖示，批量是工具列的「移入」按鈕） */
  x: number;
  y: number;
  onConfirm: (purgeHistory: boolean) => void;
  onCancel: () => void;
}

const HISTORY_PERMISSION: browser.permissions.Permissions = { permissions: ['history'] };
const PREVIEW_LIMIT = 3;

/** 選取範圍實際涵蓋幾個資料夾與幾個書籤（含子樹）。 */
function countTree(nodes: readonly BookmarkNode[]): { folders: number; links: number } {
  let folders = 0;
  let links = 0;
  const walk = (list: readonly BookmarkNode[], depth: number): void => {
    for (const node of list) {
      if (node.kind === 'link') {
        links += 1;
        continue;
      }
      folders += 1;
      // 深度上限：書籤樹不會這麼深，這是防禦而不是限制
      if (depth < 20) {
        walk(node.children, depth + 1);
      }
    }
  };
  walk(nodes, 0);
  return { folders, links };
}

/**
 * 移入隱私空間的二次確認。
 *
 * 這個動作不可逆（書籤會離開 Firefox 的書籤樹），所以不做成單擊即完成。
 *
 * **貼著觸發點跳出，而不是畫在清單上方。** 原本是內嵌在清單頂端的通知，
 * 於是在長清單裡點了下方某一列的鎖圖示之後，確認按鈕出現在畫面外 ——
 * 得先捲回最上面才能按下「移入」。
 *
 * 「同時清除瀏覽記錄」預設開啟：不清的話網址列自動完成仍會浮出這個網址，
 * 書籤藏起來了卻打幾個字就跳出來，隱私效果會有明顯破口。清除需要額外的
 * history 權限，因此勾選後在確認時才請求 —— permissions.request() 必須
 * 在使用者操作的處理器中呼叫。
 */
export function MoveInPrompt({ nodes, x, y, onConfirm, onCancel }: MoveInPromptProps) {
  const [purgeHistory, setPurgeHistory] = useState(true);
  const [hasHistoryPermission, setHasHistoryPermission] = useState(false);

  useEffect(() => {
    void browser.permissions.contains(HISTORY_PERMISSION).then(setHasHistoryPermission, () => undefined);
  }, []);

  const confirm = (): void => {
    if (purgeHistory && !hasHistoryPermission) {
      void browser.permissions.request(HISTORY_PERMISSION).then(
        (granted) => {
          onConfirm(granted);
        },
        () => {
          onConfirm(false);
        },
      );
      return;
    }
    onConfirm(purgeHistory);
  };

  const single = nodes.length === 1 ? nodes[0] : undefined;
  const label = (node: BookmarkNode): string =>
    node.title || (node.kind === 'link' ? hostnameOf(node.url) : '（未命名資料夾）');

  /*
   * 資料夾要顯示**實際筆數**。
   *
   * 「移入 1 個項目？」對資料夾是嚴重的低估 —— 使用者真正需要看到的是
   * 「這個資料夾及其 3 個子資料夾、共 247 個書籤會從 Firefox 書籤中移除」。
   * 這個動作不可逆，數字就是使用者判斷要不要按下去的依據。
   */
  const counts = countTree(nodes);
  const scope =
    counts.folders === 0
      ? null
      : `共 ${String(counts.folders)} 個資料夾、${String(counts.links)} 個書籤`;

  return (
    <Popover x={x} y={y} className="rowmenu rowmenu--prompt" onClose={onCancel}>
      <p className="rowmenu__heading">
        {single === undefined ? `移入 ${String(nodes.length)} 個項目？` : '移入隱私空間？'}
      </p>
      <p className="rowmenu__note">
        {single === undefined ? '這些項目' : `「${label(single)}」`}
        {scope === null ? '' : `（${scope}）`}會從 Firefox 的書籤中<strong>移除</strong>，
        解鎖隱私空間後才看得到。
        {counts.folders > 0 ? '資料夾層級原樣保留。' : ''}
      </p>
      {single === undefined ? (
        <ul className="rowmenu__preview">
          {nodes.slice(0, PREVIEW_LIMIT).map((node) => (
            <li key={node.id}>{label(node)}</li>
          ))}
          {nodes.length > PREVIEW_LIMIT ? <li>…還有 {nodes.length - PREVIEW_LIMIT} 個</li> : null}
        </ul>
      ) : null}
      <label className="gate__check">
        <input
          type="checkbox"
          checked={purgeHistory}
          onChange={(event) => {
            setPurgeHistory(event.target.checked);
          }}
        />
        同時清除{single === undefined ? '這些' : '該'}網址的瀏覽記錄
      </label>
      {purgeHistory && !hasHistoryPermission ? (
        <p className="rowmenu__note">按下「移入」時會請求瀏覽記錄權限。</p>
      ) : null}
      <div className="rowmenu__actions">
        <button type="button" className="chip chip--primary" onClick={confirm}>
          移入
        </button>
        <button type="button" className="chip" onClick={onCancel}>
          取消
        </button>
      </div>
    </Popover>
  );
}
