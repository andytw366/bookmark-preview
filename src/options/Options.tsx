import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  request,
  subscribe,
  type FolderChoice,
  type SyncOutcome,
  type GridSyncStatus,
  type VaultSyncStatus,
} from '@/shared/messages';
import type { VaultEntry } from '@/shared/types';
import { DEFAULT_VAULT_TRIGGER, MIN_PASSWORD_LENGTH } from '@/shared/vault-entry';
import type { MergeReport } from '@/shared/vault-merge';
import { useSettings } from '@/sidebar/hooks/useSettings';
import { useVault } from '@/sidebar/hooks/useVault';
import { RecoveryKeyPanel } from '@/sidebar/components/RecoveryKeyPanel';
import { VaultGate } from '@/sidebar/components/VaultGate';
import { Button } from '@/ui/Button';
import { Icon, type IconName } from '@/ui/Icon';
import { SegmentedControl } from '@/ui/SegmentedControl';
import { Switch } from '@/ui/Toggles';
import { SettingItem, SettingSection } from './Setting';
import { t, tn } from '@/shared/i18n';
import { Rich } from '@/sidebar/lib/rich';

/**
 * 把 JSON 交給瀏覽器下載。
 *
 * 設定頁是一般的擴充套件分頁（`open_in_tab`；以前嵌在 `about:addons` 裡），不用 `browser.downloads`
 * （那要多一個權限）而是 Blob + `<a download>`。萬一這條路在某些環境下不動，
 * 呼叫端還會把內容顯示出來讓使用者自己複製 —— 備份是最後一道防線，
 * 不該因為一個下載細節而完全拿不到。
 */
function downloadJson(filename: string, json: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // 太早 revoke 會讓下載抓不到內容，寬鬆地等一段時間再放掉
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}

function describeMerge(report: MergeReport, adopted: boolean): string {
  const parts: string[] = [];
  if (adopted) {
    parts.push(t('merge_restored', tn('unit_bookmarks', report.bookmarks.added)));
    if (report.folders.added > 0) {
      parts.push(tn('unit_folders', report.folders.added));
    }
  } else {
    parts.push(t('merge_added', tn('unit_bookmarks', report.bookmarks.added)));
    if (report.bookmarks.updated > 0) {
      parts.push(t('merge_updated', report.bookmarks.updated));
    }
    if (report.folders.added > 0 || report.folders.updated > 0) {
      parts.push(
        t('merge_folders', report.folders.added, report.folders.updated),
      );
    }
  }
  let text = t('merge_sentence', parts.join(t('list_separator')));
  if (report.reattached > 0) {
    text += t('merge_reattached', report.reattached);
  }
  if (adopted) {
    text += t('merge_no_previews');
  }
  return text;
}

/**
 * 每種同步結果對使用者的說法。
 *
 * 一律顯示「同步完成」是不能接受的：同步在上鎖、還沒建立、遠端傳輸中這幾種情況下
 * 都會安靜地什麼都不做，那時說完成會讓人以為資料已經上去了。
 */
const OUTCOME_TEXT: Record<SyncOutcome, string> = {
  synced: t('outcome_synced'),
  unavailable: t('outcome_unavailable'),
  disabled: t('outcome_disabled'),
  'no-vault': t('outcome_no_vault'),
  busy: t('outcome_busy'),
  locked: t('outcome_locked'),
  waiting: t('outcome_waiting'),
  'deleted-elsewhere': t('outcome_deleted_elsewhere'),
  failed: t('outcome_failed'),
};

function formatBytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

/**
 * 設定頁。
 *
 * 隱私空間的建立與入口設定放在這裡而不是側邊欄，因為隱密模式下側邊欄
 * 不能有任何跟隱私空間有關的痕跡 —— 連「建立隱私空間」的按鈕都不能有。
 * 設定頁要從 about:addons 才進得來，一般人不會看到。
 */
