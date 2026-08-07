import { broadcast } from '@/shared/messages';
import { getSettings, onSettingsChanged } from '@/storage/settings';
import { isUnlocked, lockVault, vaultState } from './vault';

/**
 * 自動上鎖。
 *
 * 兩個機制互補：
 *
 * 1. **閒置偵測**（idle API）—— 離開電腦一段時間就上鎖。
 * 2. **側邊欄連線**（runtime port）—— 這是 MV3 事件頁逼出來的需求。事件頁閒置
 *    約 30 秒就會被卸載，金鑰在記憶體裡會跟著消失，等於使用者才剛解鎖就被鎖回去。
 *    連線中斷（側邊欄關閉）代表使用者不再使用隱私空間，此時上鎖正是我們想要的行為。
 *
 *    **光是「port 開著」擋不住回收**（2026-08-05 於 Firefox 153 實測：側邊欄開著、
 *    port 連著、隱私空間解鎖中，事件頁仍在 30～50 秒後被終止，Firefox 自己在
 *    console 說它判定閒置且可終止）。所以存活是靠**心跳**：UI 每 15 秒送一則
 *    port 訊息，下面的 `onMessage` 收到就算一次活動，閒置計時器被推回去。
 *    port 本身保留它原本可靠的用途 —— 斷開時 UI 會去重問狀態。
 */
export const KEEPALIVE_PORT = 'vault-keepalive';

/**
 * 連線歸零後的寬限時間。
 *
 * 側邊欄重新渲染時會先斷開舊連線再建立新的，中間有一小段連線數為零。
 * 沒有寬限期的話那個空隙會直接觸發上鎖，表現成「每做一個操作就自己鎖起來」。
 */
const GRACE_MS = 1_500;

let ports = 0;

export function startVaultLock(): void {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== KEEPALIVE_PORT) {
      return;
    }
    ports += 1;
    /*
     * 心跳。訊息本身沒有內容，收到就算數 —— 目的只是產生一次事件頁活動，
     * 把閒置計時器推回去。少了這個 listener，訊息會被丟掉（Firefox 不會
     * 為沒有人聽的 port 訊息喚醒任何東西），事件頁照樣被回收。
     *
     * 這條路是隱私空間能一直開著的唯一原因，不要因為「看起來沒做事」而拿掉。
     */
    port.onMessage.addListener(() => {
      // 刻意不做事：收到訊息這件事本身就是目的
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
        }
      }, GRACE_MS);
    });
  });

  browser.idle.onStateChanged.addListener((state) => {
    if (state !== 'active' && isUnlocked()) {
      lockVault();
      void announce();
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
