import { createSerialQueue } from '@/shared/serial-queue';
import { broadcast } from '@/shared/messages';
import type { GroupPatch, GroupTarget, StoredGroup } from '@/shared/messages';
import { nextColor, sameName } from '@/shared/groups';
import { t } from '@/shared/i18n';
import { reorderBookmarks } from './bookmark-order';

/**
 * 原生書籤的群組（＝ tag）。
 *
 * **WebExtension 讀不到 Firefox 原生的標籤**，所以群組是擴充套件自己存的：`storage.local` 的
 * `groups:<資料夾 guid>`。明文沒有問題 —— 那些本來就是明文的 Firefox 書籤。**只存本機**：
 * 同步得到，但會吃掉與隱私空間共用的 `storage.sync` 配額（NEXT.md 第 3 期）。
 *
 * 擴充套件不在時群組看不到，所以加入群組時順便把書籤搬到最後一個成員後面：
 * 成員在 Firefox 的書籤選單與書籤管理員裡也是相鄰的，排列仍然合理。
 *
 * **所有改動走同一個佇列，連 `onRemoved` / `onMoved` 的清理也是。** 群組操作自己就會
 * 搬書籤，那些搬動觸發的 `onMoved` 若與操作本身交錯，「讀 → 改 → 寫」會互相蓋掉。
 */
const PREFIX = 'groups:';
const exclusive = createSerialQueue();

function keyOf(folderId: string): string {
  return `${PREFIX}${folderId}`;
}

function isStoredGroup(value: unknown): value is StoredGroup {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const group = value as Partial<StoredGroup>;
  return (
    typeof group.id === 'string' &&
    typeof group.name === 'string' &&
    typeof group.color === 'number' &&
    typeof group.collapsed === 'boolean' &&
    Array.isArray(group.members) &&
    group.members.every((member) => typeof member === 'string')
  );
}

async function read(folderId: string): Promise<StoredGroup[]> {
  const stored = await browser.storage.local.get(keyOf(folderId));
  const doc = stored[keyOf(folderId)] as { groups?: unknown } | undefined;
  return Array.isArray(doc?.groups) ? doc.groups.filter(isStoredGroup) : [];
}

/** 空群組自動消失；一個群組都不剩就把整個鍵刪掉 */
async function write(folderId: string, groups: readonly StoredGroup[]): Promise<void> {
  const kept = groups.filter((group) => group.members.length > 0);
  if (kept.length === 0) {
    await browser.storage.local.remove(keyOf(folderId));
  } else {
    await browser.storage.local.set({ [keyOf(folderId)]: { groups: kept } });
  }
  broadcast('groups/changed', { folderId });
}

function without(groups: readonly StoredGroup[], ids: ReadonlySet<string>): StoredGroup[] {
  return groups.map((group) => ({ ...group, members: group.members.filter((id) => !ids.has(id)) }));
}

export async function listGroups(folderId: string): Promise<StoredGroup[]> {
  return read(folderId);
}

/**
 * 群組最後一個成員後面那一筆（不在 `moving` 裡）—— 新加入的成員要排到它前面。
 * 群組還沒有成員時回 `undefined`（呼叫端決定放哪）。
 */
async function anchorAfterMembers(
  folderId: string,
  members: readonly string[],
  moving: ReadonlySet<string>,
): Promise<string | null | undefined> {
  const memberSet = new Set(members.filter((id) => !moving.has(id)));
  if (memberSet.size === 0) {
    return undefined;
  }
  const siblings = await browser.bookmarks.getChildren(folderId);
  let lastAt = -1;
  siblings.forEach((node, index) => {
    if (memberSet.has(node.id)) {
      lastAt = index;
    }
  });
  return siblings.slice(lastAt + 1).find((node) => !moving.has(node.id))?.id ?? null;
}

/**
 * 把 `ids` 加入（或移出）這個資料夾裡的某個群組。回傳最後所在的群組 id。
 *
 * `arrange` 為 true 時順便搬原生書籤，讓成員相鄰（右鍵「設定 tag」、合併選單用）。
 * 拖拽已經把書籤放在使用者指定的位置了，那時傳 false —— 否則剛放好的位置會被搬走。
 */
export async function assignGroup(
  folderId: string,
  ids: readonly string[],
  target: GroupTarget,
  arrange: boolean,
): Promise<string | null> {
  return exclusive(async () => {
    const moving = new Set(ids);
    const groups = without(await read(folderId), moving);
    if (target.kind === 'none') {
      await write(folderId, groups);
      return null;
    }
    let group =
      target.kind === 'id'
        ? groups.find((item) => item.id === target.groupId)
        : target.kind === 'name' && target.name.trim() !== ''
          ? groups.find((item) => sameName(item.name, target.name))
          : undefined;
    if (group === undefined) {
      if (target.kind === 'id') {
        throw new Error(t('group_not_found'));
      }
      group = {
        id: crypto.randomUUID(),
        name: target.name.trim(),
        color: nextColor(groups),
        collapsed: false,
        members: [],
      };
      groups.push(group);
    }
    if (arrange) {
      const anchor = await anchorAfterMembers(folderId, group.members, moving);
      if (anchor !== undefined) {
        await reorderBookmarks(ids, folderId, anchor);
      } else if (ids.length > 1) {
        // 新群組：聚到第一個的位置
        await reorderBookmarks(ids, folderId, ids[0] ?? null);
      }
    }
    group.members.push(...ids);
    await write(folderId, groups);
    return group.id;
  });
}

