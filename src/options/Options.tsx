import { useCallback, useEffect, useRef, useState } from 'react';
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
import { t, tn } from '@/shared/i18n';
import { Rich } from '@/sidebar/lib/rich';

/**
 * 把 JSON 交給瀏覽器下載。
 *
 * 設定頁是嵌在 `about:addons` 裡的 iframe，所以不用 `browser.downloads`
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
    void request('thumbs/usage', undefined).then(setUsage, () => undefined);
    void request('bookmarks/folders', undefined).then(setFolders, () => undefined);
  }, []);

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

  if (settings === null || vault.state === null) {
    return <div className="options">{t('options_loading')}</div>;
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

  return (
    <div className="options">
      <h1>{t('extension_name')}</h1>
      <p className="options__lede">
        {settings.vaultSyncEnabled
          ? t('options_lede_sync')
          : t('options_lede')}
      </p>

      <section>
        <h2>{t('options_entry_title')}</h2>
        <p className="options__hint">
          {t('options_entry_hint')}
        </p>
        <div className="options__row">
          {(
            [
              ['hidden', t('options_entry_hidden')],
              ['tab', t('options_entry_tab')],
            ] as [VaultEntry, string][]
          ).map(([value, label]) => (
            <label key={value} className="options__check">
              <input
                type="radio"
                name="vaultEntry"
                checked={settings.vaultEntry === value}
                onChange={() => {
                  update({ vaultEntry: value });
                }}
              />
              {label}
            </label>
          ))}
        </div>
      </section>

      <section>
        <h2>{t('options_export_target_title')}</h2>
        <p className="options__hint">
          {t('options_export_target_hint')}
        </p>
        <label className="options__field">
          <span>{t('options_default_folder')}</span>
          <select
            value={settings.vaultExportFolderId ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              update({ vaultExportFolderId: value === '' ? null : value });
            }}
          >
            <option value="">{t('options_firefox_default_folder')}</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {' '.repeat(folder.depth * 2)}
                {folder.title}
              </option>
            ))}
          </select>
        </label>
        <p className="options__hint">
          {t('options_export_target_fallback')}
        </p>
      </section>

      <section>
        <h2>{t('options_trigger_title')}</h2>
        <p className="options__hint">
          {t('options_trigger_hint')}
        </p>
        <p className="options__hint">
          <Rich text={t('options_trigger_advice')} />
        </p>
        <label className="options__field">
          <span>{t('options_trigger_title')}</span>
          <input
            type="text"
            value={settings.vaultTrigger}
            placeholder={DEFAULT_VAULT_TRIGGER}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              update({ vaultTrigger: event.target.value });
            }}
          />
        </label>
        {settings.vaultTrigger.trim() === '' ? (
          <p className="options__hint">
            {t('options_trigger_empty')}
          </p>
        ) : null}
      </section>

      <section>
        <h2>{t('tab_vault')}</h2>
        {remoteAwaitingRestore ? (
          /*
           * 雲端已經有一份、本機還沒有 —— 這時**不能**顯示建立表單。
           * 在這裡建立會產生新的 salt，兩份從此永遠合不起來，而後續同步會把雲端
           * 那份覆蓋掉；那正是災難還原最需要它的時候。
           */
          <p className="options__status">
            <Rich text={t('options_remote_awaiting_restore')} />
          </p>
        ) : vault.state.status === 'absent' || vault.state.status === 'legacy' ? (
          <VaultGate
            state={vault.state}
            onCreate={vault.create}
            onUnlock={() => undefined}
            onUnlockWithRecoveryKey={() => undefined}
            onForget={() => {
              void vault.forget();
            }}
          />
        ) : (
          <>
            <p>
              {t('options_status_label')}
              {vault.state.status === 'unlocked'
                ? t('options_status_unlocked', tn('unit_vault_bookmarks', vault.state.bookmarkCount))
                : t('options_status_locked')}
            </p>
            <p className="options__hint">
              {t('options_vault_manage_hint')}
            </p>
          </>
        )}
        {vault.error !== null ? <p className="options__status">{vault.error}</p> : null}
      </section>

      <section>
        <h2>{t('options_keys_title')}</h2>
        <p className="options__hint">
          {t('options_keys_hint')}
        </p>

        {vaultStatus === 'unlocked' ? (
          <div className="options__row">
            <button
              type="button"
              className="chip"
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
            </button>
          </div>
        ) : (
          <p className="options__hint">
            {t('options_keys_need_unlock')}
          </p>
        )}

        {shownKey !== null ? (
          <div ref={shownKeyRef}>
            <RecoveryKeyPanel
              recoveryKey={shownKey.code}
              reason={shownKey.reason}
              onDismiss={() => {
                setShownKey(null);
              }}
            />
          </div>
        ) : null}

        {vaultStatus === 'unlocked' ? (
          <>
            <h2 style={{ marginTop: 20 }}>{t('options_change_password_title')}</h2>
            <p className="options__hint">
              <Rich text={t('options_change_password_hint')} />
            </p>
            <label className="options__field">
              <span>{t('options_current_password')}</span>
              <input
                type="password"
                value={currentPassword}
                autoComplete="off"
                onChange={(event) => {
                  setCurrentPassword(event.target.value);
                }}
              />
            </label>
            <label className="options__field">
              <span>{t('options_new_password', MIN_PASSWORD_LENGTH)}</span>
              <input
                type="password"
                value={nextPassword}
                autoComplete="new-password"
                onChange={(event) => {
                  setNextPassword(event.target.value);
                }}
              />
            </label>
            <label className="options__field">
              <span>{t('options_new_password_again')}</span>
              <input
                type="password"
                value={nextConfirm}
                autoComplete="new-password"
                onChange={(event) => {
                  setNextConfirm(event.target.value);
                }}
              />
            </label>
            <div className="options__row">
              <button
                type="button"
                className="chip"
                disabled={
                  currentPassword === '' || nextPassword.length < MIN_PASSWORD_LENGTH || nextPassword !== nextConfirm
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
                      setKeyStatus(t('options_password_changed'));
                    },
                    (error: unknown) => {
                      setKeyStatus(error instanceof Error ? error.message : String(error));
                    },
                  );
                }}
              >
                {t('options_change_password_title')}
              </button>
            </div>
            {nextPassword !== '' && nextPassword.length < MIN_PASSWORD_LENGTH ? (
              <p className="options__hint">{t('vault_password_too_short', MIN_PASSWORD_LENGTH)}</p>
            ) : null}
            {nextConfirm !== '' && nextPassword !== nextConfirm ? (
              <p className="options__hint">{t('vault_password_mismatch')}</p>
            ) : null}

            <h2 style={{ marginTop: 20 }}>{t('options_regenerate_title')}</h2>
            <p className="options__hint">
              <Rich text={t('options_regenerate_hint')} />
            </p>
            <div className="options__row">
              <button
                type="button"
                className="chip"
                disabled={currentPassword === ''}
                title={currentPassword === '' ? t('options_need_current_password') : undefined}
                onClick={() => {
                  setKeyStatus(null);
                  void request('vault/regenerate-recovery', { password: currentPassword }).then(
                    ({ recoveryKey }) => {
                      setCurrentPassword('');
                      setShownKey({ code: recoveryKey, reason: 'regenerated' });
                      setKeyStatus(t('options_regenerated'));
                    },
                    (error: unknown) => {
                      setKeyStatus(error instanceof Error ? error.message : String(error));
                    },
                  );
                }}
              >
                {t('options_regenerate_action')}
              </button>
            </div>
          </>
        ) : null}

        {hasLocalVault && vaultStatus !== 'unlocked' ? (
          <>
            <h2 style={{ marginTop: 20 }}>{t('options_forget_title')}</h2>
            <p className="options__hint">
              <Rich text={t('options_forget_hint')} />
              
            </p>
            <div className="options__row">
              <button
                type="button"
                className="chip"
                onClick={() => {
                  setKeyStatus(null);
                  void vault.forget().then(() => {
                    setKeyStatus(t('options_forgot'));
                  }, () => undefined);
                }}
              >
                {t('options_forget_title')}
              </button>
            </div>
          </>
        ) : null}

        {keyStatus !== null ? <p className="options__status">{keyStatus}</p> : null}
      </section>

      <section>
        <h2>{t('options_backup_title')}</h2>
        <p className="options__hint">
          <Rich text={t('options_backup_hint')} />
          
        </p>
        <p className="options__hint">
          <Rich text={t('options_backup_hint2')} />
        </p>

        <div className="options__row">
          <button
            type="button"
            className="chip"
            disabled={vaultStatus !== 'unlocked'}
            title={
              vaultStatus === 'unlocked'
                ? undefined
                : hasLocalVault
                  ? t('options_export_needs_unlock')
                  : t('options_export_no_vault')
            }
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
          </button>
        </div>
        {backupStatus !== null ? <p className="options__status">{backupStatus}</p> : null}
        {backupText !== null ? (
          <details className="options__details">
            <summary>{t('options_download_fallback')}</summary>
            <p className="options__hint">
              {t('options_download_fallback_hint')}
            </p>
            <textarea readOnly value={backupText} className="options__blob" />
          </details>
        ) : null}

        <h2 style={{ marginTop: 20 }}>{t('options_restore_title')}</h2>
        <p className="options__hint">
          <Rich text={t('options_restore_hint')} />
          
        </p>
        <div className="options__row">
          {(
            [
              [false, t('options_restore_with_password')],
              [true, t('options_restore_with_recovery')],
            ] as [boolean, string][]
          ).map(([value, label]) => (
            <label key={String(value)} className="options__check">
              <input
                type="radio"
                name="restoreMode"
                checked={restoreViaRecovery === value}
                onChange={() => {
                  setRestoreViaRecovery(value);
                  setRestoreStatus(null);
                }}
              />
              {label}
            </label>
          ))}
        </div>
        {/* 用 <label> 包住才有可存取的名稱；<label> 不是 <form>，不會觸發存密碼提示 */}
        <label className="options__field">
          <span>{t('options_backup_file')}</span>
          <input
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
          而這是隱私空間的主密碼，不該進到密碼管理員。<label> 不是 <form>，可以用。
        */}
        {restoreViaRecovery ? (
          <label className="options__field">
            <span>{t('options_backup_recovery_key')}</span>
            <input
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
          <label className="options__field">
            <span>{t('options_backup_password')}</span>
            <input
              type="password"
              value={restorePassword}
              autoComplete="off"
              onChange={(event) => {
                setRestorePassword(event.target.value);
              }}
            />
          </label>
        )}
        <div className="options__row">
          <button
            type="button"
            className="chip"
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
          </button>
          {restoreFile !== null ? (
            <span className="options__hint">{restoreFile.name}</span>
          ) : null}
        </div>
        {vaultStatus === 'locked' && hasLocalVault ? (
          <p className="options__hint">
            {t('options_restore_needs_unlock')}
            
          </p>
        ) : null}
        {restoreStatus !== null ? <p className="options__status">{restoreStatus}</p> : null}
      </section>

      <section>
        <h2>{t('options_grid_sync_title')}</h2>
        <p className="options__hint">{t('options_grid_sync_hint')}</p>
        <label className="options__check">
          <input
            type="checkbox"
            checked={settings.syncGrid}
            disabled={gridSync?.available === false}
            onChange={(event) => {
              update({ syncGrid: event.target.checked });
            }}
          />
          {t('options_grid_sync_checkbox')}
        </label>
        {gridSync?.available === false ? (
          <p className="options__hint">{t('options_grid_sync_unavailable')}</p>
        ) : gridSync?.enabled === true ? (
          <>
            <p className={gridSync.over ? 'options__status' : 'options__hint'}>
              {gridSync.over
                ? t('options_grid_sync_over', formatBytes(gridSync.total), formatBytes(gridSync.budget))
                : t('options_grid_sync_usage', formatBytes(gridSync.total), formatBytes(gridSync.budget))}
            </p>
            {gridSync.folders.length > 0 ? (
              <ul className="options__hint">
                {gridSync.folders.map((folder) => (
                  <li key={folder.title}>
                    {folder.localOnly
                      ? t('options_grid_sync_local_only', folder.title, formatBytes(folder.bytes))
                      : t('options_grid_sync_folder', folder.title, formatBytes(folder.bytes))}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
      </section>

      <section>
        <h2>{t('options_sync_title')}</h2>
        <p className="options__hint">
          <Rich text={t('options_sync_hint')} />
          
        </p>
        {/*
          折起來而不是刪掉：這兩件事都實際造成過誤解（按了好幾次卻發現另一台沒資料、
          在新裝置上按了「建立」導致兩份金鑰不同）。但它們是「出問題時才需要讀」的內容，
          不該長期佔著版面。
        */}
        <details className="options__details">
          <summary>{t('options_sync_not_seen')}</summary>
          <p className="options__hint">
            <Rich text={t('options_sync_not_seen_1')} />
            
            
            
          </p>
          <p className="options__hint">
            <Rich text={t('options_sync_not_seen_2')} />
            
          </p>
        </details>
        <label className="options__check">
          <input
            type="checkbox"
            checked={settings.vaultSyncEnabled}
            onChange={(event) => {
              const enabled = event.target.checked;
              update({ vaultSyncEnabled: enabled });
              setSyncStatusText(
                enabled
                  ? t('options_sync_on')
                  : t('options_sync_off'),
              );
              void refreshSync();
            }}
          />
          {t('options_sync_checkbox')}
        </label>

        {syncLoadError !== null && sync === null ? (
          <p className="options__status">
            {t('options_sync_unreadable', syncLoadError)}
            <button
              type="button"
              className="chip"
              style={{ marginLeft: 8 }}
              onClick={() => {
                void refreshSync();
              }}
            >
              {t('action_retry')}
            </button>
          </p>
        ) : sync === null ? (
          <p className="options__hint">{t('options_sync_loading')}</p>
        ) : !sync.available ? (
          <p className="options__status">{t('outcome_unavailable')}</p>
        ) : (
          <>
            <dl className="options__facts">
              <dt>{t('options_sync_remote')}</dt>
              <dd>
                {sync.remote === 'absent'
                  ? t('options_sync_remote_absent')
                  : sync.remote === 'partial'
                    ? t('options_sync_remote_partial')
                    : t('options_sync_remote_ok', formatTime(sync.remoteUpdatedAt ?? 0))}
              </dd>
              <dt>{t('options_sync_quota')}</dt>
              <dd>
                {formatBytes(sync.bytes)} / {formatBytes(sync.quota)}
                {sync.wouldFit ? '' : t('options_sync_does_not_fit')}
              </dd>
              <dt>{t('options_sync_last')}</dt>
              <dd>
                {sync.lastSyncedAt === null ? t('options_sync_never') : formatTime(sync.lastSyncedAt)}
                {sync.lastOutcome !== null && sync.lastOutcome !== 'synced'
                  ? t('options_sync_last_attempt', OUTCOME_TEXT[sync.lastOutcome])
                  : ''}
              </dd>
            </dl>

            {sync.deletedElsewhere ? (
              <p className="options__status">
                <Rich text={t('options_sync_deleted_elsewhere')} />
                
                
                
              </p>
            ) : null}
            {!sync.wouldFit ? (
              <p className="options__status">
                {t('options_sync_over_quota')}
                
              </p>
            ) : null}
            {sync.sameVault === false ? (
              <p className="options__status">
                <Rich text={t('options_sync_different_vault')} />
                
                
              </p>
            ) : null}
            {sync.lastError !== null ? (
              <p className="options__status">{t('options_sync_last_error', sync.lastError)}</p>
            ) : null}

            <div className="options__row">
              <button
                type="button"
                className="chip"
                disabled={syncBusy || !settings.vaultSyncEnabled}
                title={t('options_sync_now_hint')}
                onClick={() => {
                  void runSyncNow();
                }}
              >
                {t('options_sync_now')}
              </button>
              {!sync.hasLocalVault && sync.remote === 'ok' ? (
                <button
                  type="button"
                  className="chip"
                  disabled={syncBusy || !settings.vaultSyncEnabled}
                  title={
                    settings.vaultSyncEnabled
                      ? undefined
                      : t('options_sync_needs_checkbox')
                  }
                  onClick={() => {
                    void runSync(async () => {
                      await request('vault/sync-adopt', undefined);
                    }, t('options_sync_adopted'));
                  }}
                >
                  {t('options_sync_adopt')}
                </button>
              ) : null}
              {sync.deletedElsewhere ? (
                <button
                  type="button"
                  className="chip"
                  disabled={syncBusy}
                  onClick={() => {
                    void runSync(
                      async () => request('vault/sync-resume', undefined),
                      t('options_sync_resumed'),
                    );
                  }}
                >
                  {t('options_sync_resume')}
                </button>
              ) : null}
              {sync.remote !== 'absent' && sync.hasLocalVault ? (
                <button
                  type="button"
                  className="chip"
                  disabled={syncBusy || !sync.wouldFit}
                  title={
                    sync.wouldFit
                      ? t('options_sync_overwrite_hint')
                      : t('options_sync_overwrite_disabled')
                  }
                  onClick={() => {
                    void runSync(
                      async () => request('vault/sync-overwrite', undefined),
                      t('options_sync_overwritten'),
                    );
                  }}
                >
                  {t('options_sync_overwrite')}
                </button>
              ) : null}
              {sync.remote !== 'absent' ? (
                <button
                  type="button"
                  className="chip"
                  disabled={syncBusy}
                  onClick={() => {
                    void runSync(
                      async () => request('vault/sync-clear', undefined),
                      t('options_sync_cleared'),
                    );
                  }}
                >
                  {t('options_sync_clear')}
                </button>
              ) : null}
            </div>
          </>
        )}
        {/* 訊息放在 available 分支外面：同步不可用或狀態讀不到時，勾選框的回饋也還是要看得到 */}
        {syncStatusText !== null ? <p className="options__status">{syncStatusText}</p> : null}

        <details className="options__details">
          <summary>{t('options_sync_limits')}</summary>
          <ul className="options__list">
            <li>
              <Rich text={t('options_sync_limit_android')} />
              
            </li>
            <li>
              <Rich text={t('options_sync_limit_schedule')} />
              
              
            </li>
            <li>
              <Rich text={t('options_sync_limit_account')} />
              
              
            </li>
            <li>
              {t('options_sync_limit_stale')}
              
            </li>
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
      </section>

      <section>
        <h2>{t('options_autolock_title')}</h2>
        <div className="options__row">
          {t('options_autolock_before')}
          <input
            type="number"
            min={1}
            max={240}
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
            style={{ width: '5em' }}
          />
          {t('options_autolock_after')}
        </div>
        <p className="options__hint">
          {t('options_autolock_hint')}
        </p>
        <p className="options__hint">
          {t('options_autolock_hint2')}
          
        </p>
      </section>

      <section>
        <h2>{t('options_capture_title')}</h2>
        <label className="options__check">
          <input
            type="checkbox"
            checked={settings.captureEnabled}
            onChange={(event) => {
              update({ captureEnabled: event.target.checked });
            }}
          />
          {t('options_capture_enabled')}
        </label>
        <div className="options__row">
          {t('options_recapture_before')}
          <input
            type="number"
            min={1}
            max={365}
            value={settings.thumbMaxAgeDays}
            onChange={(event) => {
              const days = Number(event.target.value);
              if (Number.isFinite(days) && days >= 1) {
                update({ thumbMaxAgeDays: days });
              }
            }}
            style={{ width: '5em' }}
          />
          {t('options_recapture_after')}
        </div>

        <h2 style={{ marginTop: 16 }}>{t('options_blocklist_title')}</h2>
        <p className="options__hint">{t('options_blocklist_hint')}</p>
        <textarea
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
      </section>

      <section>
        <h2>{t('options_storage_title')}</h2>
        <p>
          {usage === null
            ? t('options_storage_counting')
            : t('options_storage_usage', tn('unit_previews', usage.count), (usage.bytes / 1_048_576).toFixed(1))}
        </p>
        <div className="options__row">
          <button
            type="button"
            className="chip"
            onClick={() => {
              void request('thumbs/clear', undefined).then(
                (result) => {
                  setStatus(t('options_previews_cleared', tn('unit_previews', result.removed)));
                  setUsage({ count: 0, bytes: 0 });
                },
                () => undefined,
              );
            }}
          >
            {t('options_clear_previews')}
          </button>
          <button
            type="button"
            className="chip"
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
          </button>
        </div>
        {status !== null ? <p className="options__status">{status}</p> : null}
      </section>
    </div>
  );
}
