import type { ReactNode } from 'react';
import type { Density } from '@/shared/types';

interface DensityToggleProps {
  value: Density;
  onChange: (density: Density) => void;
}

/**
 * 密度切換用圖示而不是文字。
 *
 * 「大卡 / 小列 / 純文字」是 9 個中文字，在 320px 寬的側邊欄裡光這一組就吃掉
 * 快三分之一的橫向空間，逼得工具列其他項目換行。圖示各 14px，一整組不到 70px，
 * 而且三種密度的差別本來就是視覺性的 —— 用圖形表達比文字更直接。
 *
 * 圖示按鈕一律配 aria-label 與 title：沒有文字標籤時，那是唯一的可及名稱。
 */
const OPTIONS: { value: Density; label: string; icon: ReactNode }[] = [
  {
    value: 'card',
    label: '大縮圖卡片',
    icon: <rect x="3" y="4" width="14" height="12" rx="2" />,
  },
  {
    value: 'row',
    label: '小縮圖清單',
    // 一個小方塊加兩條線（= 一列有縮圖的清單項）。原本畫兩組堆疊的方塊加線條，
    // 在 15px 下四個元素糊成一團，看起來像亂碼而不是圖示。
    icon: (
      <>
        <rect x="3" y="6" width="8" height="8" rx="1.5" />
        <path d="M13.5 8.5h3.5M13.5 12h3.5" />
      </>
    ),
  },
  {
    value: 'text',
    label: '不顯示縮圖',
    icon: <path d="M3.5 6h13M3.5 10h13M3.5 14h9" />,
  },
];

export function DensityToggle({ value, onChange }: DensityToggleProps) {
  return (
    <div className="segmented" role="group" aria-label="顯示密度">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`segmented__item segmented__item--icon${
            option.value === value ? ' segmented__item--active' : ''
          }`}
          title={option.label}
          aria-label={option.label}
          aria-pressed={option.value === value}
          onClick={() => {
            onChange(option.value);
          }}
        >
          <svg
            viewBox="0 0 20 20"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            aria-hidden="true"
          >
            {option.icon}
          </svg>
        </button>
      ))}
    </div>
  );
}
