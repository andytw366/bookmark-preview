import { broadcast, serve } from '@/shared/messages';
import { getSettings, patchSettings } from '@/storage/settings';
import { clearSiteImageStats } from '@/storage/site-image-stats';
import { getThumb, pruneOlderThan, usage } from '@/storage/thumbs-db';
import { VAULT_THUMB_PREFIX } from '@/shared/url';
import { backfillThumbnails, backfillVaultThumbnails } from './backfill';
import {
  applyBookmarkGrid,
  clearGridSync,
  findTagged,
  flattenFolder,
  getBookmarkGrid,
  gridSyncStatus,
  groupToFolder,
  moveGroup,
  reconcileGridSync,
  startGridWatcher,
} from './bookmark-grid';
import { mergeIntoNewFolder as mergeBookmarksIntoFolder, reorderBookmarks } from './bookmark-order';
import { collectFolderChoices, collectRoots } from './bookmark-tree';
import { startBookmarkWatcher } from './bookmark-watcher';
import { startCapturePipeline, startPermissionWatcher } from './capture';
import { registerPickCoverMenu } from './pick-cover';
import {
  refreshThumbnail,
  refreshVaultThumbnail,
  setThumbnailMode,
  setVaultThumbnailMode,
} from './refresh-thumb';
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
  isUnlocked,
  listBookmarks,
  listFolders,
  lockVault,
  applyVaultGrid,
  flattenVaultFolder,
  moveVaultGroup,
  vaultGroupToFolder,
  mergeIntoNewFolder,
  readLayout,
  reorder,
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


/**
 * 設定頁看得到的預覽圖（「儲存空間」的張數與容量、「清除所有預覽圖」動到的那些）。
 *
 * 隱藏模式又上鎖時不算隱私書籤的預覽圖：別人可以拿這些數字和看得到的書籤數比對，
 * 推算出這台電腦有隱私書籤。清除時也不動它們 —— 那時介面上本來就不存在它們。
 */
async function visibleThumbs(): Promise<(key: string) => boolean> {
  const concealed = (await getSettings()).vaultEntry === 'hidden' && !isUnlocked();
  return (key) => !concealed || !key.startsWith(VAULT_THUMB_PREFIX);
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
    // `remove` 只刪得掉空資料夾（有內容時直接丟錯）；資料夾一律整棵刪 —— 確認提示已經說了會連同裡面一起刪
    const [node] = await browser.bookmarks.get(id);
    if (node !== undefined && node.url === undefined) {
      await browser.bookmarks.removeTree(id);
      return;
    }
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
  'bookmarks/reorder': async ({ ids, parentId, beforeId }) => reorderBookmarks(ids, parentId, beforeId),
  'bookmarks/merge-folder': async ({ targetId, ids, title }) => ({
    id: await mergeBookmarksIntoFolder(targetId, ids, title),
  }),
  'grid/get': async ({ folderId }) => getBookmarkGrid(folderId),
  'grid/apply': async ({ folderId, columns, op }) => applyBookmarkGrid(folderId, columns, op),
  'grid/sync-status': async () => gridSyncStatus(),
  'groups/to-folder': async ({ folderId, groupId, columns }) => ({ id: await groupToFolder(folderId, groupId, columns) }),
  'groups/flatten': async ({ folderId, columns }) => flattenFolder(folderId, columns),
  'groups/move': async ({ fromFolderId, groupId, toFolderId, columns }) =>
    moveGroup(fromFolderId, groupId, toFolderId, columns),
  'groups/find': async ({ name }) => findTagged(name),
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
    if (patch.syncGrid === true) {
      await reconcileGridSync();
    } else if (patch.syncGrid === false) {
      await clearGridSync();
    }
    return next;
  },

  'thumbs/backfill': async () => backfillThumbnails(),
  'thumbs/refresh': async ({ url }) => refreshThumbnail(url),
  'thumbs/set-mode': async ({ url, mode }) => setThumbnailMode(url, mode),
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
  'thumbs/usage': async () => usage(await visibleThumbs()),
  'thumbs/clear': async () => {
    const removed = await pruneOlderThan(Date.now(), await visibleThumbs());
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
  'vault/set-thumb-mode': async ({ id, mode }) => acted(setVaultThumbnailMode(id, mode)),
  'vault/folders': async () => listFolders(),
  'vault/folder-create': async ({ name, parentId }) => acted(createFolder(name, parentId)),
  'vault/folder-rename': async ({ id, name }) => acted(renameFolder(id, name)),
  'vault/folder-delete': async ({ id }) => acted(deleteFolder(id)),
  'vault/folder-move': async ({ id, parentId }) => acted(moveFolderToParent(id, parentId)),
  'vault/move': async ({ id, folderId }) => acted(moveBookmarkToFolder(id, folderId)),
  'vault/layout': async () => readLayout(),
  // 排列要讓其他開著的頁面（側邊欄、另一個全頁瀏覽）跟上，所以走廣播
  'vault/reorder': async ({ ids, folderId, beforeId }) => {
    await reorder(ids, folderId, beforeId);
    return announceVault();
  },
  'vault/merge-folder': async ({ targetId, ids, name }) => {
    const id = await mergeIntoNewFolder(targetId, ids, name);
    await announceVault();
    return { id };
  },
  // 群組的變動都要讓其他開著的頁面跟上（版面在 vault/changed 時重讀）
  'vault/grid-apply': async ({ folderId, columns, op }) => {
    await applyVaultGrid(folderId, columns, op);
    await announceVault();
  },
  'vault/group-to-folder': async ({ groupId, columns }) => {
    const id = await vaultGroupToFolder(groupId, columns);
    await announceVault();
    return { id };
  },
  'vault/group-flatten': async ({ folderId, columns }) => {
    await flattenVaultFolder(folderId, columns);
    await announceVault();
  },
  'vault/group-move': async ({ groupId, toFolderId, columns }) => {
    await moveVaultGroup(groupId, toFolderId, columns);
    await announceVault();
  },
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
startGridWatcher();
startCapturePipeline();
startPermissionWatcher();
startVaultLock();
startVaultSync();
registerPickCoverMenu();

// 開啟側邊欄不需要背景程式碼：manifest 的 commands 用了 Firefox 內建的
// _execute_sidebar_action（Ctrl+Shift+L）。原本改用 action.onClicked 呼叫
// sidebarAction.toggle()，但實測從擴充套件面板點擊不會派送 onClicked，
// 而內建 command 由 Firefox 自己處理，也不受「必須在使用者操作處理器內」的限制。
