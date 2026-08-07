import { broadcast, serve } from '@/shared/messages';
import { getSettings, patchSettings } from '@/storage/settings';
import { clearSiteImageStats } from '@/storage/site-image-stats';
import { getThumb, pruneOlderThan, usage } from '@/storage/thumbs-db';
import { backfillThumbnails, backfillVaultThumbnails } from './backfill';
import { collectFolderChoices, collectRoots } from './bookmark-tree';
import { startBookmarkWatcher } from './bookmark-watcher';
import { startCapturePipeline, startPermissionWatcher } from './capture';
import { registerPickCoverMenu } from './pick-cover';
import { refreshThumbnail, refreshVaultThumbnail } from './refresh-thumb';
import {
  adoptSyncedVault,
  changePassword,
  createFolder,
  createVault,
  deleteEverything,
  deleteFolder,
  exportBackup,
  exportManyToNative,
  exportToNative,
  forgetVault,
  importBackup,
  importManyNativeBookmarks,
  importNativeBookmark,
  listBookmarks,
  listFolders,
  lockVault,
  moveBookmarkToFolder,
  moveFolderToParent,
  moveManyToFolder,
  readVaultThumb,
  regenerateRecoveryKey,
  removeBookmark,
  renameBookmark,
  renameFolder,
  revealRecoveryKey,
  unlockVault,
  unlockWithRecoveryKey,
  vaultState,
} from './vault';
import { noteVaultActivity, startVaultLock } from './vault-lock';
import {
  clearRemote,
  overwriteRemote,
  resumeAfterRemoteDelete,
  scheduleVaultSync,
  startVaultSync,
  syncStatus,
  syncVault,
} from './vault-sync';

/**
 * 背景事件頁進入點。
 *
 * 注意：Firefox 的 MV3 用的是事件頁，會在閒置後被卸載再依事件喚醒。
 * 所有監聽器都必須在頂層同步註冊，否則喚醒後不會生效。
 */

/**
 * 廣播隱私空間的狀態，並記一次使用者活動（自動上鎖的期限往後推）。
 *
 * 每一個改動 vault 的 handler 都會呼叫這裡，所以活動記錄放在這一點就涵蓋了大半。
 * **只有 handler 會走到這裡** —— `vault-sync` 那邊的遠端變動是自己 `broadcast`，
 * 不經過這個函式，所以另一台裝置的同步不會被誤記成本機的使用者活動。
 */
async function announceVault() {
  noteVaultActivity();
  const state = await vaultState();
  broadcast('vault/changed', state);
  return state;
}

/**
 * 包住「使用者主動操作但不需要廣播狀態」的那些 handler。
 *
 * 資料夾的增刪改、搬移、補抓縮圖都不會改變 `VaultState`（書籤數沒變），所以它們
 * 沒有走 `announceVault`；但它們同樣是使用者在操作隱私空間，必須把上鎖期限推回去。
 */
async function acted<T>(work: Promise<T>): Promise<T> {
  noteVaultActivity();
  return work;
}

