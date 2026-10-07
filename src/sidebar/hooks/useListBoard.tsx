import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { displayColors, labelCell, listNudge, membersInOrder, type Board, type GridOp } from '@/shared/board';
import { GROUP_COLORS, type GroupInfo } from '@/shared/groups';
import { GroupMenu } from '../../gallery/GroupMenu';
import { MergeMenu } from '../components/MergeMenu';
import type { ReorderActions } from '../components/ReorderItems';
import { TagPrompt, type TagActions } from '../components/TagItems';
import { t } from '@/shared/i18n';

/**
 * 側邊欄清單的群組與排序（第 4 期）。書籤與隱私空間各掛一份，差別只在 `space` 送哪一種訊息。
 *
 * 側邊欄只有一欄，所以版面就是順序本身：群組是順序上連續的幾列（`board.ts` 保證），
 * 畫成左側一條色條、第一列上面一個名稱標籤。拖拽與鍵盤都送 `board.ts` 的同一套操作，
 * 規則（放進框裡才加入、非成員不能插進群組中間）與全頁瀏覽完全一樣。
 *
 * 選單（群組標籤的 ⋯、設定 tag、疊卡片的合併選單）也收在這裡，`popovers` 交給呼叫端畫。
 */
export interface ListBoardSpace {
  /** 這個資料夾的版面（`buildBoard`，`autoColumns: 1`） */
  board: Board;
  /** 能不能排、能不能建群組（搜尋結果與 Firefox 的永久資料夾那一層不能） */
  enabled: boolean;
  apply: (op: GridOp) => void;
  toFolder: (groupId: string) => void;
  mergeFolder: (targetId: string, ids: string[], name: string) => void;
  /** 只有書籤能進群組 */
  isLink: (id: string) => boolean;
  /** 一次動了好幾張（多選整批拖）之後退出多選，與「移動到…」一致 */
  onBatch: () => void;
  /**
   * `#名稱` 的搜尋結果：點標籤不開選單（結果跨資料夾，選單的操作沒有對象），改成跳到那個群組所在的資料夾。
   */
  onTag?: ((groupId: string) => void) | undefined;
}

/** 一列在群組裡的位置：決定色條要不要接上一列／下一列 */
export interface RowGroup {
  group: GroupInfo;
  first: boolean;
  last: boolean;
}

