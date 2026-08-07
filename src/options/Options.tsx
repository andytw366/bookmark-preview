import { useCallback, useEffect, useRef, useState } from 'react';
import {
  request,
  subscribe,
  type FolderChoice,
  type SyncOutcome,
  type VaultSyncStatus,
} from '@/shared/messages';
import type { VaultEntry } from '@/shared/types';
import { DEFAULT_VAULT_TRIGGER } from '@/shared/vault-entry';
import type { MergeReport } from '@/shared/vault-merge';
import { useSettings } from '@/sidebar/hooks/useSettings';
import { useVault } from '@/sidebar/hooks/useVault';
import { RecoveryKeyPanel } from '@/sidebar/components/RecoveryKeyPanel';
import { VaultGate } from '@/sidebar/components/VaultGate';

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
    parts.push(`已還原 ${String(report.bookmarks.added)} 個書籤`);
    if (report.folders.added > 0) {
      parts.push(`${String(report.folders.added)} 個資料夾`);
    }
  } else {
    parts.push(`新增 ${String(report.bookmarks.added)} 個書籤`);
    if (report.bookmarks.updated > 0) {
      parts.push(`更新 ${String(report.bookmarks.updated)} 個`);
    }
    if (report.folders.added > 0 || report.folders.updated > 0) {
      parts.push(
        `資料夾新增 ${String(report.folders.added)} 個、更新 ${String(report.folders.updated)} 個`,
      );
    }
  }
  let text = `${parts.join('，')}。`;
  if (report.reattached > 0) {
    text += `其中 ${String(report.reattached)} 筆原本的資料夾在合併後不存在，已移到最上層。`;
  }
  if (adopted) {
    text += '備份檔不含預覽圖，回到側邊欄按「補抓預覽圖」就會重新產生。';
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
  synced:
    '已跟雲端副本對過（有較新的內容就已經合併進來）。' +
    '實際上傳／下載到 Firefox 伺服器是 Firefox 自己排程的，不是這顆按鈕做的。',
  unavailable: '這個 Firefox 沒有可用的 storage.sync，無法同步。',
  disabled: '同步目前是關閉的，什麼都沒做。',
  'no-vault': '這台裝置還沒有隱私空間，沒有東西可以同步。',
  busy: '已經有一次同步在進行中。',
  locked: '隱私空間目前上鎖，沒有金鑰可以合併雲端那份 —— 這次沒有讀也沒有寫。請先在側邊欄解鎖。',
  waiting: '雲端副本還在傳輸中，這次先不動它（避免覆蓋掉還沒看到的內容）。稍後會自己完成。',
  'deleted-elsewhere': '另一台裝置刪除了隱私空間，同步已暫停等你決定。',
  failed: '同步失敗，原因見上面的訊息。',
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
        next.lastOutcome === null ? '已送出同步請求，狀態見上面。' : OUTCOME_TEXT[next.lastOutcome],
      );
    } catch (error) {
      setSyncStatusText(error instanceof Error ? error.message : String(error));
      await refreshSync();
    } finally {
      setSyncBusy(false);
    }
  }, [refreshSync]);

  if (settings === null || vault.state === null) {
    return <div className="options">載入設定…</div>;
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
      <h1>書籤預覽</h1>
      <p className="options__lede">
        {settings.vaultSyncEnabled
          ? '所有資料都在這台裝置上。隱私空間另有一份加密副本在 Firefox 同步裡，只有主密碼解得開。'
          : '所有資料都在這台裝置上，不會上傳到任何伺服器。'}
      </p>

      <section>
        <h2>隱私空間的入口</h2>
        <p className="options__hint">
          隱藏時，要在搜尋框打下面那段觸發字串才會跳出密碼畫面。
        </p>
        <div className="options__row">
          {(
            [
              ['hidden', '隱藏（用觸發字串進入）'],
              ['tab', '顯示分頁'],
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
        <h2>移出隱私空間的落點</h2>
        <p className="options__hint">
          「移出隱私空間」會放進這個資料夾；「移出到…」則每次讓你選。
        </p>
        <label className="options__field">
          <span>預設資料夾</span>
          <select
            value={settings.vaultExportFolderId ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              update({ vaultExportFolderId: value === '' ? null : value });
            }}
          >
            <option value="">（Firefox 預設：其他書籤）</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {' '.repeat(folder.depth * 2)}
                {folder.title}
              </option>
            ))}
          </select>
        </label>
        <p className="options__hint">
          這個資料夾被刪掉時，會自動退回 Firefox 的預設位置。
        </p>
      </section>

      <section>
        <h2>觸發字串</h2>
        <p className="options__hint">
          在搜尋框打這段字就會跳出密碼畫面。任何文字都可以。
        </p>
        <p className="options__hint">
          <strong>建議改掉。</strong>預設值是公開的，別人打一次就能看出這台裝置有沒有隱私空間。
        </p>
        <label className="options__field">
          <span>觸發字串</span>
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
            空的等於停用這個入口。記得把上面改成「顯示分頁」，否則就進不去了。
          </p>
        ) : null}
      </section>

      <section>
        <h2>隱私空間</h2>
        {remoteAwaitingRestore ? (
          /*
           * 雲端已經有一份、本機還沒有 —— 這時**不能**顯示建立表單。
           * 在這裡建立會產生新的 salt，兩份從此永遠合不起來，而後續同步會把雲端
           * 那份覆蓋掉；那正是災難還原最需要它的時候。
           */
          <p className="options__status">
            雲端已經有一份加密副本。到下面的「跨裝置同步」按「從雲端還原到這台裝置」，
            再用<strong>同一組主密碼</strong>解鎖。<strong>不要在這裡另外建立</strong> ——
            金鑰會不同，兩份從此合不起來。
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
              狀態：
              {vault.state.status === 'unlocked'
                ? `已解鎖，${String(vault.state.bookmarkCount)} 個隱私書籤`
                : '已上鎖'}
            </p>
            <p className="options__hint">
              隱私書籤的管理（移出、刪除）在側邊欄解鎖後進行。
            </p>
          </>
        )}
        {vault.error !== null ? <p className="options__status">{vault.error}</p> : null}
      </section>

      <section>
        <h2>主密碼與救援金鑰</h2>
        <p className="options__hint">
          主密碼與救援金鑰都能解開同一份資料。忘記主密碼時，救援金鑰是唯一的出路。
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
              再看一次救援金鑰
            </button>
          </div>
        ) : (
          <p className="options__hint">
            要看救援金鑰或更改主密碼，先在側邊欄解鎖。
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
            <h2 style={{ marginTop: 20 }}>更改主密碼</h2>
            <p className="options__hint">
              救援金鑰<strong>不會</strong>因此改變。
            </p>
            <label className="options__field">
              <span>目前的主密碼</span>
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
              <span>新的主密碼（至少 8 字）</span>
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
              <span>再次輸入新的主密碼</span>
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
                  currentPassword === '' || nextPassword.length < 8 || nextPassword !== nextConfirm
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
                      setKeyStatus('主密碼已更改。下次解鎖請用新的密碼。');
                    },
                    (error: unknown) => {
                      setKeyStatus(error instanceof Error ? error.message : String(error));
                    },
                  );
                }}
              >
                更改主密碼
              </button>
            </div>
            {nextPassword !== '' && nextPassword.length < 8 ? (
              <p className="options__hint">新密碼至少要 8 個字。</p>
            ) : null}
            {nextConfirm !== '' && nextPassword !== nextConfirm ? (
              <p className="options__hint">兩次輸入不一致。</p>
            ) : null}

            <h2 style={{ marginTop: 20 }}>重新產生救援金鑰</h2>
            <p className="options__hint">
              舊的那一串會<strong>立刻失效</strong>，記得把抄在紙上的丟掉。
            </p>
            <div className="options__row">
              <button
                type="button"
                className="chip"
                disabled={currentPassword === ''}
                title={currentPassword === '' ? '請先在上面輸入目前的主密碼' : undefined}
                onClick={() => {
                  setKeyStatus(null);
                  void request('vault/regenerate-recovery', { password: currentPassword }).then(
                    ({ recoveryKey }) => {
                      setCurrentPassword('');
                      setShownKey({ code: recoveryKey, reason: 'regenerated' });
                      setKeyStatus('已產生新的救援金鑰（顯示在上面），舊的那一串已失效。');
                    },
                    (error: unknown) => {
                      setKeyStatus(error instanceof Error ? error.message : String(error));
                    },
                  );
                }}
              >
                重新產生（需要目前的主密碼）
              </button>
            </div>
          </>
        ) : null}

        {hasLocalVault && vaultStatus !== 'unlocked' ? (
          <>
            <h2 style={{ marginTop: 20 }}>放棄這台裝置上的隱私空間</h2>
            <p className="options__hint">
              主密碼與救援金鑰都沒有時唯一的出路。清掉這台裝置上的加密資料後可以重建，
              <strong>裡面的書籤救不回來</strong>。雲端副本不受影響。
            </p>
            <div className="options__row">
              <button
                type="button"
                className="chip"
                onClick={() => {
                  setKeyStatus(null);
                  void vault.forget().then(() => {
                    setKeyStatus('已清掉這台裝置上的隱私空間。');
                  }, () => undefined);
                }}
              >
                放棄這台裝置上的隱私空間
              </button>
            </div>
          </>
        ) : null}

        {keyStatus !== null ? <p className="options__status">{keyStatus}</p> : null}
      </section>

      <section>
        <h2>加密備份檔</h2>
        <p className="options__hint">
          <strong>忘記主密碼就永遠打不開。</strong>備份檔讓資料不會隨這台電腦一起消失，
          但它一樣需要當時那組主密碼。
        </p>
        <p className="options__hint">
          檔案是加密的（AES-256-GCM），可放進雲端硬碟或隨身碟。<strong>不含預覽圖</strong>（圖可以重抓）。
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
                  ? '要先在側邊欄解鎖隱私空間 —— 那同時證明你還記得這份備份的密碼'
                  : '這台裝置還沒有隱私空間，沒有東西可以匯出'
            }
            onClick={() => {
              void request('vault/backup-export', undefined).then(
                (file) => {
                  downloadJson(file.filename, file.json);
                  setBackupText(file.json);
                  setBackupStatus(`已匯出 ${file.filename}。如果沒有跳出下載，請用下面的內容自己存檔。`);
                },
                (error: unknown) => {
                  setBackupStatus(error instanceof Error ? error.message : String(error));
                },
              );
            }}
          >
            匯出加密備份檔
          </button>
        </div>
        {backupStatus !== null ? <p className="options__status">{backupStatus}</p> : null}
        {backupText !== null ? (
          <details className="options__details">
            <summary>下載沒跳出來？在這裡複製內容</summary>
            <p className="options__hint">
              全選複製存成 <code>.json</code>。內容已加密。
            </p>
            <textarea readOnly value={backupText} className="options__blob" />
          </details>
        ) : null}

        <h2 style={{ marginTop: 20 }}>從備份檔還原</h2>
        <p className="options__hint">
          這台裝置還沒有隱私空間時，之後就用這個備份檔的密碼解鎖。
          已經有的話<strong>要先在側邊欄解鎖</strong>，還原會逐筆合併（同一筆取較新的）。
        </p>
        <div className="options__row">
          {(
            [
              [false, '用主密碼'],
              [true, '用救援金鑰'],
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
          <span>備份檔</span>
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
                  setRestoreStatus('讀不到這個檔案。');
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
            <span>那個備份檔的救援金鑰</span>
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
            <span>那個備份檔的主密碼</span>
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
            {restoreBusy ? '還原中…' : '還原'}
          </button>
          {restoreFile !== null ? (
            <span className="options__hint">{restoreFile.name}</span>
          ) : null}
        </div>
        {vaultStatus === 'locked' && hasLocalVault ? (
          <p className="options__hint">
            這台裝置已經有隱私空間但目前上鎖。還原到現有的隱私空間需要先解鎖
            —— 合併時得用這台裝置的金鑰把結果寫回去。
          </p>
        ) : null}
        {restoreStatus !== null ? <p className="options__status">{restoreStatus}</p> : null}
      </section>

      <section>
        <h2>跨裝置同步</h2>
        <p className="options__hint">
          把一份<strong>已加密</strong>的副本放進 Firefox 同步。其他裝置勾選同一個選項、
          輸入同一組主密碼就能取得；主密碼不會被同步。
        </p>
        {/*
          折起來而不是刪掉：這兩件事都實際造成過誤解（按了好幾次卻發現另一台沒資料、
          在新裝置上按了「建立」導致兩份金鑰不同）。但它們是「出問題時才需要讀」的內容，
          不該長期佔著版面。
        */}
        <details className="options__details">
          <summary>其他裝置還沒看到？</summary>
          <p className="options__hint">
            這個勾選框只把加密副本寫進本機的 <code>storage.sync</code>（幾秒完成）；
            真正傳到別台裝置是 Firefox 自己的排程，約 10 分鐘一次。不想等就到
            <code>about:preferences#sync</code> 按「立即同步」——
            <strong>來源那台先按，接收那台再按</strong>。
          </p>
          <p className="options__hint">
            新裝置拿到資料後，在搜尋框打觸發字串，跳出的應該是<strong>解鎖</strong>畫面。
            <strong>不要按「建立隱私空間」</strong> —— 金鑰會不同，兩份從此合不起來。
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
                  ? '已開啟，正在上傳加密副本。'
                  : '已關閉。雲端副本仍在，要移除請按下面的按鈕。',
              );
              void refreshSync();
            }}
          />
          把加密副本放進 Firefox 同步
        </label>

        {syncLoadError !== null && sync === null ? (
          <p className="options__status">
            讀不到同步狀態：{syncLoadError}
            <button
              type="button"
              className="chip"
              style={{ marginLeft: 8 }}
              onClick={() => {
                void refreshSync();
              }}
            >
              重試
            </button>
          </p>
        ) : sync === null ? (
          <p className="options__hint">讀取同步狀態…</p>
        ) : !sync.available ? (
          <p className="options__status">這個 Firefox 沒有可用的 storage.sync，無法同步。</p>
        ) : (
          <>
            <dl className="options__facts">
              <dt>雲端副本</dt>
              <dd>
                {sync.remote === 'absent'
                  ? '尚未上傳'
                  : sync.remote === 'partial'
                    ? '傳輸中（塊還沒到齊，同步會等它完成而不會覆蓋）'
                    : `完整，最後更新於 ${formatTime(sync.remoteUpdatedAt ?? 0)}`}
              </dd>
              <dt>配額用量</dt>
              <dd>
                {formatBytes(sync.bytes)} / {formatBytes(sync.quota)}
                {sync.wouldFit ? '' : '（本機這份放不進去）'}
              </dd>
              <dt>上次同步</dt>
              <dd>
                {sync.lastSyncedAt === null ? '尚未同步過' : formatTime(sync.lastSyncedAt)}
                {sync.lastOutcome !== null && sync.lastOutcome !== 'synced'
                  ? `（上次嘗試：${OUTCOME_TEXT[sync.lastOutcome]}）`
                  : ''}
              </dd>
            </dl>

            {sync.deletedElsewhere ? (
              <p className="options__status">
                <strong>另一台裝置刪除了整個隱私空間，同步已暫停。</strong>
                這台裝置上的資料還在，也沒有被動過 —— 遠端的一個旗標不該有權刪掉本機資料。
                要繼續用這台裝置的資料同步，請按下面的「忽略刪除、重新開始同步」；
                若你也想刪掉這台裝置上的，請在側邊欄解鎖後刪除隱私空間。
              </p>
            ) : null}
            {!sync.wouldFit ? (
              <p className="options__status">
                本機的加密副本已超過 100 KB 的同步額度，同步會停在上一份副本
                （本機資料完全不受影響）。書籤太多時請改用上面的加密備份檔。
              </p>
            ) : null}
            {sync.sameVault === false ? (
              <p className="options__status">
                雲端那份是<strong>另外建立</strong>的隱私空間（salt 不同），
                金鑰互不相通，沒辦法自動合併。請選一邊：用下面的「以這台裝置覆蓋雲端」，
                或先在另一台裝置匯出備份檔再從這裡還原。
              </p>
            ) : null}
            {sync.lastError !== null ? (
              <p className="options__status">上次同步的問題：{sync.lastError}</p>
            ) : null}

            <div className="options__row">
              <button
                type="button"
                className="chip"
                disabled={syncBusy || !settings.vaultSyncEnabled}
                title="讓這台裝置立刻讀寫本機的 storage.sync 並合併。這不會叫 Firefox 立刻上傳或下載 —— 那要在 about:preferences#sync 按「立即同步」。"
                onClick={() => {
                  void runSyncNow();
                }}
              >
                立刻檢查雲端副本
              </button>
              {!sync.hasLocalVault && sync.remote === 'ok' ? (
                <button
                  type="button"
                  className="chip"
                  disabled={syncBusy || !settings.vaultSyncEnabled}
                  title={
                    settings.vaultSyncEnabled
                      ? undefined
                      : '要先勾選上面的「把加密副本放進 Firefox 同步」'
                  }
                  onClick={() => {
                    void runSync(async () => {
                      await request('vault/sync-adopt', undefined);
                    }, '已把雲端那份還原到這台裝置。用同一組主密碼解鎖即可。');
                  }}
                >
                  從雲端還原到這台裝置
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
                      '已忽略那個刪除標記，改以這台裝置的資料繼續同步。',
                    );
                  }}
                >
                  忽略刪除、重新開始同步
                </button>
              ) : null}
              {sync.remote !== 'absent' && sync.hasLocalVault ? (
                <button
                  type="button"
                  className="chip"
                  disabled={syncBusy || !sync.wouldFit}
                  title={
                    sync.wouldFit
                      ? '讓雲端變成這台裝置的內容。另一台裝置上還沒同步過來的東西會取不回來。'
                      : '本機這份超過同步額度，覆蓋一定會失敗（而且會先清掉雲端那份），所以停用'
                  }
                  onClick={() => {
                    void runSync(
                      async () => request('vault/sync-overwrite', undefined),
                      '雲端副本已改成這台裝置的內容。',
                    );
                  }}
                >
                  以這台裝置覆蓋雲端
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
                      '雲端副本已移除，本機資料不受影響。',
                    );
                  }}
                >
                  移除雲端副本並關閉同步
                </button>
              ) : null}
            </div>
          </>
        )}
        {/* 訊息放在 available 分支外面：同步不可用或狀態讀不到時，勾選框的回饋也還是要看得到 */}
        {syncStatusText !== null ? <p className="options__status">{syncStatusText}</p> : null}

        <details className="options__details">
          <summary>同步的已知限制</summary>
          <ul className="options__list">
            <li>
              <strong>Firefox for Android 完全不同步 <code>storage.sync</code></strong>
              （Mozilla bug 1625257）。手機上要取得資料只能用加密備份檔。
            </li>
            <li>
              Firefox 的同步週期約 10 分鐘，不是即時。「立刻檢查雲端副本」只讓這台裝置
              立刻讀寫本機的 <code>storage.sync</code> 並合併，
              <strong>不會</strong>叫 Firefox 立刻上傳或下載。
            </li>
            <li>
              需要你已登入 Firefox 帳號並在同步設定裡勾選「附加元件」。
              擴充套件<strong>無法得知</strong>這件事 —— 未登入時寫入照樣成功、只是傳不出去，
              所以請看上面的「雲端副本最後更新時間」來判斷同步是否真的在動。
            </li>
            <li>
              若這份副本是在你還沒登入帳號（或還沒勾「附加元件」）之前寫下的，Firefox 可能
              不會把它視為待上傳而永遠不傳。按一次「以這台裝置覆蓋雲端」重寫它即可。
            </li>
            <li>
              合併只在<strong>解鎖狀態</strong>下發生。上鎖時不推也不拉：沒有金鑰就解不開雲端那份，
              這時上傳等於覆蓋，會弄丟另一台裝置的新資料。
            </li>
            <li>
              <strong>salt 與驗證器是明文放在同步資料裡的</strong>，因為換裝置時得靠它們才能
              從主密碼派生出同一把金鑰。代價要講清楚：能存取你 Firefox 帳號的人可以拿它們
              離線暴力猜密碼（書籤本身仍然是加密的）。所以主密碼要夠長 ——
              這也是同步預設關閉的原因。
            </li>
            <li>額度是 100 KB。加密副本超過時同步會停下並在上面警告，本機資料不受影響。</li>
            <li>預覽圖不同步（太大）。新裝置按一次「補抓預覽圖」即可。</li>
          </ul>
        </details>
      </section>

      <section>
        <h2>自動上鎖</h2>
        <div className="options__row">
          閒置
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
          分鐘後上鎖
        </div>
        <p className="options__hint">
          關閉側邊欄也會上鎖。全頁瀏覽與這個設定頁也算「開著」。
        </p>
      </section>

      <section>
        <h2>預覽圖擷取</h2>
        <label className="options__check">
          <input
            type="checkbox"
            checked={settings.captureEnabled}
            onChange={(event) => {
              update({ captureEnabled: event.target.checked });
            }}
          />
          瀏覽已加入書籤的頁面時自動產生預覽圖
        </label>
        <div className="options__row">
          預覽圖超過
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
          天後重新擷取
        </div>

        <h2 style={{ marginTop: 16 }}>不擷取的網域</h2>
        <p className="options__hint">一行一個，比對主機名稱的子字串。</p>
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
        <h2>儲存空間</h2>
        <p>
          {usage === null
            ? '計算中…'
            : `${String(usage.count)} 張預覽圖，共 ${(usage.bytes / 1_048_576).toFixed(1)} MB`}
        </p>
        <div className="options__row">
          <button
            type="button"
            className="chip"
            onClick={() => {
              void request('thumbs/clear', undefined).then(
                (result) => {
                  setStatus(`已清除 ${String(result.removed)} 張預覽圖。`);
                  setUsage({ count: 0, bytes: 0 });
                },
                () => undefined,
              );
            }}
          >
            清除所有預覽圖
          </button>
          <button
            type="button"
            className="chip"
            title="擴充套件會記住哪些 og:image 是全站共用的 logo 並降級。網站改版後可以重置。"
            onClick={() => {
              void request('site-stats/clear', undefined).then(
                () => {
                  setStatus('已重置「全站共用圖」的學習結果。');
                },
                () => undefined,
              );
            }}
          >
            重置全站共用圖的判定
          </button>
        </div>
        {status !== null ? <p className="options__status">{status}</p> : null}
      </section>
    </div>
  );
}
