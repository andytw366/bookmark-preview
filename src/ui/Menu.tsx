import type { ReactNode } from 'react';
import { Popover } from '../sidebar/components/Popover';
import { Icon, type IconName } from './Icon';
import { RadioMark, SwitchMark } from './Toggles';

interface MenuProps {
  x: number;
  y: number;
  onClose: () => void;
  /** 只有 `menu`（一般選單）才標 `role="menu"`；裝了表單、確認文字的不是選單 */
  role?: 'menu' | undefined;
  /** 選單的名稱（例如「群組選項」）；省略就靠內容 */
  label?: string | undefined;
  /** `list`：很長、要捲動的清單（資料夾選擇器）；`prompt`：裝說明與按鈕的確認框 */
  variant?: 'list' | 'prompt' | undefined;
  /** 打開它的那個點的哪一邊對齊：`end` = 選單右緣貼著 x（⋯ 按鈕在右邊時） */
  align?: 'start' | 'end' | undefined;
  children: ReactNode;
}

/**
 * 浮動選單（寬 208px，項目高 28px）。位置、點外面關閉、焦點與方向鍵都在 `Popover`。
 */
export function Menu({ x, y, onClose, role, label, variant, align = 'start', children }: MenuProps) {
  return (
    <Popover
      x={x}
      y={y}
      align={align}
      className={variant === undefined ? 'menu' : `menu menu--${variant}`}
      role={role}
      label={label}
      onClose={onClose}
    >
      {children}
    </Popover>
  );
}

interface MenuItemProps {
  icon?: IconName | undefined;
  label: string;
  onClick: () => void;
  /** 不可逆的操作。永遠放在選單最後一組 */
  danger?: boolean | undefined;
  /** 停用的項目保留位置（不讓人以為這一筆不能做這件事），只是變淡 */
  disabled?: boolean | undefined;
  title?: string | undefined;
  /** 右側的小字（例如補抓進度） */
  end?: ReactNode;
  /** 開啟時焦點落在這一項（見 `Popover` 的 `data-autofocus`） */
  autoFocus?: boolean | undefined;
}

export function MenuItem({ icon, label, onClick, danger, disabled, title, end, autoFocus }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className={danger === true ? 'mi mi--danger' : 'mi'}
      disabled={disabled}
      title={title}
      onClick={onClick}
      {...(autoFocus === true ? { 'data-autofocus': '' } : {})}
    >
      {icon === undefined ? <span className="mi__pad" aria-hidden="true" /> : <Icon name={icon} />}
      <span className="mi__label">{label}</span>
      {end === undefined ? null : <span className="mi__end">{end}</span>}
    </button>
  );
}

/** 二選一（或多選一）的一項：左邊是圓點 */
export function MenuRadio({
  label,
  checked,
  title,
  onClick,
}: {
  label: string;
  checked: boolean;
  title?: string | undefined;
  onClick: () => void;
}) {
  return (
    <button type="button" role="menuitemradio" aria-checked={checked} className="mi" title={title} onClick={onClick}>
      <RadioMark on={checked} />
      <span className="mi__label">{label}</span>
    </button>
  );
}

/** 開關：右邊是 switch，一看就知道是「開／關」而不是二選一 */
export function MenuSwitch({
  label,
  checked,
  title,
  onClick,
}: {
  label: string;
  checked: boolean;
  title?: string | undefined;
  onClick: () => void;
}) {
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={checked} className="mi" title={title} onClick={onClick}>
      <span className="mi__label">{label}</span>
      <SwitchMark on={checked} />
    </button>
  );
}

export function MenuSeparator() {
  return <div className="msep" role="separator" />;
}

/** 小標題：只用在單選組上面（說明那幾個圓點在選什麼） */
export function MenuHeader({ children }: { children: ReactNode }) {
  return <div className="mh">{children}</div>;
}

/** 選單裡的說明文字（確認框的內文、空清單的提示） */
export function MenuNote({ children }: { children: ReactNode }) {
  return <p className="menu__note">{children}</p>;
}
