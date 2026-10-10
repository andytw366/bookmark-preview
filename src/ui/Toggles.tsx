import type { ReactNode } from 'react';
import { Icon } from './Icon';

/**
 * 勾選框、單選圓點、開關的**外觀**。
 *
 * 這三個只是畫出來的狀態，不是可以單獨點的控制項：它們放在一整列（清單列、選單項目、
 * 設定列）裡，點擊與鍵盤由那一列負責，可及的狀態也寫在那一列上（`aria-checked`）。
 * 只有 `Switch` 是例外 —— 設定頁的開關自己就是那顆按鈕。
 */
export function CheckMark({ state, size = 'md' }: { state: boolean | 'mixed'; size?: 'md' | 'lg' }) {
  const classes = ['cb', state === true ? 'cb--on' : '', state === 'mixed' ? 'cb--mixed' : '', size === 'lg' ? 'cb--lg' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <span className={classes} aria-hidden="true">
      {state === true ? <Icon name="check" /> : null}
    </span>
  );
}

export function RadioMark({ on }: { on: boolean }) {
  return <span className={on ? 'rd rd--on' : 'rd'} aria-hidden="true" />;
}

export function SwitchMark({ on }: { on: boolean }) {
  return <span className={on ? 'sw sw--on' : 'sw'} aria-hidden="true" />;
}

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** 可及名稱：開關旁邊的文字通常在另一個欄位，所以要另外給 */
  label: string;
  disabled?: boolean | undefined;
  size?: 'md' | 'lg';
}

/** 設定頁的開關：本身就是一顆 `role="switch"` 的按鈕。 */
export function Switch({ checked, onChange, label, disabled, size = 'lg' }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch${size === 'lg' ? ' switch--lg' : ''}`}
      onClick={() => {
        onChange(!checked);
      }}
    >
      <SwitchMark on={checked} />
    </button>
  );
}

/** 一個勾選框加一段說明（表單裡用），點文字也會勾 */
export function CheckField({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="check-field">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <span>{children}</span>
    </label>
  );
}
