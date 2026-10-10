import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

type NativeButton = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'title' | 'aria-label'>;

interface IconButtonProps extends NativeButton {
  icon: IconName;
  /** 可及名稱，同時當滑鼠提示 —— 沒有文字的按鈕這是唯一的名稱，所以必填 */
  label: string;
  /** 提示想多說一點時用；省略就用 `label` */
  hint?: string | undefined;
  /** 28px（側邊欄）或 32px（全頁、設定頁） */
  size?: 'md' | 'lg';
  /** 開啟中（例如它打開的選單還開著） */
  on?: boolean;
}

/**
 * 只有圖示的按鈕。`aria-label` 與 `title` 一律帶上：圖示沒有字，滑鼠使用者靠提示、
 * 螢幕閱讀器靠 `aria-label`，兩者缺一都是「看得到卻不知道是什麼」。
 */
export function IconButton({ icon, label, hint, size = 'md', on = false, className, ...rest }: IconButtonProps) {
  const classes = ['ib', size === 'lg' ? 'ib--lg' : '', on ? 'ib--on' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button type="button" className={classes} aria-label={label} title={hint ?? label} {...rest}>
      <Icon name={icon} />
    </button>
  );
}

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  variant?: 'default' | 'primary' | 'ghost' | 'danger' | 'outline';
  size?: 'md' | 'lg';
  icon?: IconName | undefined;
  title?: string | undefined;
  children: ReactNode;
}

/**
 * 有字的按鈕。主要按鈕（`primary`）每個畫面最多一顆；紅色（`danger`）只給不可逆的操作。
 */
export function Button({ variant = 'default', size = 'md', icon, className, children, type, ...rest }: ButtonProps) {
  const classes = [
    'btn',
    variant === 'default' ? '' : `btn--${variant}`,
    size === 'lg' ? 'btn--lg' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button type={type === 'submit' ? 'submit' : 'button'} className={classes} {...rest}>
      {icon === undefined ? null : <Icon name={icon} />}
      {children}
    </button>
  );
}