serve({
  'health/ping': async () => ({ version: browser.runtime.getManifest().version }),

  'bookmarks/roots': async () => collectRoots(),

  'bookmarks/open': async ({ url, where }) => {
    if (where === 'current') {
      await browser.tabs.update({ url });
      return;
    }
    await browser.tabs.create({ url, active: where === 'newTab' });
  },

  'bookmarks/rename': async ({ id, title }) => {
    await browser.bookmarks.update(id, { title });
  },
  'bookmarks/delete': async ({ id }) => {
    await browser.bookmarks.remove(id);
  },
  'bookmarks/move': async ({ id, parentId }) => {
    await browser.bookmarks.move(id, { parentId });
  },
  // 逐筆搬並各自計數：其中一筆已被刪掉不該讓整批停下
  'bookmarks/move-many': async ({ ids, parentId }) => {
    let moved = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await browser.bookmarks.move(id, { parentId });
        moved += 1;
      } catch {
        failed += 1;
      }
    }
    return { moved, failed };
  },
  'bookmarks/folders': async () => collectFolderChoices(),
  'bookmarks/folder-create': async ({ parentId, title }) => {
    // 沒有 url 就是資料夾
    await browser.bookmarks.create(parentId === undefined ? { title } : { parentId, title });
  },

  'settings/get': async () => getSettings(),
  'settings/patch': async (patch) => {
    const next = await patchSettings(patch);
    // 剛打開同步就馬上跑一次：不然使用者要等到下一次寫入才看得到任何反應
    if (patch.vaultSyncEnabled === true) {
      scheduleVaultSync();
    }
    return next;
  },

  'thumbs/backfill': async () => backfillThumbnails(),
  'thumbs/refresh': async ({ url }) => refreshThumbnail(url),
  'thumbs/get': async ({ key }) => {
    const record = await getThumb(key);
    // 加密的縮圖（隱私書籤）走 vault/thumb 那條路，這裡一律當成沒有
    if (record === undefined || record.encrypted) {
      return null;
    }
    return {
      bytes: record.bytes,
      mime: record.mime,
      width: record.width,
      height: record.height,
      source: record.source,
    };
  },
  'thumbs/usage': async () => usage(),
  'thumbs/clear': async () => {
    const removed = await pruneOlderThan(Date.now());
    // 開著的頁面各自有一份記憶體快取，清空 IndexedDB 不會動到它們
    broadcast('thumbs/cleared', undefined);
    return { removed };
  },
  'site-stats/clear': async () => clearSiteImageStats(),

  'vault/state': async () => vaultState(),
  'vault/create': async ({ password }) => {
    const recoveryKey = await createVault(password);
    return { state: await announceVault(), recoveryKey };
  },
  'vault/unlock': async ({ password }) => {
    await unlockVault(password);
    // 解鎖是唯一「有金鑰因此能合併」的時機點，把遠端的變動拉進來
    scheduleVaultSync();
    return announceVault();
  },
  'vault/unlock-recovery': async ({ recoveryKey }) => {
    await unlockWithRecoveryKey(recoveryKey);
    scheduleVaultSync();
    return announceVault();
  },
  'vault/change-password': async ({ current, next }) => acted(changePassword(current, next)),
  'vault/regenerate-recovery': async ({ password }) => ({
    recoveryKey: await acted(regenerateRecoveryKey(password)),
  }),
  'vault/reveal-recovery': async () => ({ recoveryKey: await acted(revealRecoveryKey()) }),
  'vault/forget': async () => {
    await forgetVault();
    return announceVault();
  },
  'vault/lock': async () => {
    lockVault();
    return announceVault();
  },
  'vault/list': async () => listBookmarks(),
  'vault/import': async ({ bookmarkId, purgeHistory }) => {
    const result = await importNativeBookmark(bookmarkId, purgeHistory);
    return {
      state: await announceVault(),
      bookmarks: result.bookmarks,
      folders: result.folders,
      historyPurged: result.historyPurged,
      historyUnavailable: result.historyUnavailable,
    };
  },
  'vault/import-many': async ({ bookmarkIds, purgeHistory }) => {
    const result = await importManyNativeBookmarks(bookmarkIds, purgeHistory);
    return { state: await announceVault(), ...result };
  },
  'vault/rename': async ({ id, title }) => {
    await renameBookmark(id, title);
    return announceVault();
  },
  'vault/refresh-thumb': async ({ id }) => acted(refreshVaultThumbnail(id)),
  'vault/folders': async () => listFolders(),
  'vault/folder-create': async ({ name, parentId }) => acted(createFolder(name, parentId)),
  'vault/folder-rename': async ({ id, name }) => acted(renameFolder(id, name)),
  'vault/folder-delete': async ({ id }) => acted(deleteFolder(id)),
  'vault/folder-move': async ({ id, parentId }) => acted(moveFolderToParent(id, parentId)),
  'vault/move': async ({ id, folderId }) => acted(moveBookmarkToFolder(id, folderId)),
  'vault/backfill': async () => acted(backfillVaultThumbnails()),
  'vault/export': async ({ id, parentId }) => {
    await exportToNative(id, parentId);
    return announceVault();
  },
  'vault/export-many': async ({ ids, parentId }) => {
    const result = await exportManyToNative(ids, parentId);
    return { state: await announceVault(), ...result };
  },
  'vault/move-many': async ({ ids, folderId }) => acted(moveManyToFolder(ids, folderId)),
  'vault/remove': async ({ id }) => {
    await removeBookmark(id);
    return announceVault();
  },
  'vault/destroy': async () => {
    await deleteEverything();
    return announceVault();
  },
  'vault/thumb': async ({ id }) => readVaultThumb(id),

  'vault/backup-export': async () => acted(exportBackup()),
  'vault/backup-import': async ({ json, secret, viaRecoveryKey }) => {
    const result = await importBackup(json, secret, viaRecoveryKey);
    return { state: await announceVault(), ...result };
  },

  'vault/sync-status': async () => syncStatus(),
  'vault/sync-now': async () => {
    await syncVault();
    return syncStatus();
  },
  'vault/sync-overwrite': async () => {
    await overwriteRemote();
    return syncStatus();
  },
  'vault/sync-adopt': async () => {
    await adoptSyncedVault();
    return announceVault();
  },
  'vault/sync-clear': async () => {
    await clearRemote();
    return syncStatus();
  },
  'vault/sync-resume': async () => {
    await resumeAfterRemoteDelete();
    return syncStatus();
  },
});

startBookmarkWatcher();
startCapturePipeline();
startPermissionWatcher();
startVaultLock();
startVaultSync();
registerPickCoverMenu();

// 開啟側邊欄不需要背景程式碼：manifest 的 commands 用了 Firefox 內建的
// _execute_sidebar_action（Ctrl+Shift+L）。原本改用 action.onClicked 呼叫
// sidebarAction.toggle()，但實測從擴充套件面板點擊不會派送 onClicked，
// 而內建 command 由 Firefox 自己處理，也不受「必須在使用者操作處理器內」的限制。
