import { Icon, type IconName } from './Icon';

export interface SegmentOption<T extends string | number> {
  value: T;
  /** 顯示的字；只有圖示時省略，改由 `title` 當可及名稱 */
  label?: string | undefined;
  icon?: IconName | undefined;
  /** 只有圖示時必填（同時是 `aria-label`）；有字時是額外的滑鼠提示 */
  title?: string | undefined;
}

interface SegmentedControlProps<T extends string | number> {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** 整組的名稱（例如「顯示密度」） */
  label: string;
  /** 分頁切換（書籤｜隱私）用 tablist；其餘是單選 */
  role?: 'radiogroup' | 'tablist';
  size?: 'md' | 'lg';
  /** 撐滿可用寬度，每一段平分 */
  fill?: boolean;
  className?: string | undefined;
}

/**
 * 分段控制。選中的那一段是浮起的 `--surface`（像原生控制項），不用強調色 ——
 * 強調色保留給「目前選取」與主要按鈕，分段控制到處都有，全塗成藍色會把重點沖淡。
 */
export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  label,
  role = 'radiogroup',
  size = 'md',
  fill = false,
  className,
}: SegmentedControlProps<T>) {
  const classes = ['seg', size === 'lg' ? 'seg--lg' : '', fill ? 'seg--fill' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes} role={role} aria-label={label}>
      {options.map((option) => {
        const selected = option.value === value;
        const name = option.label ?? option.title ?? '';
        return (
          <button
            key={String(option.value)}
            type="button"
            className={selected ? 'seg__item seg__item--on' : 'seg__item'}
            role={role === 'tablist' ? 'tab' : 'radio'}
            {...(role === 'tablist' ? { 'aria-selected': selected } : { 'aria-checked': selected })}
            aria-label={option.label === undefined ? name : undefined}
            title={option.title ?? (option.label === undefined ? name : undefined)}
            onClick={() => {
              onChange(option.value);
            }}
          >
            {option.icon === undefined ? null : <Icon name={option.icon} />}
            {option.label === undefined ? null : <span className="seg__label">{option.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
