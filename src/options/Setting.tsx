import type { ReactNode } from 'react';

/**
 * 設定頁的一組（標題＋說明＋一張卡片）。`danger` 是紅框的「危險操作」。
 */
export function SettingSection({
  id,
  title,
  badge,
  hint,
  danger = false,
  children,
}: {
  id: string;
  title: string;
  badge?: ReactNode;
  hint?: ReactNode;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <section id={id} className={danger ? 'sec sec--danger' : 'sec'} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>
        {title}
        {badge}
      </h2>
      {hint === undefined ? null : <p className="sec__hint">{hint}</p>}
      <div className="sec__card">{children}</div>
    </section>
  );
}

/**
 * 卡片裡的一列：左邊名稱與說明、右邊控制項；`below` 是撐滿整列寬度的內容
 * （展開的表單、狀態區、說明）。
 */
export function SettingItem({
  label,
  description,
  control,
  below,
}: {
  label: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  below?: ReactNode;
}) {
  return (
    <div className="item">
      <div className="item__label">
        <b>{label}</b>
        {description === undefined ? null : <div className="item__desc">{description}</div>}
      </div>
      {control === undefined ? null : <div className="item__control">{control}</div>}
      {below === undefined ? null : <div className="item__below">{below}</div>}
    </div>
  );
}
