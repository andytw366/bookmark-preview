import { useEffect, useState } from 'react';
import type { BookmarkNode } from '@/shared/types';
import { hostnameOf } from '@/shared/url';
import { Button } from '../../ui/Button';
import { Menu } from '../../ui/Menu';
import { CheckField } from '../../ui/Toggles';
import { t, tn } from '@/shared/i18n';
import { Rich } from '../lib/rich';

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
    node.title || (node.kind === 'link' ? hostnameOf(node.url) : t('folder_untitled_folder'));

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
      : t('movein_scope', tn('unit_folders', counts.folders), tn('unit_bookmarks', counts.links));

  return (
    <Menu x={x} y={y} variant="prompt" onClose={onCancel}>
      <p className="menu__title">
        {single === undefined ? tn('movein_heading_many', nodes.length) : t('movein_heading_one')}
      </p>
      <p className="menu__note">
        <Rich
          text={t(
            'movein_body',
            single === undefined ? t('movein_these') : t('movein_named', label(single)),
            scope === null ? '' : t('movein_scope_paren', scope),
          )}
        />
        {counts.folders > 0 ? t('movein_keeps_hierarchy') : ''}
      </p>
      {single === undefined ? (
        <ul className="menu__list">
          {nodes.slice(0, PREVIEW_LIMIT).map((node) => (
            <li key={node.id}>{label(node)}</li>
          ))}
          {nodes.length > PREVIEW_LIMIT ? <li>{tn('movein_and_more', nodes.length - PREVIEW_LIMIT)}</li> : null}
        </ul>
      ) : null}
      <CheckField checked={purgeHistory} onChange={setPurgeHistory}>
        {single === undefined ? t('movein_purge_history_many') : t('movein_purge_history_one')}
      </CheckField>
      {purgeHistory && !hasHistoryPermission ? (
        <p className="menu__note">{t('movein_history_permission_note')}</p>
      ) : null}
      <div className="menu__actions">
        <Button variant="ghost" onClick={onCancel}>
          {t('action_cancel')}
        </Button>
        <Button variant="primary" onClick={confirm}>
          {t('action_move_in')}
        </Button>
      </div>
    </Menu>
  );
}
