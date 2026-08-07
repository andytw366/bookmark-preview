import { useCallback, useEffect, useState } from 'react';
import { request, subscribe } from '@/shared/messages';
import type { PrivateBookmark, PrivateFolder, VaultState } from '@/shared/types';

const KEEPALIVE_PORT = 'vault-keepalive';

/**
 * 心跳間隔。
 *
 * MV3 事件頁閒置約 30 秒就被回收，所以這個值必須明顯小於 30 秒，
 * 又不值得更密（每次心跳都會喚醒背景頁）。15 秒留了一倍的餘裕。
 */
const KEEPALIVE_PING_MS = 15_000;

interface VaultApi {
  state: VaultState | null;
  bookmarks: PrivateBookmark[];
  folders: PrivateFolder[];
  error: string | null;
  clearError: () => void;
  /**
   * 建立隱私空間。成功時回傳**只會出現這一次**的救援金鑰，失敗回傳 null。
   *
   * 回傳那串碼而不是在這裡顯示：呼叫端要負責把它攤在使用者面前並要求確認已抄下，
   * 而 hook 不該決定 UI 怎麼呈現一個不可挽回的東西。
   */
  create: (password: string) => Promise<string | null>;
  unlock: (password: string) => Promise<boolean>;
  /** 用救援金鑰解鎖。回傳是否成功 */
  unlockWithRecoveryKey: (recoveryKey: string) => Promise<boolean>;
  lock: () => Promise<void>;
  moveIn: (bookmarkId: string, purgeHistory: boolean) => Promise<string | null>;
  moveInMany: (bookmarkIds: string[], purgeHistory: boolean) => Promise<string | null>;
  moveOut: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  destroy: () => Promise<void>;
  /** 放棄這台裝置上的隱私空間，不需要先解鎖（忘記密碼或舊格式時唯一的出路） */
  forget: () => Promise<void>;
  createFolder: (name: string, parentId: string | null) => Promise<void>;
  renameFolder: (id: string, name: string) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  moveToFolder: (id: string, folderId: string | null) => Promise<void>;
  /** 搬移資料夾本身。與 `moveToFolder` 分開：資料夾多一條「不能搬進自己的子樹」的規則 */
  moveFolder: (id: string, parentId: string | null) => Promise<void>;
  /** 重讀清單。重新命名之類的操作直接走 request，改完要讓 UI 跟上 */
  reload: () => Promise<void>;
  /**
   * 向背景頁重新確認狀態並回傳。
   *
   * 用於不能相信快取的時候：事件頁被卸載時金鑰會無聲消失（沒有廣播），
   * 快取可能還停在「已解鎖」。背景頁是唯一的權威來源。
   */
  refreshState: () => Promise<VaultState | null>;
}

