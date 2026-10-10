import { CheckMark } from '../../ui/Toggles';
import { t } from '@/shared/i18n';

/**
 * 多選時清單頂端的「全選（N）」：三態勾選框（全部／部分／都沒有）。
 * 按下去時全部勾起來；已經全勾了就全部取消。
 */
export function SelectAllRow({
  total,
  selected,
  onSelectAll,
  onClearAll,
}: {
  /** 這一層有幾個可以勾的 */
  total: number;
  /** 其中已經勾了幾個 */
  selected: number;
  onSelectAll: () => void;
  onClearAll: () => void;
}) {
  if (total === 0) {
    return null;
  }
  const state = selected === 0 ? false : selected >= total ? true : 'mixed';
  return (
    <button
      type="button"
      className="selhead"
      role="checkbox"
      aria-checked={state}
      onClick={state === true ? onClearAll : onSelectAll}
    >
      <CheckMark state={state} />
      {t('select_all_n', total)}
    </button>
  );
}
