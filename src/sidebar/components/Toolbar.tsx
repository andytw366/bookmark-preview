import { useState } from 'react';
import type { Density, PreviewSource } from '@/shared/types';
import { useBackfill, type BackfillKind } from '../hooks/useBackfill';
import { DensityToggle } from './DensityToggle';
import { PreviewOptionsMenu } from './PreviewOptionsMenu';

interface ToolbarProps {
  density: Density;
  onDensityChange: (density: Density) => void;
  previewSource: PreviewSource;
  onPreviewSourceChange: (source: PreviewSource) => void;
  /** 沒有網站存取權限時無法補抓，按鈕停用 */
  canBackfill: boolean;
  /**
   * 補抓要抓哪一邊。
   *
   * 這不是可有可無的參數：書籤頁與隱私空間頁共用這個工具列，若固定送
   * `thumbs/backfill`，站在隱私空間按下去只會去抓一般書籤 —— 按了沒反應。
   * 隱私空間那條路還必須加密寫入，兩者無法共用同一個實作。
   */
  backfillKind: BackfillKind;
  canSelect: boolean;
  selecting: boolean;
  selectedCount: number;
  /**
   * 多選時可執行的動作。
   *
   * 做成資料而不是一堆布林旗標，因為兩個畫面要的動作根本不同：書籤頁是
   * 「移動到…／移入隱私空間」，隱私空間是「移動到…／移出到…」。
   */
  selectionActions: SelectionAction[];
  onToggleSelecting: () => void;
  onSelectAll: () => void;
}

export interface SelectionAction {
  label: string;
  /** 主要動作用強調色 */
  primary?: boolean;
  disabled?: boolean;
  // exactOptionalPropertyTypes 之下，會被算出 undefined 的欄位要顯式允許它
  title?: string | undefined;
  /** 座標讓選擇器貼著按鈕跳出，不必捲回清單頂端 */
  onPick: (x: number, y: number) => void;
}

/**
 * 底部工具列。
 *
 * 這裡原本混了三種不同性質的東西，彼此沒有層級：設定一次就不再動的偏好
 * （預覽圖來源、顯示密度）、動作（補抓、全頁瀏覽、選取）、以及最多三行的
 * 暫時性狀態文字。五個控制項加上會換行的文字擠在 320px 寬的欄裡，
 * 結果就是一團看不出重點的東西。
 *
 * 改成三層：
 * 1. **常用的留在檯面上** —— 密度（瀏覽時真的會反覆切）與兩個動作。
 * 2. **偶爾用的收進溢出選單** —— 預覽圖來源與補抓，它們是設定一次或偶爾按一次
 *    的東西，不值得長期佔用寬度。
 * 3. **狀態文字只佔一行**，而且依優先序只顯示最重要的那一則；沒事時整行不存在。
 */
export function Toolbar({
  density,
  onDensityChange,
  previewSource,
  onPreviewSourceChange,
  canBackfill,
  backfillKind,
  canSelect,
  selecting,
  selectedCount,
  selectionActions,
  onToggleSelecting,
  onSelectAll,
}: ToolbarProps) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const backfill = useBackfill();

  if (selecting) {
    return (
      <footer className="toolbar">
        <div className="toolbar__bar toolbar__bar--wrap">
          <span className="toolbar__count">已選 {selectedCount} 個</span>
          <div className="toolbar__group">
            <button type="button" className="toolbar__action" onClick={onSelectAll}>
              全選
            </button>
            <button type="button" className="toolbar__action" onClick={onToggleSelecting}>
              取消
            </button>
          </div>
        </div>
        <div className="toolbar__bar toolbar__bar--wrap">
          <div className="toolbar__group">
            {selectionActions.map((action) => (
              <button
                key={action.label}
                type="button"
                className={`toolbar__action${action.primary === true ? ' toolbar__action--primary' : ''}`}
                disabled={selectedCount === 0 || action.disabled === true}
                title={action.title}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  action.onPick(rect.left, rect.top - 8);
                }}
              >
                {action.label}
              </button>
            ))}
          </div>
        </div>
      </footer>
    );
  }

  return (
    <footer className="toolbar">
      {backfill.status !== null ? <p className="toolbar__status">{backfill.status}</p> : null}

      <div className="toolbar__bar">
        <DensityToggle value={density} onChange={onDensityChange} />

        <div className="toolbar__group">
          {canSelect ? (
            <button
              type="button"
              className="toolbar__action"
              title="勾選多個項目，一次搬到其他資料夾或移入隱私空間"
              onClick={onToggleSelecting}
            >
              選取
            </button>
          ) : null}
          <button
            type="button"
            className="toolbar__action"
            title="在新分頁以整個視窗的寬度並排瀏覽書籤"
            onClick={() => {
              void browser.tabs.create({ url: browser.runtime.getURL('gallery/index.html') });
            }}
          >
            全頁瀏覽
          </button>
          <button
            type="button"
            className="toolbar__action toolbar__action--icon"
            title="更多選項"
            aria-label="更多選項"
            // haspopup="true" 而不是 "menu"：裡面是一個標題加幾個切換鈕
            // （aria-pressed），不是 menuitem 結構。宣告成 menu 會與實際內容不符。
            aria-haspopup="true"
            aria-expanded={menu !== null}
            onClick={(event) => {
              if (menu !== null) {
                setMenu(null);
                return;
              }
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.right - 200, y: rect.top - 6 });
            }}
          >
            <svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor" aria-hidden="true">
              <circle cx="4" cy="10" r="1.5" />
              <circle cx="10" cy="10" r="1.5" />
              <circle cx="16" cy="10" r="1.5" />
            </svg>
          </button>
        </div>
      </div>

      {menu !== null ? (
        <PreviewOptionsMenu
          x={menu.x}
          y={menu.y}
          previewSource={previewSource}
          onPreviewSourceChange={onPreviewSourceChange}
          canBackfill={canBackfill}
          backfillBusy={backfill.busy}
          backfillKind={backfillKind}
          onBackfill={backfill.start}
          onClose={() => {
            setMenu(null);
          }}
        />
      ) : null}
    </footer>
  );
}
