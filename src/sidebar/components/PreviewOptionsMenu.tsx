import { useState } from 'react';
import type { PreviewSource } from '@/shared/types';
import { Button } from '../../ui/Button';
import { Menu, MenuHeader, MenuItem, MenuRadio, MenuSeparator, MenuSwitch } from '../../ui/Menu';
import type { BackfillKind, BackfillProgress } from '../hooks/useBackfill';
import { t, tn } from '@/shared/i18n';

interface PreviewOptionsMenuProps {
  x: number;
  y: number;
  /** `end`：右緣對齊 x（⋯ 按鈕在畫面右邊） */
  align?: 'start' | 'end' | undefined;
  previewSource: PreviewSource;
  onPreviewSourceChange: (source: PreviewSource) => void;
  /** 入口網址用網站圖示（`Settings.entryIcons`） */
  entryIcons: boolean;
  onEntryIconsChange: (on: boolean) => void;
  /**
   * 資料夾卡片顯示內容預覽（`Settings.folderPreviews`）。只有全頁瀏覽傳 —— 側邊欄的資料夾是一列，
   * 沒有地方放預覽。
   */
  folderPreviews?: { on: boolean; onChange: (on: boolean) => void } | undefined;
  /** 沒有網站存取權限時無法補抓 */
  canBackfill: boolean;
  backfillBusy: boolean;
  /** 進行中的進度，顯示在「補抓預覽圖」右邊 */
  backfillProgress: BackfillProgress | null;
  /**
   * 補抓要抓哪一邊。
   *
   * 站在隱私空間時必須是 `vault/backfill` —— 送 `thumbs/backfill` 會去抓一般書籤，
   * 表現成「按了沒反應」。而且隱私書籤的縮圖必須加密寫入，兩者無法共用實作。
   */
  backfillKind: BackfillKind;
  onBackfill: (kind: BackfillKind) => void;
  /** 背景擷取的診斷（沒有就是 null） */
  captureNote: string | null;
  /**
   * 「刪除整個隱私空間…」。只在隱私空間那一頁傳 —— 隱藏模式下書籤那一頁連這個字都不能出現。
   */
  destroyVault?: { count: number; onConfirm: () => void } | undefined;
  onClose: () => void;
}

/**
 * 「⋯ 更多選項」：預覽圖來源（單選）、首頁用網站圖示（開關）、補抓、設定頁入口，
 * 在隱私空間那一頁再加上最後一組的「刪除整個隱私空間…」。
 *
 * 側邊欄與全頁瀏覽共用同一份：共用元件讓「兩邊功能不能有缺少」變成結構上的保證，
 * 而不是每次改動都要記得同步兩處。
 */
export function PreviewOptionsMenu({
  x,
  y,
  align,
  previewSource,
  onPreviewSourceChange,
  entryIcons,
  onEntryIconsChange,
  folderPreviews,
  canBackfill,
  backfillBusy,
  backfillProgress,
  backfillKind,
  onBackfill,
  captureNote,
  destroyVault,
  onClose,
}: PreviewOptionsMenuProps) {
  const [confirmDestroy, setConfirmDestroy] = useState(false);

  if (confirmDestroy && destroyVault !== undefined) {
    return (
      <Menu x={x} y={y} align={align} variant="prompt" onClose={onClose}>
        <p className="menu__title">{t('vault_destroy_confirm')}</p>
        <p className="menu__note">{t('vault_destroy_warning', tn('unit_vault_bookmarks', destroyVault.count))}</p>
        {/* 焦點給「取消」：連按兩次 Enter 不該就刪掉整個隱私空間 */}
        <div className="menu__actions">
          <Button variant="ghost" data-autofocus="" onClick={onClose}>
            {t('action_cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              destroyVault.onConfirm();
              onClose();
            }}
          >
            {t('action_delete_confirm')}
          </Button>
        </div>
      </Menu>
    );
  }

  return (
    <Menu x={x} y={y} align={align} role="menu" label={t('toolbar_more')} onClose={onClose}>
      <MenuHeader>{t('preview_source')}</MenuHeader>
      <MenuRadio
        label={t('preview_cover_first')}
        title={t('preview_cover_first_hint')}
        checked={previewSource === 'cover-first'}
        onClick={() => {
          onPreviewSourceChange('cover-first');
          onClose();
        }}
      />
      <MenuRadio
        label={t('preview_capture_first')}
        title={t('preview_capture_first_hint')}
        checked={previewSource === 'screenshot-first'}
        onClick={() => {
          onPreviewSourceChange('screenshot-first');
          onClose();
        }}
      />
      <MenuSeparator />
      {/* 開關，不是單選：與上面兩項無關，它決定的是「入口網址」要不要整個跳過封面／截圖。
          選單開著不關，切了馬上看得到開關的狀態 */}
      <MenuSwitch
        label={t('preview_entry_icons')}
        title={t('preview_entry_icons_hint')}
        checked={entryIcons}
        onClick={() => {
          onEntryIconsChange(!entryIcons);
        }}
      />
      {folderPreviews === undefined ? null : (
        <MenuSwitch
          label={t('preview_folder_contents')}
          title={t('preview_folder_contents_hint')}
          checked={folderPreviews.on}
          onClick={() => {
            folderPreviews.onChange(!folderPreviews.on);
          }}
        />
      )}
      <MenuSeparator />
      <MenuItem
        icon="refresh"
        label={backfillBusy ? t('backfill_running') : t('backfill_start')}
        title={canBackfill ? t('backfill_hint') : t('backfill_needs_permission_hint')}
        disabled={backfillBusy || !canBackfill}
        end={
          backfillProgress === null
            ? undefined
            : `${String(backfillProgress.done)} / ${String(backfillProgress.total)}`
        }
        onClick={() => {
          onBackfill(backfillKind);
          onClose();
        }}
      />
      <MenuItem
        icon="settings"
        label={t('menu_settings')}
        onClick={() => {
          void browser.runtime.openOptionsPage();
          onClose();
        }}
      />
      {captureNote === null ? null : <p className="menu__diag">{captureNote}</p>}
      {destroyVault === undefined ? null : (
        <>
          <MenuSeparator />
          <MenuItem
            icon="trash"
            label={t('vault_destroy_action')}
            danger
            onClick={() => {
              setConfirmDestroy(true);
            }}
          />
        </>
      )}
    </Menu>
  );
}