export function useListBoard(space: ListBoardSpace) {
  const { board } = space;
  const [groupMenu, setGroupMenu] = useState<{ group: GroupInfo; x: number; y: number } | null>(null);
  const [tagPrompt, setTagPrompt] = useState<{ ids: string[]; current: string; x: number; y: number } | null>(null);
  const [merge, setMerge] = useState<{ targetId: string; ids: string[]; x: number; y: number } | null>(null);

  // 相鄰（上下接著）的群組不同色；只有一欄，`board.grid` 就是畫面的擺法
  const colors = displayColors(board, { columns: 1, cells: board.grid.cells }, GROUP_COLORS);
  const shownGroup = (group: GroupInfo): GroupInfo => ({ ...group, color: colors.get(group.id) ?? group.color });

  const rowGroup = (id: string): RowGroup | null => {
    const groupId = board.memberOf.get(id);
    const group = groupId === undefined ? undefined : board.groups.find((item) => item.id === groupId);
    if (group === undefined) {
      return null;
    }
    const at = board.grid.cells.indexOf(id);
    return {
      group: shownGroup(group),
      first: board.memberOf.get(board.grid.cells[at - 1] ?? '') !== groupId,
      last: board.memberOf.get(board.grid.cells[at + 1] ?? '') !== groupId,
    };
  };

  /*
   * 鍵盤挪動之後焦點要跟著那一列走。列換了位置，React 搬 DOM 時焦點可能掉，
   * 所以記下要聚焦的元素，等它真的換到別的位置之後再聚焦。
   */
  const refocusRef = useRef<{ selector: string; from: number; until: number } | null>(null);
  useEffect(() => {
    const pending = refocusRef.current;
    if (pending === null) {
      return;
    }
    if (Date.now() > pending.until) {
      refocusRef.current = null;
      return;
    }
    const element = document.querySelector<HTMLElement>(pending.selector);
    const cell = element?.closest<HTMLElement>('[data-cell]');
    if (element !== null && cell !== null && cell !== undefined && Number(cell.dataset.cell) !== pending.from) {
      refocusRef.current = null;
      element.focus();
    }
  });

  const rowSelector = (id: string): string => {
    const key = CSS.escape(id);
    return `[data-drag-id="${key}"] [data-nav]`;
  };

  /** 一列往上（-1）／往下（1）挪一個位置。null = 到頭了、或這個畫面不能排 */
  const nudger = (id: string, step: -1 | 1): (() => void) | null => {
    const op = space.enabled ? listNudge(board, id, step) : null;
    if (op === null) {
      return null;
    }
    return () => {
      refocusRef.current = { selector: rowSelector(id), from: board.grid.cells.indexOf(id), until: Date.now() + 3000 };
      space.apply(op);
    };
  };

  /** 整組往上／往下跨一列（相鄰的是另一個群組就跨過那整段） */
  const groupNudger = (groupId: string, step: -1 | 1): (() => void) | null => {
    const at = labelCell(board, groupId);
    const last = at + membersInOrder(board, groupId).length - 1;
    if (!space.enabled || at === -1 || (step < 0 ? at <= 0 : last >= board.grid.cells.length - 1)) {
      return null;
    }
    return () => {
      refocusRef.current = {
        selector: `[data-group-label="${CSS.escape(groupId)}"]`,
        from: at,
        until: Date.now() + 3000,
      };
      space.apply({ kind: 'nudge-group', groupId, direction: step < 0 ? 'left' : 'right' });
    };
  };

  const reorder = (id: string): ReorderActions | undefined =>
    space.enabled ? { earlier: nudger(id, -1), later: nudger(id, 1), vertical: true } : undefined;

  /** 右鍵選單的「設定 tag…」「移出群組」。「攤平成群組」由呼叫端補（兩個空間的資料夾不一樣） */
  const tagActions = (id: string): Omit<TagActions, 'onFlatten'> | undefined => {
    if (!space.enabled) {
      return undefined;
    }
    const groupId = board.memberOf.get(id) ?? null;
    const name = board.groups.find((group) => group.id === groupId)?.name ?? '';
    return {
      onSetTag: (x, y) => {
        setTagPrompt({ ids: [id], current: name, x, y });
      },
      onLeave:
        groupId === null
          ? null
          : () => {
              space.apply({ kind: 'untag', ids: [id] });
            },
    };
  };

  /** Ctrl+Shift+↑/↓ 挪動焦點所在的列或群組；其餘的鍵交給方向鍵巡覽 */
  const onKeyDown =
    (fallback: (event: ReactKeyboardEvent<HTMLDivElement>) => void) =>
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : null;
      if (event.ctrlKey && event.shiftKey && step !== null) {
        event.preventDefault();
        const target = event.target as HTMLElement;
        const label = target.closest<HTMLElement>('[data-group-label]')?.dataset.groupLabel;
        if (label !== undefined) {
          groupNudger(label, step)?.();
          return;
        }
        const id = target.closest<HTMLElement>('[data-drag-id]')?.dataset.dragId;
        if (id !== undefined) {
          nudger(id, step)?.();
        }
        return;
      }
      fallback(event);
    };

  /** 拖拽（`useGridDrag`）放開時的那一半。只有一欄，畫面上第幾列 = 順序上第幾個 */
  const dragHandlers = {
    onPlace: (ids: string[], _cell: number, aimed: string | null, after: boolean) => {
      if (ids.length > 1) {
        space.onBatch();
      }
      const at = aimed === null ? board.grid.cells.length : board.grid.cells.indexOf(aimed) + (after ? 1 : 0);
      space.apply({ kind: 'place', ids, at, aimed });
    },
    onMoveGroup: (groupId: string, _cell: number, aimed: string | null, after: boolean) => {
      const at = aimed === null ? board.grid.cells.length : board.grid.cells.indexOf(aimed) + (after ? 1 : 0);
      space.apply({ kind: 'move-group', groupId, at });
    },
    onMerge: (targetId: string, ids: string[], x: number, y: number) => {
      const at = board.grid.cells.indexOf(targetId);
      if (board.memberOf.has(targetId) && at !== -1) {
        // 疊到已在群組裡的那一列 = 接在它後面、加入那個群組，不跳選單
        if (ids.length > 1) {
          space.onBatch();
        }
        space.apply({ kind: 'place', ids, at: at + 1, aimed: targetId });
        return;
      }
      setMerge({ targetId, ids, x, y });
    },
  };

  // 合併選單貼著那一列；捲動之後那一列已經不在原處（甚至被虛擬滾動卸載了），就關掉。
  // 側邊欄捲的是 `.body` 不是視窗，所以在 capture 階段聽所有的捲動
  useEffect(() => {
    if (merge === null) {
      return;
    }
    const close = (): void => {
      setMerge(null);
    };
    document.addEventListener('scroll', close, { capture: true, passive: true });
    return () => {
      document.removeEventListener('scroll', close, { capture: true });
    };
  }, [merge]);

  const popovers: ReactNode = (
    <>
      {groupMenu !== null ? (
        <GroupMenu
          group={groupMenu.group}
          x={groupMenu.x}
          y={groupMenu.y}
          reorder={{
            earlier: groupNudger(groupMenu.group.id, -1),
            later: groupNudger(groupMenu.group.id, 1),
            vertical: true,
          }}
          onClose={() => {
            setGroupMenu(null);
          }}
          onRename={(name) => {
            space.apply({ kind: 'group-update', groupId: groupMenu.group.id, name });
          }}
          onColor={(color) => {
            space.apply({ kind: 'group-update', groupId: groupMenu.group.id, color });
          }}
          onDissolve={() => {
            space.apply({ kind: 'dissolve', groupId: groupMenu.group.id });
          }}
          onToFolder={() => {
            space.toFolder(groupMenu.group.id);
          }}
        />
      ) : null}

      {tagPrompt !== null ? (
        <TagPrompt
          x={tagPrompt.x}
          y={tagPrompt.y}
          current={tagPrompt.current}
          names={board.groups.map((group) => group.name).filter((name) => name !== '')}
          onClose={() => {
            setTagPrompt(null);
          }}
          onSubmit={(name) => {
            space.apply({ kind: 'tag', ids: tagPrompt.ids, name });
          }}
        />
      ) : null}

      {merge !== null ? (
        <MergeMenu
          x={merge.x}
          y={merge.y}
          onClose={() => {
            setMerge(null);
          }}
          onCreateGroup={
            // 群組是「一段書籤」：拖的或被疊上去的是資料夾時只能建資料夾
            [merge.targetId, ...merge.ids].every(space.isLink)
              ? () => {
                  if (merge.ids.length > 1) {
                    space.onBatch();
                  }
                  space.apply({ kind: 'merge-group', targetId: merge.targetId, ids: merge.ids });
                }
              : undefined
          }
          onCreateFolder={(name) => {
            if (merge.ids.length > 1) {
              space.onBatch();
            }
            space.mergeFolder(merge.targetId, merge.ids, name);
          }}
        />
      ) : null}
    </>
  );

  return {
    /** 畫面的順序（群組聚成連續的幾列）。清單照這個排 */
    order: board.grid.cells,
    rowGroup,
    openGroupMenu: (group: GroupInfo, x: number, y: number) => {
      if (space.onTag !== undefined) {
        space.onTag(group.id);
        return;
      }
      setGroupMenu({ group, x, y });
    },
    /** 標籤的提示：搜尋結果裡點它是跳到資料夾 */
    tagHint: space.onTag === undefined ? undefined : t('group_tag_search_hint'),
    reorder,
    tagActions,
    onKeyDown,
    dragHandlers,
    popovers,
  };
}

export type ListBoard = ReturnType<typeof useListBoard>;
