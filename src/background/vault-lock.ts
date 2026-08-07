import { broadcast } from '@/shared/messages';
import { getSettings, onSettingsChanged } from '@/storage/settings';
import { isUnlocked, lockVault, vaultState } from './vault';

/**
 * 自動上鎖。
 *
 * 三個機制互補：
 *
 * 1. **沒碰隱私空間就計時**（下面的 `noteVaultActivity` + 檢查 tick）—— 這是主要
 *    的那一道。設定頁的「閒置 N 分鐘後上鎖」指的就是它。
 * 2. **系統閒置偵測**（idle API）—— 整台電腦沒有鍵鼠輸入滿 N 分鐘。它涵蓋的是
 *    「人離開電腦了」，與第 1 條取先到的那個。
 * 3. **側邊欄連線**（runtime port）—— 這是 MV3 事件頁逼出來的需求。事件頁閒置
 *    約 30 秒就會被卸載，金鑰在記憶體裡會跟著消失，等於使用者才剛解鎖就被鎖回去。
 *    連線中斷（側邊欄關閉）代表使用者不再使用隱私空間，此時上鎖正是我們想要的行為。
 *
 *    **光是「port 開著」擋不住回收**（2026-08-05 於 Firefox 153 實測：側邊欄開著、
 *    port 連著、隱私空間解鎖中，事件頁仍在 30～50 秒後被終止，Firefox 自己在
 *    console 說它判定閒置且可終止）。所以存活是靠**心跳**：UI 每 15 秒送一則
 *    port 訊息，下面的 `onMessage` 收到就算一次事件頁活動。
 *    port 本身保留它原本可靠的用途 —— 斷開時 UI 會去重問狀態。
 *
 * **為什麼第 1 條不能省，只留第 2 條**（2026-08-07 使用者回報）：`browser.idle` 問的是
 * 「整台電腦有沒有鍵鼠輸入」，不是「有沒有在用隱私空間」。只要人還在用電腦（看影片、
 * 在別的分頁打字），idle 永遠不會觸發，解鎖狀態就無限期延續下去 —— 而全頁瀏覽的分頁
 * 可以在背景放好幾個小時，它的心跳還會主動擋住事件頁被回收，連「被回收所以鎖上」
 * 這條意外的保護都沒了。`PLAN.md` 當初寫的是 `alarms + idle`，只有 idle 那半實作了。
 *
 * **心跳不算活動。** 心跳每 15 秒固定發生，與使用者有沒有在操作無關；把它當活動的話
 * 期限永遠不會到。所以 port 訊息分兩種：`ping` 只負責讓事件頁活著，`activity` 才會
 * 把期限往後推，由 UI 在使用者真的動了（指標按下、按鍵）時送出。
 *
 * **讀取訊息也不算活動。** `vault-sync` 在遠端有變動時會 `broadcast('vault/changed')`，
 * UI 收到就會重讀 `vault/list` 與 `vault/folders`。把這些讀取當成活動的話，另一台裝置
 * 的同步就能無聲地把期限一直往後推。只有使用者主動的操作（`noteVaultActivity`）算。
 */
export const KEEPALIVE_PORT = 'vault-keepalive';

/**
 * 連線歸零後的寬限時間。
 *
 * 側邊欄重新渲染時會先斷開舊連線再建立新的，中間有一小段連線數為零。
 * 沒有寬限期的話那個空隙會直接觸發上鎖，表現成「每做一個操作就自己鎖起來」。
 */
const GRACE_MS = 1_500;

/**
 * 檢查閒置期限的頻率。
 *
 * 與心跳同一個節奏（15 秒）就夠細了 —— 上鎖最多晚 15 秒發生，而設定值以分鐘為單位。
 * **這個 tick 只在解鎖期間跑**：解鎖時 UI 的心跳本來就讓事件頁活著，所以它不會額外
 * 延長事件頁的壽命；上鎖後就停掉，不留一個永遠在跑的計時器。
 */
const CHECK_MS = 15_000;

let ports = 0;
let lastActivityAt = Date.now();
let checkTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 記一次「使用者主動操作了隱私空間」，把閒置上鎖的期限往後推。
 *
 * 呼叫端有兩類：UI 透過 keepalive port 送來的 `activity`（指標按下、按鍵，且限於
 * 隱私空間那一頁在前面時），以及背景頁這邊每一個使用者發動的 vault 操作。
 * **不要**在讀取類的訊息或心跳裡呼叫它 —— 那些會在沒有人操作時發生。
 */
export function noteVaultActivity(): void {
  lastActivityAt = Date.now();
  startInactivityWatch();
}

function startInactivityWatch(): void {
  if (checkTimer !== null) {
    return;
  }
  checkTimer = setInterval(() => {
    void checkInactivity();
  }, CHECK_MS);
}

function stopInactivityWatch(): void {
  if (checkTimer === null) {
    return;
  }
  clearInterval(checkTimer);
  checkTimer = null;
}

async function checkInactivity(): Promise<void> {
  // 已經鎖上（或事件頁重啟後金鑰不在了）就沒有什麼要看的
  if (!isUnlocked()) {
    stopInactivityWatch();
    return;
  }
  const { autoLockMinutes } = await getSettings();
  if (Date.now() - lastActivityAt < autoLockMinutes * 60_000) {
    return;
  }
  lockVault();
  void announce();
  stopInactivityWatch();
}

export function startVaultLock(): void {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== KEEPALIVE_PORT) {
      return;
    }
    ports += 1;
    /*
     * 兩種 port 訊息：
     *
     * - `ping`（心跳，每 15 秒）：收到這件事本身就是目的 —— 產生一次事件頁活動，
     *   把 Firefox 的**事件頁回收**計時器推回去。少了這個 listener，訊息會被丟掉
     *   （Firefox 不會為沒有人聽的 port 訊息喚醒任何東西），事件頁照樣被回收。
     *   這條路是隱私空間能一直開著的唯一原因，不要因為「看起來沒做事」而拿掉。
     *   **它刻意不算使用者活動**：它與使用者有沒有在操作完全無關。
     * - `activity`：使用者真的動了。這一種才把自動上鎖的期限往後推。
     */
    port.onMessage.addListener((message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: unknown }).type === 'activity'
      ) {
        noteVaultActivity();
      }
    });
    port.onDisconnect.addListener(() => {
      ports = Math.max(0, ports - 1);
      if (ports > 0) {
        return;
      }
      setTimeout(() => {
        // 寬限期內有新連線接上就不上鎖
        if (ports === 0 && isUnlocked()) {
          lockVault();
          void announce();
          stopInactivityWatch();
        }
      }, GRACE_MS);
    });
  });

  browser.idle.onStateChanged.addListener((state) => {
    if (state !== 'active' && isUnlocked()) {
      lockVault();
      void announce();
      stopInactivityWatch();
    }
  });

  void applyIdleInterval();
  onSettingsChanged(() => {
    void applyIdleInterval();
  });
}

async function applyIdleInterval(): Promise<void> {
  const settings = await getSettings();
  // idle API 以秒為單位，且最小值為 15 秒
  const seconds = Math.max(15, Math.round(settings.autoLockMinutes * 60));
  browser.idle.setDetectionInterval(seconds);
}

async function announce(): Promise<void> {
  broadcast('vault/changed', await vaultState());
}
