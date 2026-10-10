import { MenuItem } from '../../ui/Menu';
import { t } from '@/shared/i18n';

/**
 * 右鍵選單裡的「往前移／往後移」：拖拽排序的鍵盤替代（拖拽做得到的事，鍵盤也要做得到）。
 *
 * `null` 代表那個方向已經到底，項目照樣列出但停用 —— 整項消失的話，使用者會以為這張
 * 卡片不能排序。整個 `reorder` 省略則兩項都不出現（搜尋結果、最上層）。
 */
export interface ReorderActions {
  earlier: (() => void) | null;
  later: (() => void) | null;
  /** 側邊欄的清單只有一欄：叫「往上移／往下移」 */
  vertical?: boolean;
}

export function ReorderItems({ reorder, onClose }: { reorder: ReorderActions; onClose: () => void }) {
  const vertical = reorder.vertical === true;
  return (
    <>
      <MenuItem
        icon={vertical ? 'arrow-up' : 'arrow-left'}
        label={vertical ? t('row_move_up') : t('row_move_earlier')}
        title={vertical ? t('row_move_up_hint') : t('row_move_earlier_hint')}
        disabled={reorder.earlier === null}
        onClick={() => {
          reorder.earlier?.();
          onClose();
        }}
      />
      <MenuItem
        icon={vertical ? 'arrow-down' : 'arrow-right'}
        label={vertical ? t('row_move_down') : t('row_move_later')}
        title={vertical ? t('row_move_down_hint') : t('row_move_later_hint')}
        disabled={reorder.later === null}
        onClick={() => {
          reorder.later?.();
          onClose();
        }}
      />
    </>
  );
}
