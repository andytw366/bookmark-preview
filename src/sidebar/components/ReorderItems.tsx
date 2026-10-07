import { t } from '@/shared/i18n';

/**
 * 右鍵選單裡的「往前移／往後移」：拖拽排序的鍵盤替代（拖拽做得到的事，鍵盤也要做得到）。
 *
 * `null` 代表那個方向已經到底，項目照樣列出但停用 —— 整項消失的話，使用者會以為這張
 * 卡片不能排序。整個 `reorder` 省略則兩項都不出現（搜尋結果、最上層、側邊欄）。
 */
export interface ReorderActions {
  earlier: (() => void) | null;
  later: (() => void) | null;
}

export function ReorderItems({ reorder, onClose }: { reorder: ReorderActions; onClose: () => void }) {
  return (
    <>
      <button
        type="button"
        role="menuitem"
        className="rowmenu__item"
        disabled={reorder.earlier === null}
        title={t('row_move_earlier_hint')}
        onClick={() => {
          reorder.earlier?.();
          onClose();
        }}
      >
        {t('row_move_earlier')}
      </button>
      <button
        type="button"
        role="menuitem"
        className="rowmenu__item"
        disabled={reorder.later === null}
        title={t('row_move_later_hint')}
        onClick={() => {
          reorder.later?.();
          onClose();
        }}
      >
        {t('row_move_later')}
      </button>
    </>
  );
}