export function Options() {
  const { settings, update } = useSettings();
  const vault = useVault();
  const [usage, setUsage] = useState<{ count: number; bytes: number } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [blocklistText, setBlocklistText] = useState('');
  const [folders, setFolders] = useState<FolderChoice[]>([]);

  // 備份
  const [backupText, setBackupText] = useState<string | null>(null);
  const [backupStatus, setBackupStatus] = useState<string | null>(null);
  const [restoreFile, setRestoreFile] = useState<{ name: string; text: string } | null>(null);
  const [restorePassword, setRestorePassword] = useState('');
  const [restoreRecoveryKey, setRestoreRecoveryKey] = useState('');
  const [restoreViaRecovery, setRestoreViaRecovery] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreStatus, setRestoreStatus] = useState<string | null>(null);

  // 主密碼與救援金鑰
  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [nextConfirm, setNextConfirm] = useState('');
  const [keyStatus, setKeyStatus] = useState<string | null>(null);
  const [shownKey, setShownKey] = useState<{ code: string; reason: 'regenerated' | 'revealed' } | null>(
    null,
  );
  /*
   * 那串碼顯示在這一節的上方，而「重新產生」的按鈕在下方 —— 不主動捲過去的話，
   * 按下按鈕之後畫面上什麼都沒變，看起來就像功能沒有效果。
   */
  const shownKeyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (shownKey !== null) {
      shownKeyRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [shownKey]);

  // 書籤的排列與群組的同步。背景頁打開／關掉之後要一點時間才算得出新的狀態，所以晚一點再問
  const [gridSync, setGridSync] = useState<GridSyncStatus | null>(null);
  useEffect(() => {
    const load = (): void => {
      void request('grid/sync-status', undefined).then(setGridSync, () => undefined);
    };
    load();
    const timer = setTimeout(load, 1_000);
    const off = subscribe('grid/changed', load);
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [settings?.syncGrid]);

  // 同步
  const [sync, setSync] = useState<VaultSyncStatus | null>(null);
  const [syncLoadError, setSyncLoadError] = useState<string | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncStatusText, setSyncStatusText] = useState<string | null>(null);

  const refreshSync = useCallback(async () => {
    try {
      setSync(await request('vault/sync-status', undefined));
      setSyncLoadError(null);
    } catch (error) {
      // 保留原因並讓使用者能重試 —— 只顯示「讀取中…」的話一次暫時失敗會變成永久卡住
      setSyncLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void request('bookmarks/folders', undefined).then(setFolders, () => undefined);
  }, []);

  /*
   * 預覽圖的張數與容量。隱藏模式又上鎖時背景頁不算隱私書籤的那些（見 `visibleThumbs`），
   * 所以解鎖、上鎖、切換入口時都要重問一次 —— 數字要跟著當下看得到的範圍走。
   */
  const usageScope = `${String(vault.state?.status)}/${String(settings?.vaultEntry)}`;
  useEffect(() => {
    void request('thumbs/usage', undefined).then(setUsage, () => undefined);
  }, [usageScope]);

  /**
   * 同步狀態會被背景頁的自動同步改在背後改動，所以兩則廣播都要訂閱：
   * `vault/sync-changed` 是同步自己的結果，`vault/changed` 涵蓋「合併進來了東西」。
   */
  useEffect(() => {
    void refreshSync();
    const offSync = subscribe('vault/sync-changed', setSync);
    const offVault = subscribe('vault/changed', () => {
      void refreshSync();
    });
    return () => {
      offSync();
      offVault();
    };
  }, [refreshSync]);

  useEffect(() => {
    if (settings !== null) {
      setBlocklistText(settings.captureBlocklist.join('\n'));
    }
  }, [settings]);

  const runSync = useCallback(
    async (work: () => Promise<VaultSyncStatus | void>, done: string): Promise<void> => {
      setSyncBusy(true);
      setSyncStatusText(null);
      try {
        const next = await work();
        if (next === undefined) {
          await refreshSync();
        } else {
          setSync(next);
          setSyncLoadError(null);
        }
        setSyncStatusText(done);
      } catch (error) {
        setSyncStatusText(error instanceof Error ? error.message : String(error));
        // 失敗後狀態一定要重讀：例如「覆蓋雲端」失敗時，畫面若還顯示舊的
        // 「雲端副本完整」，使用者會以為雲端還有那份東西
        await refreshSync();
      } finally {
        setSyncBusy(false);
      }
    },
    [refreshSync],
  );

  /** 「立刻同步」：照實回報這次到底做了什麼，而不是一律說完成。 */
  const runSyncNow = useCallback(async (): Promise<void> => {
    setSyncBusy(true);
    setSyncStatusText(null);
    try {
      const next = await request('vault/sync-now', undefined);
      setSync(next);
      setSyncLoadError(null);
      // lastOutcome 為 null 時不能假設成功 —— 那是「沒有結果可回報」，不是「完成了」
      setSyncStatusText(
        next.lastOutcome === null ? t('sync_requested') : OUTCOME_TEXT[next.lastOutcome],
      );
    } catch (error) {
      setSyncStatusText(error instanceof Error ? error.message : String(error));
      await refreshSync();
    } finally {
      setSyncBusy(false);
    }
  }, [refreshSync]);

  // 主密碼：按「更改主密碼」才展開那三個欄位
  const [changingPassword, setChangingPassword] = useState(false);
  // 危險操作：每一項按下去先展開確認，不會一按就做
  const [confirming, setConfirming] = useState<'regenerate' | 'clear' | 'destroy' | 'forget' | null>(null);
  const [regenPassword, setRegenPassword] = useState('');
  const [dangerStatus, setDangerStatus] = useState<string | null>(null);
  // 左側目錄：目前捲到哪一組
  const [activeSection, setActiveSection] = useState('previews');

  /*
   * 隱藏模式下一上鎖，隱私空間相關的訊息、展開的表單、顯示中的救援金鑰全部收掉。
   * 區塊藏起來了，但「已產生新的救援金鑰」這類留在畫面上的字一樣會說出這台電腦有隱私空間。
   */
  const concealedNow = settings?.vaultEntry === 'hidden' && vault.state !== null && vault.state.status !== 'unlocked';
  useEffect(() => {
    if (!concealedNow) {
      return;
    }
    setShownKey(null);
    setKeyStatus(null);
    setDangerStatus(null);
    setConfirming((current) => (current === 'clear' ? current : null));
    setRegenPassword('');
    setChangingPassword(false);
    setCurrentPassword('');
    setNextPassword('');
    setNextConfirm('');
    setBackupText(null);
    setBackupStatus(null);
    setRestoreStatus(null);
    setRestorePassword('');
    setRestoreRecoveryKey('');
    setSyncStatusText(null);
  }, [concealedNow]);

  useEffect(() => {
    // 目前這一組＝上緣已經捲過視窗高度 30% 的最後一組；捲到底就是最後一組（它可能永遠到不了那條線）
    const update = (): void => {
      const sections = [...document.querySelectorAll<HTMLElement>('section.sec')];
      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      const line = window.innerHeight * 0.3;
      const current = atBottom
        ? sections[sections.length - 1]
        : sections.filter((section) => section.getBoundingClientRect().top <= line).pop();
      setActiveSection(current?.id ?? sections[0]?.id ?? 'previews');
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
    // 哪幾組存在會隨入口設定與解鎖狀態改變（「密碼與備份」可能整組不在）
  }, [usageScope]);

  if (settings === null || vault.state === null) {
    return <div className="opts opts--loading">{t('options_loading')}</div>;
  }

  const vaultStatus = vault.state.status;
  /**
   * 本機到底有沒有隱私空間。
   *
   * 不能用 `vaultStatus === 'locked'` 代替：本機沒有、但雲端有一份副本時狀態也是
   * `locked`（那是「換裝置後可以用密碼進來」的表示）。兩者要做的事完全不同 ——
   * 一個要先解鎖，另一個根本沒有東西可以解鎖。
   */
  const hasLocalVault = sync?.hasLocalVault ?? vaultStatus !== 'absent';
  /** 雲端有一份（含還在傳輸中）而本機沒有：這時絕對不能讓使用者「建立」新的。 */
  const remoteAwaitingRestore = sync !== null && sync.remote !== 'absent' && !sync.hasLocalVault;
  const unlocked = vaultStatus === 'unlocked';

  /*
   * 隱藏模式下，沒有解鎖時設定頁要和「從沒建立過隱私空間」的人看到的一模一樣：
   * 設定頁不用密碼就打得開，任何一點跟「這台電腦有沒有在用」有關的東西都不能出現 ——
   * 狀態、移出落點、自動上鎖、雲端副本、密碼與備份、放棄／刪除。也不能留空位或
   * 「解鎖以查看更多」之類的暗示。
   *
   * 「入口」與「觸發字串」兩節照樣顯示：它們不論有沒有建立隱私空間都存在，透露不了什麼，
   * 而忘了觸發字串的人還能從這裡查回來（真正的防線是密碼）。
   *
   * 建立隱私空間的表單在隱藏模式下任何狀態都不出現（有沒有那張表單本身就是線索），
   * 建立一律從側邊欄搜尋框輸入觸發字串開始。
   */
  const concealed = settings.vaultEntry === 'hidden' && !unlocked;
  const canCreateHere =
    settings.vaultEntry === 'tab' && !remoteAwaitingRestore && (vaultStatus === 'absent' || vaultStatus === 'legacy');

  const usageText =
    usage === null
      ? t('options_storage_counting')
      : t('options_storage_usage', tn('unit_previews', usage.count), (usage.bytes / 1_048_576).toFixed(1));

  const nav: { id: string; label: string; icon: IconName; danger?: boolean }[] = [
    { id: 'previews', label: t('options_nav_previews'), icon: 'image' },
    { id: 'sync', label: t('options_nav_sync'), icon: 'sync' },
    { id: 'vault', label: t('tab_vault'), icon: 'lock' },
    ...(concealed ? [] : [{ id: 'keys', label: t('options_keys_section'), icon: 'key' as const }]),
    { id: 'danger', label: t('options_danger_title'), icon: 'warning', danger: true },
  ];

  const statusLine = (text: string | null): ReactNode =>
    text === null ? null : (
      <p className="item__status" role="status">
        {text}
      </p>
    );

  /** 危險操作的確認：說明＋取消＋紅色的確定 */
  const confirmPanel = (message: ReactNode, confirmLabel: string, onConfirm: () => void, disabled = false) => (
    <div className="confirm">
      <div className="confirm__text">{message}</div>
      <div className="confirm__actions">
        <Button
          size="lg"
          onClick={() => {
            setConfirming(null);
            setRegenPassword('');
          }}
        >
          {t('action_cancel')}
        </Button>
        <Button variant="danger" size="lg" disabled={disabled} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  );

  return (
    <div className="opts">
      <header className="opts__head">
        <div className="opts__titles">
          <div className="opts__product">{t('extension_name')}</div>
          <h1>{t('options_title')}</h1>
        </div>
        <span className="opts__spacer" />
        <p className="opts__lede">
          <Icon name="shield" />
          {settings.vaultSyncEnabled && !concealed ? t('options_lede_sync') : t('options_lede')}
        </p>
      </header>

      <div className="opts__wrap">
        <nav className="opts__nav" aria-label={t('options_nav_label')}>
          {nav.map((entry) => (
            <a
              key={entry.id}
              href={`#${entry.id}`}
              className={[
                'opts__navitem',
                activeSection === entry.id ? 'opts__navitem--on' : '',
                entry.danger === true ? 'opts__navitem--danger' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              aria-current={activeSection === entry.id ? 'true' : undefined}
              onClick={(event) => {
                event.preventDefault();
                document.getElementById(entry.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                setActiveSection(entry.id);
              }}
            >
              <Icon name={entry.icon} />
              {entry.label}
            </a>
          ))}
        </nav>

        <main className="opts__main">
          {/* ── 預覽圖 ── */}
          <SettingSection id="previews" title={t('options_nav_previews')}>
            <SettingItem
              label={t('options_capture_label')}
              description={t('options_capture_desc')}
              control={
                <Switch
                  label={t('options_capture_label')}
                  checked={settings.captureEnabled}
                  onChange={(captureEnabled) => {
                    update({ captureEnabled });
                  }}
                />
              }
            />
            <SettingItem
              label={t('options_recapture_label')}
              description={t('options_recapture_desc')}
              control={
                <>
                  <input
                    className="input input--lg input--num"
                    type="number"
                    min={1}
                    max={365}
                    aria-label={t('options_recapture_label')}
                    value={settings.thumbMaxAgeDays}
                    onChange={(event) => {
                      const days = Number(event.target.value);
                      if (Number.isFinite(days) && days >= 1) {
                        update({ thumbMaxAgeDays: days });
                      }
                    }}
                  />
                  <span>{t('options_days')}</span>
                </>
              }
            />
            <SettingItem
              label={t('preview_folder_contents')}
              description={t('preview_folder_contents_hint')}
              control={
                <Switch
                  label={t('preview_folder_contents')}
                  checked={settings.folderPreviews}
                  onChange={(folderPreviews) => {
                    update({ folderPreviews });
                  }}
                />
              }
            />
            <SettingItem
              label={t('options_blocklist_title')}
              description={t('options_blocklist_hint')}
              below={
                <textarea
                  className="input input--mono"
                  rows={4}
                  aria-label={t('options_blocklist_title')}
                  value={blocklistText}
                  onChange={(event) => {
                    setBlocklistText(event.target.value);
                  }}
                  onBlur={() => {
                    update({
                      captureBlocklist: blocklistText
                        .split('\n')
                        .map((line) => line.trim())
                        .filter((line) => line !== ''),
                    });
                  }}
                />
              }
            />
            <SettingItem
              label={t('options_storage_title')}
              description={usageText}
              control={
                <Button
                  variant="outline"
                  size="lg"
                  title={t('options_reset_sitewide_hint')}
                  onClick={() => {
                    void request('site-stats/clear', undefined).then(
                      () => {
                        setStatus(t('options_sitewide_reset'));
                      },
                      () => undefined,
                    );
                  }}
                >
                  {t('options_reset_sitewide')}
                </Button>
              }
              below={status === null ? undefined : statusLine(status)}
            />
          </SettingSection>

          {/* ── 同步 ── */}
          <SettingSection id="sync" title={t('options_nav_sync')}>
            <SettingItem
              label={t('options_grid_sync_checkbox')}
              description={t('options_grid_sync_hint')}
              control={
                <div className="item__stack">
                  <Switch
                    label={t('options_grid_sync_checkbox')}
                    checked={settings.syncGrid}
                    disabled={gridSync?.available === false}
                    onChange={(syncGrid) => {
                      update({ syncGrid });
                    }}
                  />
                  {gridSync?.enabled === true && !gridSync.over ? (
                    <span className="item__small">
                      {t('options_grid_sync_usage', formatBytes(gridSync.total), formatBytes(gridSync.budget))}
                    </span>
                  ) : null}
                </div>
              }
              below={
                gridSync?.available === false ? (
                  <p className="item__desc">{t('options_grid_sync_unavailable')}</p>
                ) : gridSync?.enabled === true && (gridSync.over || gridSync.folders.length > 0) ? (
                  <div className="note note--warn">
                    <Icon name="warning" />
                    <div>
                      {gridSync.over ? (
                        <p>{t('options_grid_sync_over', formatBytes(gridSync.total), formatBytes(gridSync.budget))}</p>
                      ) : null}
                      <ul className="item__list">
                        {gridSync.folders.map((folder) => (
                          <li key={folder.title}>
                            {folder.localOnly
                              ? t('options_grid_sync_local_only', folder.title, formatBytes(folder.bytes))
                              : t('options_grid_sync_folder', folder.title, formatBytes(folder.bytes))}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                ) : undefined
              }
            />
            {concealed ? null : (
              <SettingItem
                label={t('options_sync_checkbox')}
                description={<Rich text={t('options_sync_hint')} />}
                control={
                  <Switch
                    label={t('options_sync_checkbox')}
                    checked={settings.vaultSyncEnabled}
                    onChange={(enabled) => {
                      update({ vaultSyncEnabled: enabled });
                      setSyncStatusText(enabled ? t('options_sync_on') : t('options_sync_off'));
                      void refreshSync();
                    }}
                  />
                }
                below={
                  <div className="panel">
                    {syncLoadError !== null && sync === null ? (
                      <div className="panel__row">
                        <p className="item__status">{t('options_sync_unreadable', syncLoadError)}</p>
                        <Button
                          variant="outline"
                          size="lg"
                          onClick={() => {
                            void refreshSync();
                          }}
                        >
                          {t('action_retry')}
                        </Button>
                      </div>
                    ) : sync === null ? (
                      <p className="item__desc">{t('options_sync_loading')}</p>
                    ) : !sync.available ? (
                      <p className="item__status">{t('outcome_unavailable')}</p>
                    ) : (
                      <>
                        <div className="panel__row">
                          <dl className="kv">
                            <dt>{t('options_sync_remote')}</dt>
                            <dd>
                              {sync.remote === 'absent' ? (
                                <span className="badge badge--mute">{t('options_sync_remote_absent')}</span>
                              ) : sync.remote === 'partial' ? (
                                <span className="badge badge--warn">{t('options_sync_remote_partial')}</span>
                              ) : (
                                <span className="badge badge--ok">
                                  {t('options_sync_remote_ok', formatTime(sync.remoteUpdatedAt ?? 0))}
                                </span>
                              )}
                            </dd>
                            <dt>{t('options_sync_quota')}</dt>
                            <dd className="kv__meter">
                              <span className="meter" aria-hidden="true">
                                <i
                                  className={sync.wouldFit ? undefined : 'meter--over'}
                                  style={{ width: `${String(Math.min(100, (sync.bytes / Math.max(1, sync.quota)) * 100))}%` }}
                                />
                              </span>
                              {formatBytes(sync.bytes)} / {formatBytes(sync.quota)}
                              {sync.wouldFit ? '' : t('options_sync_does_not_fit')}
                            </dd>
                            <dt>{t('options_sync_last')}</dt>
                            <dd>
                              {sync.lastSyncedAt === null ? t('options_sync_never') : formatTime(sync.lastSyncedAt)}
                              {sync.lastOutcome !== null && sync.lastOutcome !== 'synced' ? (
                                <span className="item__small">
                                  {t('options_sync_last_attempt', OUTCOME_TEXT[sync.lastOutcome])}
                                </span>
                              ) : null}
                            </dd>
                          </dl>
                          <div className="panel__actions">
                            <Button
                              variant="outline"
                              size="lg"
                              disabled={syncBusy || !settings.vaultSyncEnabled}
                              title={t('options_sync_now_hint')}
                              onClick={() => {
                                void runSyncNow();
                              }}
                            >
                              {t('options_sync_now')}
                            </Button>
                            {!sync.hasLocalVault && sync.remote === 'ok' ? (
                              <Button
                                variant="outline"
                                size="lg"
                                disabled={syncBusy || !settings.vaultSyncEnabled}
                                title={settings.vaultSyncEnabled ? undefined : t('options_sync_needs_checkbox')}
                                onClick={() => {
                                  void runSync(async () => {
                                    await request('vault/sync-adopt', undefined);
                                  }, t('options_sync_adopted'));
                                }}
                              >
                                {t('options_sync_adopt')}
                              </Button>
                            ) : null}
                            {sync.deletedElsewhere ? (
                              <Button
                                variant="outline"
                                size="lg"
                                disabled={syncBusy}
                                onClick={() => {
                                  void runSync(async () => request('vault/sync-resume', undefined), t('options_sync_resumed'));
                                }}
                              >
                                {t('options_sync_resume')}
                              </Button>
                            ) : null}
                            {sync.remote !== 'absent' && sync.hasLocalVault ? (
                              <Button
                                variant="outline"
                                size="lg"
                                disabled={syncBusy || !sync.wouldFit}
                                title={sync.wouldFit ? t('options_sync_overwrite_hint') : t('options_sync_overwrite_disabled')}
                                onClick={() => {
                                  void runSync(
                                    async () => request('vault/sync-overwrite', undefined),
                                    t('options_sync_overwritten'),
                                  );
                                }}
                              >
                                {t('options_sync_overwrite')}
                              </Button>
                            ) : null}
                            {sync.remote !== 'absent' ? (
                              <Button
                                variant="outline"
                                size="lg"
                                disabled={syncBusy}
                                onClick={() => {
                                  void runSync(async () => request('vault/sync-clear', undefined), t('options_sync_cleared'));
                                }}
                              >
                                {t('options_sync_clear')}
                              </Button>
                            ) : null}
                          </div>
                        </div>
                        {sync.deletedElsewhere ? (
                          <div className="note note--warn">
                            <Icon name="warning" />
                            <p>
                              <Rich text={t('options_sync_deleted_elsewhere')} />
                            </p>
                          </div>
                        ) : null}
                        {!sync.wouldFit ? (
                          <div className="note note--warn">
                            <Icon name="warning" />
                            <p>{t('options_sync_over_quota')}</p>
                          </div>
                        ) : null}
                        {sync.sameVault === false ? (
                          <div className="note note--warn">
                            <Icon name="warning" />
                            <p>
                              <Rich text={t('options_sync_different_vault')} />
                            </p>
                          </div>
                        ) : null}
                        {sync.lastError !== null ? (
                          <p className="item__status">{t('options_sync_last_error', sync.lastError)}</p>
                        ) : null}
                      </>
                    )}
                    {/* 訊息放在 available 分支外面：同步不可用或狀態讀不到時，開關的回饋也還是要看得到 */}
                    {statusLine(syncStatusText)}
                    {/*
                      折起來而不是刪掉：這兩件事都實際造成過誤解（按了好幾次卻發現另一台沒資料、
                      在新裝置上按了「建立」導致兩份金鑰不同）。但它們是「出問題時才需要讀」的內容。
                    */}
                    <details className="details">
                      <summary>{t('options_sync_not_seen')}</summary>
                      <p>
                        <Rich text={t('options_sync_not_seen_1')} />
                      </p>
                      <p>
                        <Rich text={t('options_sync_not_seen_2')} />
                      </p>
                    </details>
                    <details className="details">
                      <summary>{t('options_sync_limits')}</summary>
                      <ul className="item__list">
                        <li>
                          <Rich text={t('options_sync_limit_android')} />
                        </li>
                        <li>
                          <Rich text={t('options_sync_limit_schedule')} />
                        </li>
                        <li>
                          <Rich text={t('options_sync_limit_account')} />
                        </li>
                        <li>{t('options_sync_limit_stale')}</li>
                        <li>
                          <Rich text={t('options_sync_limit_unlocked')} />
                        </li>
                        <li>
                          <Rich text={t('options_sync_limit_salt')} />
                        </li>
                        <li>{t('options_sync_limit_quota')}</li>
                        <li>{t('options_sync_limit_previews')}</li>
                      </ul>
                    </details>
                  </div>
                }
              />
            )}
          </SettingSection>

          {/* ── 隱私空間 ── */}
          <SettingSection
            id="vault"
            title={t('tab_vault')}
            badge={
              concealed ? undefined : unlocked && vault.state.status === 'unlocked' ? (
                <span className="badge badge--ok">
                  {t('options_badge_unlocked', tn('unit_vault_bookmarks', vault.state.bookmarkCount))}
                </span>
              ) : vaultStatus === 'locked' && hasLocalVault ? (
                <span className="badge badge--mute">{t('options_status_locked')}</span>
              ) : undefined
            }
            hint={concealed || !unlocked ? undefined : t('options_vault_manage_hint')}
          >
            <SettingItem
              label={t('options_entry_label')}
              description={t('options_entry_hint')}
              control={
                <SegmentedControl
                  size="lg"
                  label={t('options_entry_label')}
                  options={[
                    { value: 'hidden' as VaultEntry, label: t('options_entry_hidden'), title: t('options_entry_hidden_hint') },
                    { value: 'tab' as VaultEntry, label: t('options_entry_tab') },
                  ]}
                  value={settings.vaultEntry}
                  onChange={(vaultEntry) => {
                    update({ vaultEntry });
                  }}
                />
              }
            />
            <SettingItem
              label={t('options_trigger_title')}
              description={t('options_trigger_hint')}
              control={
                <input
                  className="input input--lg input--mono input--trigger"
                  type="text"
                  aria-label={t('options_trigger_title')}
                  value={settings.vaultTrigger}
                  placeholder={DEFAULT_VAULT_TRIGGER}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    update({ vaultTrigger: event.target.value });
                  }}
                />
              }
              below={
                settings.vaultTrigger.trim() === '' ? (
                  <div className="note note--warn">
                    <Icon name="warning" />
                    <p>{t('options_trigger_empty')}</p>
                  </div>
                ) : settings.vaultTrigger.trim() === DEFAULT_VAULT_TRIGGER ? (
                  <div className="note note--warn">
                    <Icon name="warning" />
                    <p>
                      <Rich text={t('options_trigger_advice')} />
                    </p>
                  </div>
                ) : undefined
              }
            />
            {concealed ? null : (
              <>
                <SettingItem
                  label={t('options_export_target_label')}
                  description={`${t('options_export_target_hint')}${t('options_export_target_fallback')}`}
                  control={
                    <select
                      className="input input--lg input--select"
                      aria-label={t('options_export_target_label')}
                      value={settings.vaultExportFolderId ?? ''}
                      onChange={(event) => {
                        const value = event.target.value;
                        update({ vaultExportFolderId: value === '' ? null : value });
                      }}
                    >
                      <option value="">{t('options_firefox_default_folder')}</option>
                      {folders.map((folder) => (
                        <option key={folder.id} value={folder.id}>
                          {' '.repeat(folder.depth)}
                          {folder.title}
                        </option>
                      ))}
                    </select>
                  }
                />
                <SettingItem
                  label={t('options_autolock_title')}
                  description={`${t('options_autolock_hint')}${t('options_autolock_hint2')}`}
                  control={
                    <>
                      <span>{t('options_autolock_before')}</span>
                      <input
                        className="input input--lg input--num"
                        type="number"
                        min={1}
                        max={240}
                        aria-label={t('options_autolock_title')}
                        value={settings.autoLockMinutes}
                        onChange={(event) => {
                          const minutes = Number(event.target.value);
                          if (!Number.isFinite(minutes) || minutes < 1) {
                            return;
                          }
                          // input 的 max 只擋得住上下箭頭，打字打出來的值照樣進得來
                          // （實測輸入 240 的過程中出現過 5040 並被存下去）。自動上鎖被
                          // 無限延後是安全性方向的問題，所以這裡自己夾一次。
                          update({ autoLockMinutes: Math.min(240, Math.round(minutes)) });
                        }}
                      />
                      <span>{t('options_autolock_after')}</span>
                    </>
                  }
                />
              </>
            )}
            {remoteAwaitingRestore && !concealed ? (
              /*
               * 雲端已經有一份、本機還沒有 —— 這時**不能**顯示建立表單。
               * 在這裡建立會產生新的 salt，兩份從此永遠合不起來，而後續同步會把雲端
               * 那份覆蓋掉；那正是災難還原最需要它的時候。
               */
              <SettingItem
                label={t('vault_create_title')}
                below={
                  <div className="note note--warn">
                    <Icon name="warning" />
                    <p>
                      <Rich text={t('options_remote_awaiting_restore')} />
                    </p>
                  </div>
                }
              />
            ) : canCreateHere ? (
              <SettingItem
                label={t('vault_create_title')}
                below={
                  <div className="panel panel--narrow">
                    <VaultGate
                      state={vault.state}
                      onCreate={vault.create}
                      onUnlock={() => undefined}
                      onUnlockWithRecoveryKey={() => undefined}
                      onForget={() => {
                        void vault.forget();
                      }}
                    />
                  </div>
                }
              />
            ) : null}
            {vault.error !== null && !concealed ? (
              <SettingItem label={t('options_error_label')} below={statusLine(vault.error)} />
            ) : null}
          </SettingSection>

          {/* ── 密碼與備份 ── */}
          {concealed ? null : (
            <SettingSection id="keys" title={t('options_keys_section')} hint={t('options_keys_hint')}>
              <SettingItem
                label={t('options_recovery_label')}
                description={unlocked ? t('options_recovery_desc') : t('options_keys_need_unlock')}
                control={
                  <Button
                    variant="outline"
                    size="lg"
                    disabled={!unlocked}
                    onClick={() => {
                      setKeyStatus(null);
                      void request('vault/reveal-recovery', undefined).then(
                        ({ recoveryKey }) => {
                          setShownKey({ code: recoveryKey, reason: 'revealed' });
                        },
                        (error: unknown) => {
                          setKeyStatus(error instanceof Error ? error.message : String(error));
                        },
                      );
                    }}
                  >
                    {t('options_reveal_recovery')}
                  </Button>
                }
                below={
                  shownKey !== null ? (
                    <div ref={shownKeyRef}>
                      <RecoveryKeyPanel
                        recoveryKey={shownKey.code}
                        reason={shownKey.reason}
                        onDismiss={() => {
                          setShownKey(null);
                        }}
                      />
                    </div>
                  ) : undefined
                }
              />
              <SettingItem
                label={t('options_password_label')}
                description={<Rich text={t('options_change_password_hint')} />}
                control={
                  <Button
                    variant="outline"
                    size="lg"
                    disabled={!unlocked}
                    aria-expanded={changingPassword}
                    onClick={() => {
                      setChangingPassword(!changingPassword);
                    }}
                  >
                    {t('options_change_password_title')}
                  </Button>
                }
                below={
                  changingPassword && unlocked ? (
                    <div className="panel panel--grid">
                      <label className="field">
                        {t('options_current_password')}
                        <input
                          className="input input--lg"
                          type="password"
                          value={currentPassword}
                          autoComplete="off"
                          onChange={(event) => {
                            setCurrentPassword(event.target.value);
                          }}
                        />
                      </label>
                      <label className="field">
                        {t('options_new_password', MIN_PASSWORD_LENGTH)}
                        <input
                          className="input input--lg"
                          type="password"
                          value={nextPassword}
                          autoComplete="new-password"
                          onChange={(event) => {
                            setNextPassword(event.target.value);
                          }}
                        />
                      </label>
                      <label className="field">
                        {t('options_new_password_again')}
                        <input
                          className="input input--lg"
                          type="password"
                          value={nextConfirm}
                          autoComplete="new-password"
                          onChange={(event) => {
                            setNextConfirm(event.target.value);
                          }}
                        />
                      </label>
                      {nextPassword !== '' && nextPassword.length < MIN_PASSWORD_LENGTH ? (
                        <p className="field__error">{t('vault_password_too_short', MIN_PASSWORD_LENGTH)}</p>
                      ) : null}
                      {nextConfirm !== '' && nextPassword !== nextConfirm ? (
                        <p className="field__error">{t('vault_password_mismatch')}</p>
                      ) : null}
                      <div className="panel__end">
                        <Button
                          size="lg"
                          onClick={() => {
                            setChangingPassword(false);
                            setCurrentPassword('');
                            setNextPassword('');
                            setNextConfirm('');
                          }}
                        >
                          {t('action_cancel')}
                        </Button>
                        <Button
                          variant="primary"
                          size="lg"
                          disabled={
                            currentPassword === '' ||
                            nextPassword.length < MIN_PASSWORD_LENGTH ||
                            nextPassword !== nextConfirm
                          }
                          onClick={() => {
                            setKeyStatus(null);
                            void request('vault/change-password', {
                              current: currentPassword,
                              next: nextPassword,
                            }).then(
                              () => {
                                setCurrentPassword('');
                                setNextPassword('');
                                setNextConfirm('');
                                setChangingPassword(false);
                                setKeyStatus(t('options_password_changed'));
                              },
                              (error: unknown) => {
                                setKeyStatus(error instanceof Error ? error.message : String(error));
                              },
                            );
                          }}
                        >
                          {t('options_change_password_title')}
                        </Button>
                      </div>
                    </div>
                  ) : keyStatus !== null ? (
                    statusLine(keyStatus)
                  ) : undefined
                }
              />
              <SettingItem
                label={t('options_backup_title')}
                description={
                  <>
                    <Rich text={t('options_backup_hint2')} /> <Rich text={t('options_backup_hint')} />
                  </>
                }
                control={
                  <Button
                    variant="primary"
                    size="lg"
                    disabled={!unlocked}
                    title={unlocked ? undefined : hasLocalVault ? t('options_export_needs_unlock') : t('options_export_no_vault')}
                    onClick={() => {
                      void request('vault/backup-export', undefined).then(
                        (file) => {
                          downloadJson(file.filename, file.json);
                          setBackupText(file.json);
                          setBackupStatus(t('options_exported', file.filename));
                        },
                        (error: unknown) => {
                          setBackupStatus(error instanceof Error ? error.message : String(error));
                        },
                      );
                    }}
                  >
                    {t('options_export_action')}
                  </Button>
                }
                below={
                  backupStatus === null && backupText === null ? undefined : (
                    <>
                      {statusLine(backupStatus)}
                      {backupText !== null ? (
                        <details className="details">
                          <summary>{t('options_download_fallback')}</summary>
                          <p>{t('options_download_fallback_hint')}</p>
                          <textarea readOnly value={backupText} className="input input--mono input--blob" />
                        </details>
                      ) : null}
                    </>
                  )
                }
              />
              <SettingItem
                label={t('options_restore_title')}
                description={<Rich text={t('options_restore_hint')} />}
                below={
                  <div className="panel panel--grid">
                    <div className="field">
                      {t('options_restore_with')}
                      <SegmentedControl
                        size="lg"
                        label={t('options_restore_with')}
                        options={[
                          { value: 'password', label: t('options_restore_with_password') },
                          { value: 'recovery', label: t('options_restore_with_recovery') },
                        ]}
                        value={restoreViaRecovery ? 'recovery' : 'password'}
                        onChange={(value) => {
                          setRestoreViaRecovery(value === 'recovery');
                          setRestoreStatus(null);
                        }}
                      />
                    </div>
                    {/* 用 <label> 包住才有可存取的名稱；<label> 不是 <form>，不會觸發存密碼提示 */}
                    <label className="field">
                      {t('options_backup_file')}
                      <input
                        className="input input--lg input--file"
                        type="file"
                        accept=".json,application/json"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          setRestoreStatus(null);
                          if (file === undefined) {
                            setRestoreFile(null);
                            return;
                          }
                          void file.text().then(
                            (text) => {
                              setRestoreFile({ name: file.name, text });
                            },
                            () => {
                              setRestoreStatus(t('options_file_unreadable'));
                            },
                          );
                        }}
                      />
                    </label>
                    {/*
                      刻意不包在 <form> 裡：表單送出會觸發 Firefox 的「要儲存密碼嗎？」提示，
                      而這是隱私空間的主密碼，不該進到密碼管理員。
                    */}
                    {restoreViaRecovery ? (
                      <label className="field">
                        {t('options_backup_recovery_key')}
                        <input
                          className="input input--lg input--mono"
                          type="text"
                          value={restoreRecoveryKey}
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                          onChange={(event) => {
                            setRestoreRecoveryKey(event.target.value);
                          }}
                        />
                      </label>
                    ) : (
                      <label className="field">
                        {t('options_backup_password')}
                        <input
                          className="input input--lg"
                          type="password"
                          value={restorePassword}
                          autoComplete="off"
                          onChange={(event) => {
                            setRestorePassword(event.target.value);
                          }}
                        />
                      </label>
                    )}
                    {vaultStatus === 'locked' && hasLocalVault ? (
                      <p className="field__note">{t('options_restore_needs_unlock')}</p>
                    ) : null}
                    <div className="panel__end">
                      <Button
                        variant="outline"
                        size="lg"
                        disabled={
                          restoreFile === null ||
                          (restoreViaRecovery ? restoreRecoveryKey.trim() === '' : restorePassword === '') ||
                          restoreBusy
                        }
                        onClick={() => {
                          if (restoreFile === null) {
                            return;
                          }
                          setRestoreBusy(true);
                          setRestoreStatus(null);
                          void request('vault/backup-import', {
                            json: restoreFile.text,
                            secret: restoreViaRecovery ? restoreRecoveryKey : restorePassword,
                            viaRecoveryKey: restoreViaRecovery,
                          }).then(
                            (report) => {
                              setRestoreStatus(describeMerge(report.report, report.adopted));
                              setRestorePassword('');
                              setRestoreRecoveryKey('');
                              setRestoreBusy(false);
                            },
                            (error: unknown) => {
                              setRestoreStatus(error instanceof Error ? error.message : String(error));
                              setRestoreBusy(false);
                            },
                          );
                        }}
                      >
                        {restoreBusy ? t('options_restoring') : t('options_restore_action')}
                      </Button>
                    </div>
                    {restoreStatus === null ? null : <div className="panel__wide">{statusLine(restoreStatus)}</div>}
                  </div>
                }
              />
            </SettingSection>
          )}

          {/* ── 危險操作 ── */}
          <SettingSection id="danger" title={t('options_danger_title')} hint={t('options_danger_hint')} danger>
            {!concealed && unlocked ? (
              <SettingItem
                label={t('options_regenerate_title')}
                description={
                  <>
                    <Rich text={t('options_regenerate_hint')} /> {t('options_regenerate_needs_password')}
                  </>
                }
                control={
                  confirming === 'regenerate' ? undefined : (
                    <Button
                      variant="danger"
                      size="lg"
                      onClick={() => {
                        setConfirming('regenerate');
                        setDangerStatus(null);
                      }}
                    >
                      {t('options_regenerate_button')}
                    </Button>
                  )
                }
                below={
                  confirming === 'regenerate'
                    ? confirmPanel(
                        <label className="field">
                          {t('options_current_password')}
                          <input
                            className="input input--lg"
                            type="password"
                            value={regenPassword}
                            autoComplete="off"
                            autoFocus
                            onChange={(event) => {
                              setRegenPassword(event.target.value);
                            }}
                          />
                        </label>,
                        t('options_regenerate_confirm'),
                        () => {
                          setKeyStatus(null);
                          void request('vault/regenerate-recovery', { password: regenPassword }).then(
                            ({ recoveryKey }) => {
                              setRegenPassword('');
                              setConfirming(null);
                              setShownKey({ code: recoveryKey, reason: 'regenerated' });
                              setDangerStatus(t('options_regenerated'));
                            },
                            (error: unknown) => {
                              setDangerStatus(error instanceof Error ? error.message : String(error));
                            },
                          );
                        },
                        regenPassword === '',
                      )
                    : undefined
                }
              />
            ) : null}
            <SettingItem
              label={t('options_clear_previews')}
              description={`${usageText}${t('options_clear_previews_desc')}`}
              control={
                confirming === 'clear' ? undefined : (
                  <Button
                    variant="danger"
                    size="lg"
                    disabled={usage?.count === 0}
                    onClick={() => {
                      setConfirming('clear');
                      setDangerStatus(null);
                    }}
                  >
                    {t('options_clear_previews_button')}
                  </Button>
                )
              }
              below={
                confirming === 'clear'
                  ? confirmPanel(t('options_clear_previews_confirm', usageText), t('options_clear_previews_confirm_action'), () => {
                      setConfirming(null);
                      void request('thumbs/clear', undefined).then(
                        (result) => {
                          setDangerStatus(t('options_previews_cleared', tn('unit_previews', result.removed)));
                          void request('thumbs/usage', undefined).then(setUsage, () => undefined);
                        },
                        () => undefined,
                      );
                    })
                  : undefined
              }
            />
            {!concealed && unlocked && vault.state.status === 'unlocked' ? (
              <SettingItem
                label={t('options_destroy_label')}
                description={t('options_destroy_desc', tn('unit_vault_bookmarks', vault.state.bookmarkCount))}
                control={
                  confirming === 'destroy' ? undefined : (
                    <Button
                      variant="danger"
                      size="lg"
                      onClick={() => {
                        setConfirming('destroy');
                        setDangerStatus(null);
                      }}
                    >
                      {t('options_destroy_button')}
                    </Button>
                  )
                }
                below={
                  confirming === 'destroy'
                    ? confirmPanel(
                        <>
                          <b>{t('vault_destroy_confirm')}</b>{' '}
                          {t('vault_destroy_warning', tn('unit_vault_bookmarks', vault.state.bookmarkCount))}
                        </>,
                        t('action_delete_confirm'),
                        () => {
                          setConfirming(null);
                          void vault.destroy();
                        },
                      )
                    : undefined
                }
              />
            ) : null}
            {!concealed && hasLocalVault && !unlocked ? (
              <SettingItem
                label={t('options_forget_title')}
                description={<Rich text={t('options_forget_hint')} />}
                control={
                  confirming === 'forget' ? undefined : (
                    <Button
                      variant="danger"
                      size="lg"
                      onClick={() => {
                        setConfirming('forget');
                        setDangerStatus(null);
                      }}
                    >
                      {t('options_forget_button')}
                    </Button>
                  )
                }
                below={
                  confirming === 'forget'
                    ? confirmPanel(<Rich text={t('options_forget_hint')} />, t('options_forget_button_confirm'), () => {
                        setConfirming(null);
                        void vault.forget().then(() => {
                          setDangerStatus(t('options_forgot'));
                        }, () => undefined);
                      })
                    : undefined
                }
              />
            ) : null}
            {dangerStatus === null ? null : <SettingItem label="" below={statusLine(dangerStatus)} />}
          </SettingSection>
        </main>
      </div>
    </div>
  );
}