export function useVault(): VaultApi {
  const [state, setState] = useState<VaultState | null>(null);
  const [bookmarks, setBookmarks] = useState<PrivateBookmark[]>([]);
  const [folders, setFolders] = useState<PrivateFolder[]>([]);
  const [error, setError] = useState<string | null>(null);

  /**
   * 廣播抵達時除了更新狀態，**解鎖中就一併重讀清單**。
   *
   * 少了重讀的話，另一個頁面（全頁瀏覽）改動 vault 之後這裡只有計數會變，
   * 清單停在舊資料 —— 表現成「標頭寫 0 個隱私書籤，底下卻列著兩筆」。
   * 動作是誰做的，只有那個 context 會在自己的 mutation 後 refreshList()；
   * 其他 context 唯一的通知來源就是這則廣播。
   *
   * 不能改成讓下面那個 effect 依賴整個 state 物件來達成同樣效果：每則廣播都是
   * 新物件，那會讓 keepalive port 反覆斷開重連，背景頁在空隙看到連線數歸零就上鎖。
   */
  useEffect(() => {
    void request('vault/state', undefined).then(setState, () => undefined);
    return subscribe('vault/changed', (next) => {
      setState(next);
      if (next.status !== 'unlocked') {
        return;
      }
      void request('vault/list', undefined).then(setBookmarks, () => undefined);
      void request('vault/folders', undefined).then(setFolders, () => undefined);
    });
  }, []);

  const status = state?.status;

  // 解鎖期間維持一條 port 連線，避免 MV3 事件頁被卸載而讓金鑰消失
  // （那會表現成「才剛解鎖就自己鎖回去」）。
  //
  // 依賴 status 而不是整個 state 物件：每次 vault/changed 廣播都會產生新物件，
  // 若依賴物件本身，effect 會反覆重跑，舊 port 先斷開再接新的 —— 背景頁在那個
  // 空隙看到連線數歸零就會上鎖，導致每次操作後隱私空間都自己鎖起來。
  useEffect(() => {
    if (status !== 'unlocked') {
      setBookmarks([]);
      setFolders([]);
      return;
    }
    let closing = false;
    const port = browser.runtime.connect({ name: KEEPALIVE_PORT });
    /*
     * 光是「port 開著」擋不住事件頁被回收 —— 2026-08-05 在 Firefox 153 實測：
     * 側邊欄開著、port 連著、隱私空間解鎖中，事件頁照樣在 30～50 秒後被終止，
     * Firefox 還在背景頁 console 明說它判定閒置且可終止。使用者看到的是
     * 「隔一下子回來就要重打主密碼」，甚至會在挑書籤挑到一半時發生。
     *
     * 真正有效的是**定期活動**：每次訊息抵達都會把閒置計時器推回去。
     * 所以這裡靠心跳維持存活，port 本身只保留它原本可靠的那個用途 ——
     * 斷開時通知 UI 去重問狀態。
     */
    const heartbeat = setInterval(() => {
      try {
        port.postMessage({ type: 'ping' });
      } catch {
        // port 已經斷了；onDisconnect 會處理，這裡不必再做什麼
      }
    }, KEEPALIVE_PING_MS);
    void request('vault/list', undefined).then(setBookmarks, () => undefined);
    void request('vault/folders', undefined).then(setFolders, () => undefined);

    /*
     * 連線斷掉就重新問一次狀態。
     *
     * 這條 port 是唯一可靠的「背景頁還活著嗎」訊號。MV3 事件頁被卸載時
     * 記憶體裡的金鑰會直接消失 —— 等於上鎖 —— 但那條路沒有任何程式碼跑得到，
     * 因此**不會有 `vault/changed` 廣播**。結果就是側邊欄一直顯示「已解鎖」，
     * 實際上早就鎖了：移不進隱私空間，而畫面看起來一切正常。
     *
     * port 斷開時背景頁一定已經不在原本的狀態，重新問一次就會拿到 locked。
     */
    port.onDisconnect.addListener(() => {
      if (closing) {
        return;
      }
      void request('vault/state', undefined).then(setState, () => undefined);
    });

    return () => {
      // 自己拆掉連線時不必回頭問狀態（例如已經切成上鎖）
      closing = true;
      clearInterval(heartbeat);
      port.disconnect();
    };
  }, [status]);

  /*
   * 回到這個畫面時重新確認狀態。
   *
   * 補上 port 訊號到不了的情況：整個瀏覽器被系統暫停、或側邊欄長時間沒有
   * 前景而事件頁在那期間被回收。使用者的實際操作是「切走一陣子再切回來」，
   * 這正好是 visibilitychange 會觸發的時機。
   */
  useEffect(() => {
    const recheck = (): void => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      void request('vault/state', undefined).then(setState, () => undefined);
    };
    document.addEventListener('visibilitychange', recheck);
    window.addEventListener('focus', recheck);
    return () => {
      document.removeEventListener('visibilitychange', recheck);
      window.removeEventListener('focus', recheck);
    };
  }, []);

  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<T | null> => {
    try {
      const result = await work();
      setError(null);
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  }, []);

  const refreshList = useCallback(async () => {
    setBookmarks(await request('vault/list', undefined));
  }, []);

  /**
   * 資料夾動作都要連書籤一起重讀：刪除資料夾會把裡面的書籤搬到上一層，
   * 只重讀資料夾清單的話畫面上那些書籤會停在已經不存在的 folderId 下。
   */
  const refreshAll = useCallback(async () => {
    setFolders(await request('vault/folders', undefined));
    setBookmarks(await request('vault/list', undefined));
  }, []);

  return {
    state,
    bookmarks,
    folders,
    error,
    clearError: () => {
      setError(null);
    },
    create: async (password) => {
      const result = await run(async () => request('vault/create', { password }));
      if (result === null) {
        return null;
      }
      setState(result.state);
      return result.recoveryKey;
    },
    unlock: async (password) => {
      const next = await run(async () => request('vault/unlock', { password }));
      if (next === null) {
        return false;
      }
      setState(next);
      return true;
    },
    unlockWithRecoveryKey: async (recoveryKey) => {
      const next = await run(async () => request('vault/unlock-recovery', { recoveryKey }));
      if (next === null) {
        return false;
      }
      setState(next);
      return true;
    },
    lock: async () => {
      await run(async () => {
        setState(await request('vault/lock', undefined));
      });
    },
    moveIn: async (bookmarkId, purgeHistory) => {
      const report = await run(async () => request('vault/import', { bookmarkId, purgeHistory }));
      if (report === null) {
        return null;
      }
      setState(report.state);
      // 移入的可能是整個資料夾，資料夾清單也得跟著更新
      await refreshAll();
      const moved =
        report.folders > 0
          ? `資料夾已移入隱私空間（${String(report.folders)} 個資料夾、${String(report.bookmarks)} 個書籤）`
          : '書籤已移入隱私空間';
      if (report.historyUnavailable) {
        return `${moved}，但因為沒有瀏覽記錄權限，網址仍留在瀏覽記錄與網址列自動完成中。`;
      }
      return report.historyPurged > 0
        ? `${moved}，並清除了 ${String(report.historyPurged)} 筆瀏覽記錄。`
        : `${moved}。`;
    },
    moveInMany: async (bookmarkIds, purgeHistory) => {
      const report = await run(async () => request('vault/import-many', { bookmarkIds, purgeHistory }));
      if (report === null) {
        return null;
      }
      setState(report.state);
      await refreshAll();
      const parts = [
        report.folders > 0
          ? `已移入 ${String(report.imported)} 個書籤與 ${String(report.folders)} 個資料夾`
          : `已移入 ${String(report.imported)} 個書籤`,
      ];
      if (report.failed > 0) {
        parts.push(`${String(report.failed)} 個失敗`);
      }
      if (report.historyUnavailable) {
        parts.push('因為沒有瀏覽記錄權限，這些網址仍留在瀏覽記錄與網址列自動完成中');
      } else if (report.historyPurged > 0) {
        parts.push(`並清除了 ${String(report.historyPurged)} 筆瀏覽記錄`);
      }
      return `${parts.join('，')}。`;
    },
    moveOut: async (id) => {
      await run(async () => {
        setState(await request('vault/export', { id }));
        // 移出的可能是整個資料夾，資料夾清單也得跟著更新
        await refreshAll();
      });
    },
    remove: async (id) => {
      await run(async () => {
        setState(await request('vault/remove', { id }));
        await refreshList();
      });
    },
    destroy: async () => {
      await run(async () => {
        setState(await request('vault/destroy', undefined));
        setBookmarks([]);
      });
    },
    forget: async () => {
      await run(async () => {
        setState(await request('vault/forget', undefined));
        setBookmarks([]);
        setFolders([]);
      });
    },
    createFolder: async (name, parentId) => {
      await run(async () => {
        await request('vault/folder-create', { name, parentId });
        await refreshAll();
      });
    },
    renameFolder: async (id, name) => {
      await run(async () => {
        await request('vault/folder-rename', { id, name });
        await refreshAll();
      });
    },
    deleteFolder: async (id) => {
      await run(async () => {
        await request('vault/folder-delete', { id });
        await refreshAll();
      });
    },
    moveToFolder: async (id, folderId) => {
      await run(async () => {
        await request('vault/move', { id, folderId });
        await refreshList();
      });
    },
    moveFolder: async (id, parentId) => {
      await run(async () => {
        await request('vault/folder-move', { id, parentId });
        // 這裡要 refreshAll 不是 refreshList：動到的是資料夾，清單與資料夾都得重讀
        await refreshAll();
      });
    },
    /*
     * 重讀**書籤與資料夾兩者**。
     *
     * 這裡原本只重讀書籤，於是批量「移動到…」搬動資料夾之後，那個資料夾會
     * 繼續留在畫面上的舊位置（訊息說「已移動 2 個項目」，但看起來只有書籤動了）——
     * 使用者只能靠上鎖再解鎖才看得到正確結構。多一次 `vault/folders` 很便宜，
     * 「reload」這個名字本來就該是「全部重讀」。
     */
    reload: async () => {
      await run(refreshAll);
    },
    refreshState: async () => {
      try {
        const fresh = await request('vault/state', undefined);
        setState(fresh);
        return fresh;
      } catch {
        return null;
      }
    },
  };
}
