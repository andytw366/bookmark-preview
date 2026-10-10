import { useState } from 'react';
import type { Density, PreviewSource } from '@/shared/types';
import { Button, IconButton } from '../../ui/Button';
import { Menu, MenuItem } from '../../ui/Menu';
import { SegmentedControl } from '../../ui/SegmentedControl';
import type { BackfillKind, useBackfill } from '../hooks/useBackfill';
import { PreviewOptionsMenu } from './PreviewOptionsMenu';
import { t, tn } from '@/shared/i18n';

interface ToolbarProps {
  density: Density;
  onDensityChange: (density: Density) => void;
  previewSource: PreviewSource;
  onPreviewSourceChange: (source: PreviewSource) => void;
  entryIcons: boolean;
  onEntryIconsChange: (on: boolean) => void;
  /** 補抓的狀態（由 App 持有：完成的提示與「查看缺的」在清單那邊） */
  backfill: ReturnType<typeof useBackfill>;
  /** 沒有網站存取權限時無法補抓，選單項目停用 */
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
  /** 「選取」的提示。隱藏模式下不能提到隱私空間，所以由呼叫端挑 */
  selectHint: string;
  selecting: boolean;
  selectedCount: number;
  /**
   * 多選時可執行的動作。第一個 `primary` 是工具列上那顆主要按鈕，其餘收進旁邊的 ⋯。
   *
   * 做成資料而不是一堆布林旗標，因為兩個畫面要的動作根本不同：書籤頁是
   * 「移動到…／移入隱私空間」，隱私空間是「移動到…／移出到…」。
   */
  selectionActions: SelectionAction[];
  onToggleSelecting: () => void;
  /** 隱私空間那一頁才有：⋯ 選單最後一組的「刪除整個隱私空間…」 */
  destroyVault?: { count: number; onConfirm: () => void } | undefined;
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

const DENSITIES: { value: Density; icon: 'cards' | 'rows' | 'text'; title: string }[] = [
  { value: 'card', icon: 'cards', title: t('density_cards') },
  { value: 'row', icon: 'rows', title: t('density_list') },
  { value: 'text', icon: 'text', title: t('density_text') },
];

/**
 * 底部工具列（40px）：密度｜選取、全頁瀏覽 …… ⋯。
 *
 * 全部是 28px 的圖示鈕（附提示文字）—— 有字的按鈕在英文版會把 240px 撐爆。
 * 偶爾才用的（預覽圖來源、補抓、設定）收進 ⋯；補抓的狀態不再常駐成一行字：
 * 進行中是上緣一條細進度條，數字在選單裡，完成時浮出一則提示（由 App 畫）。
 */
export function Toolbar({
  density,
  onDensityChange,
  previewSource,
  onPreviewSourceChange,
  entryIcons,
  onEntryIconsChange,
  backfill,
  canBackfill,
  backfillKind,
  canSelect,
  selectHint,
  selecting,
  selectedCount,
  selectionActions,
  onToggleSelecting,
  destroyVault,
}: ToolbarProps) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [moreActions, setMoreActions] = useState<{ x: number; y: number } | null>(null);

  if (selecting) {
    const [primary, ...rest] = selectionActions;
    return (
      <footer className="toolbar toolbar--select">
        <IconButton icon="close" label={t('selection_exit')} onClick={onToggleSelecting} />
        <span className="toolbar__count" aria-live="polite">
          {tn('toolbar_selected', selectedCount)}
        </span>
        <span className="toolbar__spacer" />
        {rest.length > 0 ? (
          <IconButton
            icon="more"
            label={t('selection_more')}
            aria-haspopup="true"
            aria-expanded={moreActions !== null}
            on={moreActions !== null}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMoreActions(moreActions === null ? { x: rect.right, y: rect.top - 6 } : null);
            }}
          />
        ) : null}
        {primary === undefined ? null : (
          <Button
            variant="primary"
            disabled={selectedCount === 0 || primary.disabled === true}
            title={primary.title}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              primary.onPick(rect.left, rect.top - 8);
            }}
          >
            {primary.label}
          </Button>
        )}
        {moreActions !== null ? (
          <Menu
            x={moreActions.x}
            y={moreActions.y}
            align="end"
            role="menu"
            onClose={() => {
              setMoreActions(null);
            }}
          >
            {rest.map((action) => (
              <MenuItem
                key={action.label}
                label={action.label}
                title={action.title}
                disabled={selectedCount === 0 || action.disabled === true}
                onClick={() => {
                  const at = moreActions;
                  setMoreActions(null);
                  action.onPick(at.x - 208, at.y);
                }}
              />
            ))}
          </Menu>
        ) : null}
      </footer>
    );
  }

  const progress = backfill.progress;

  return (
    <footer className="toolbar">
      {progress === null ? null : (
        <span
          className="toolbar__progress"
          role="progressbar"
          aria-label={t('backfill_running')}
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
          style={{ width: `${String(Math.round((progress.done / progress.total) * 100))}%` }}
        />
      )}
      <SegmentedControl
        options={DENSITIES}
        value={density}
        onChange={onDensityChange}
        label={t('density_label')}
      />
      <span className="toolbar__divider" />
      {canSelect ? <IconButton icon="select" label={t('toolbar_select')} hint={selectHint} onClick={onToggleSelecting} /> : null}
      <IconButton
        icon="gallery"
        label={t('toolbar_gallery')}
        hint={t('toolbar_gallery_hint')}
        onClick={() => {
          void browser.tabs.create({ url: browser.runtime.getURL('gallery/index.html') });
        }}
      />
      <span className="toolbar__spacer" />
      <IconButton
        icon="more"
        label={t('toolbar_more')}
        aria-haspopup="true"
        aria-expanded={menu !== null}
        on={menu !== null}
        onClick={(event) => {
          if (menu !== null) {
            setMenu(null);
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.right, y: rect.top - 6 });
        }}
      />

      {menu !== null ? (
        <PreviewOptionsMenu
          x={menu.x}
          y={menu.y}
          align="end"
          previewSource={previewSource}
          onPreviewSourceChange={onPreviewSourceChange}
          entryIcons={entryIcons}
          onEntryIconsChange={onEntryIconsChange}
          canBackfill={canBackfill}
          backfillBusy={backfill.busy}
          backfillProgress={progress}
          backfillKind={backfillKind}
          onBackfill={backfill.start}
          captureNote={backfill.captureNote}
          destroyVault={destroyVault}
          onClose={() => {
            setMenu(null);
          }}
        />
      ) : null}
    </footer>
  );
}
