/**
 * 原生書籤的拖拽排序與「兩張疊在一起 → 建立資料夾」。
 *
 * 錨點用「放在哪一筆的前面」而不是 index：畫面上看不到分隔線與 `place:` 這類被濾掉的
 * 項目，畫面的第 n 張不等於原生的第 n 個，只有 id 兩邊都認得。
 *
 * **`bookmarks.move` 的 index 在 Firefox 是「移除後」的最終位置**（2026-10-07 實測，
 * Firefox 153：index 0 的書籤 `move` 到 index 2，結果落在原本 index 2 那一筆的**後面**）。
 * Chrome 是「移除前」的位置，兩者在同一個資料夾裡往後移時差一格。
 *
 * 所以第一次照 Firefox 的語意算；讀回來若不在錨點正前方（日後語意變了、或期間有別的
 * 變動）就再搬一次 —— 第二次一定是往前移，往前移時兩種語意沒有差別。
 */

/** 不在這一批裡、而且在錨點（含）之後的第一個兄弟；找不到就是 null（放到最後） */
async function resolveAnchor(
  parentId: string,
  beforeId: string | null,
  moving: ReadonlySet<string>,
): Promise<string | null> {
  if (beforeId === null || !moving.has(beforeId)) {
    return beforeId;
  }
  const siblings = await browser.bookmarks.getChildren(parentId);
  const start = siblings.findIndex((node) => node.id === beforeId);
  return siblings.slice(start).find((node) => !moving.has(node.id))?.id ?? null;
}

async function indexOf(id: string): Promise<{ parentId: string | undefined; index: number | undefined }> {
  const [node] = await browser.bookmarks.get(id);
  return { parentId: node?.parentId, index: node?.index };
}

/** 把 `id` 放到 `parentId` 裡 `beforeId` 的正前方（null = 最後） */
export async function placeBefore(id: string, parentId: string, beforeId: string | null): Promise<void> {
  if (beforeId === null) {
    await browser.bookmarks.move(id, { parentId });
    return;
  }
  const [self, anchor] = await Promise.all([indexOf(id), indexOf(beforeId)]);
  // 同一個資料夾裡往後移：自己被拿走之後錨點會往前挪一格
  const index =
    anchor.index !== undefined &&
    self.parentId === parentId &&
    self.index !== undefined &&
    self.index < anchor.index
      ? anchor.index - 1
      : anchor.index;
  await browser.bookmarks.move(id, { parentId, index });
  const [after, anchorAfter] = await Promise.all([indexOf(id), indexOf(beforeId)]);
  if (
    after.index !== undefined &&
    anchorAfter.index !== undefined &&
    after.index !== anchorAfter.index - 1
  ) {
    await browser.bookmarks.move(id, { parentId, index: anchorAfter.index });
  }
}

/**
 * 把 `ids`（照傳進來的順序）放到 `parentId` 裡 `beforeId` 的前面。逐筆計數，
 * 其中一筆已被刪掉不該讓整批停下（與 `bookmarks/move-many` 一致）。
 */
export async function reorderBookmarks(
  ids: readonly string[],
  parentId: string,
  beforeId: string | null,
): Promise<{ moved: number; failed: number }> {
  const anchor = await resolveAnchor(parentId, beforeId, new Set(ids));
  let moved = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      await placeBefore(id, parentId, anchor);
      moved += 1;
    } catch {
      failed += 1;
    }
  }
  return { moved, failed };
}

/**
 * 在 `targetId` 的位置建一個資料夾，把它與 `ids` 依序搬進去。回傳新資料夾的 id。
 */
export async function mergeIntoNewFolder(
  targetId: string,
  ids: readonly string[],
  title: string,
): Promise<string> {
  const [target] = await browser.bookmarks.get(targetId);
  if (target?.parentId === undefined) {
    throw new Error(`bookmark ${targetId} not found`);
  }
  const folder = await browser.bookmarks.create({
    parentId: target.parentId,
    index: target.index,
    title,
  });
  for (const id of [targetId, ...ids.filter((member) => member !== targetId)]) {
    await browser.bookmarks.move(id, { parentId: folder.id });
  }
  return folder.id;
}