export async function updateGroup(folderId: string, groupId: string, patch: GroupPatch): Promise<void> {
  return exclusive(async () => {
    const groups = await read(folderId);
    const group = groups.find((item) => item.id === groupId);
    if (group === undefined) {
      throw new Error(t('group_not_found'));
    }
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      // 同一個資料夾裡不能有兩個同名群組（名稱就是 tag）
      if (name !== '' && groups.some((item) => item.id !== groupId && sameName(item.name, name))) {
        throw new Error(t('group_name_taken', name));
      }
      group.name = name;
    }
    if (patch.color !== undefined) {
      group.color = patch.color;
    }
    if (patch.collapsed !== undefined) {
      group.collapsed = patch.collapsed;
    }
    await write(folderId, groups);
  });
}

/** 解散：成員留在原地，只是不再是一個群組 */
export async function dissolveGroup(folderId: string, groupId: string): Promise<void> {
  return exclusive(async () => {
    await write(
      folderId,
      (await read(folderId)).filter((group) => group.id !== groupId),
    );
  });
}

/** 成員照畫面（原生）順序排好 */
async function membersInOrder(folderId: string, group: StoredGroup): Promise<string[]> {
  const memberSet = new Set(group.members);
  return (await browser.bookmarks.getChildren(folderId))
    .filter((node) => memberSet.has(node.id))
    .map((node) => node.id);
}

/** 轉成資料夾：在群組（第一個成員）的位置建子資料夾，照順序搬進去。回傳新資料夾 id */
export async function groupToFolder(folderId: string, groupId: string): Promise<string> {
  return exclusive(async () => {
    const groups = await read(folderId);
    const group = groups.find((item) => item.id === groupId);
    if (group === undefined) {
      throw new Error(t('group_not_found'));
    }
    const members = await membersInOrder(folderId, group);
    const first = members[0];
    const [firstNode] = first === undefined ? [] : await browser.bookmarks.get(first);
    const folder = await browser.bookmarks.create({
      parentId: folderId,
      ...(firstNode?.index === undefined ? {} : { index: firstNode.index }),
      title: group.name === '' ? t('group_untitled') : group.name,
    });
    for (const id of members) {
      await browser.bookmarks.move(id, { parentId: folder.id });
    }
    await write(
      folderId,
      groups.filter((item) => item.id !== groupId),
    );
    return folder.id;
  });
}

/**
 * 攤平成群組：子資料夾裡的書籤搬回上層（放在子資料夾原本的位置），原地成為一個同名群組，
 * 子資料夾刪掉。子資料夾裡還有資料夾時拒絕 —— 那些資料夾沒有地方放，攤平就會變成
 * 「書籤搬出來了、資料夾留在一個看不見的殼裡」。
 */
export async function flattenFolder(subfolderId: string): Promise<void> {
  return exclusive(async () => {
    const [sub] = await browser.bookmarks.get(subfolderId);
    if (sub?.parentId === undefined) {
      throw new Error(t('group_not_found'));
    }
    const children = await browser.bookmarks.getChildren(subfolderId);
    if (children.some((child) => child.type === 'folder' || (child.type === undefined && child.url === undefined))) {
      throw new Error(t('group_flatten_has_folders'));
    }
    const parentId = sub.parentId;
    const links = children.filter((child) => child.url !== undefined).map((child) => child.id);
    for (const id of links) {
      // 每次都放在子資料夾的前面：照原本的順序依序排在它原本的位置
      await reorderBookmarks([id], parentId, subfolderId);
    }
    await browser.bookmarks.removeTree(subfolderId);

    const groups = without(await read(parentId), new Set(links));
    let group = groups.find((item) => sub.title.trim() !== '' && sameName(item.name, sub.title));
    if (group === undefined) {
      group = { id: crypto.randomUUID(), name: sub.title.trim(), color: nextColor(groups), collapsed: false, members: [] };
      groups.push(group);
    }
    group.members.push(...links);
    await write(parentId, groups);
  });
}

/**
 * 拖群組標題：整組一起搬。同一個資料夾就是排序；換資料夾時到了那裡若有同名群組就併進去，
 * 沒有就照原樣（名稱、顏色、收合）建一個。
 */
export async function moveGroup(
  fromFolderId: string,
  groupId: string,
  toFolderId: string,
  beforeId: string | null,
): Promise<void> {
  return exclusive(async () => {
    const source = await read(fromFolderId);
    const group = source.find((item) => item.id === groupId);
    if (group === undefined) {
      throw new Error(t('group_not_found'));
    }
    const members = await membersInOrder(fromFolderId, group);
    await reorderBookmarks(members, toFolderId, beforeId);
    if (toFolderId === fromFolderId) {
      return;
    }
    await write(
      fromFolderId,
      source.filter((item) => item.id !== groupId),
    );
    const target = without(await read(toFolderId), new Set(members));
    const same = target.find((item) => group.name !== '' && sameName(item.name, group.name));
    if (same === undefined) {
      target.push({ ...group, members });
    } else {
      same.members.push(...members);
    }
    await write(toFolderId, target);
  });
}

/**
 * 書籤被刪或被搬到別的資料夾：離開原本資料夾的群組；資料夾被刪就整份刪掉。
 * 在群組操作自己的搬動之後才會跑到（同一個佇列），所以不會蓋掉那些操作寫的東西。
 */
export function startGroupWatcher(): void {
  browser.bookmarks.onRemoved.addListener((id, info) => {
    void exclusive(async () => {
      await browser.storage.local.remove(keyOf(id));
      const groups = await read(info.parentId);
      if (groups.some((group) => group.members.includes(id))) {
        await write(info.parentId, without(groups, new Set([id])));
      }
    });
  });
  browser.bookmarks.onMoved.addListener((id, info) => {
    if (info.parentId === info.oldParentId) {
      return;
    }
    void exclusive(async () => {
      const groups = await read(info.oldParentId);
      if (groups.some((group) => group.members.includes(id))) {
        await write(info.oldParentId, without(groups, new Set([id])));
      }
    });
  });
}
