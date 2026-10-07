import { describe, expect, it } from 'vitest';
import { applyOp, buildBoard, listNudge, searchBoard, type Board } from '@/shared/board';
import { tagMatches, tagQuery } from '@/shared/groups';
import type { BookmarkNode, PrivateBookmark, PrivateFolder } from '@/shared/types';
import { emptyLayout, withFolderOrder, withGroup, withGroupOf } from '@/shared/vault-layout';
import { searchTree } from '@/sidebar/lib/tree';
import { searchVault, vaultTagHits } from '@/sidebar/lib/vault-tree';

/**
 * 第 4 期：搜尋找得到資料夾、`#名稱` 找群組成員，以及側邊欄（一欄）的鍵盤挪動。
 */

const link = (id: string, title: string, url = `https://${id}.example/`): BookmarkNode => ({
  kind: 'link',
  id,
  parentId: null,
  title,
  url,
  dateAdded: null,
  source: 'native',
});
const folder = (id: string, title: string, children: BookmarkNode[]): BookmarkNode => ({
  kind: 'folder',
  id,
  parentId: null,
  title,
  children,
  dateAdded: null,
  source: 'native',
});

describe('tag 搜尋的字', () => {
  it('#名稱 才是 tag 搜尋，只有 # 不算', () => {
    expect(tagQuery('#Work')).toBe('Work');
    expect(tagQuery('  # work ')).toBe('work');
    expect(tagQuery('#')).toBeNull();
    expect(tagQuery('work')).toBeNull();
    expect(tagQuery('a#b')).toBeNull();
  });

  it('不分大小寫、開頭相符；沒名字的群組永遠不合', () => {
    expect(tagMatches('Work stuff', 'work')).toBe(true);
    expect(tagMatches(' WORK ', 'wo')).toBe(true);
    expect(tagMatches('Homework', 'work')).toBe(false);
    expect(tagMatches('', 'a')).toBe(false);
  });
});

describe('書籤搜尋', () => {
  const roots = [
    folder('m', 'Menu', [
      folder('f1', 'Recipes', [link('a', 'Pasta'), link('b', 'Soup')]),
      link('c', 'recipes blog'),
    ]),
  ];

  it('找得到資料夾，資料夾排在書籤前面', () => {
    const outcome = searchTree(roots, 'recipe');
    expect(outcome.nodes.map((node) => node.id)).toEqual(['f1', 'c']);
  });

  it('#名稱 只列出 tagged 裡的書籤，照樹的順序；資料夾不列', () => {
    const outcome = searchTree(roots, '#x', [{ folderId: 'm', group: { id: 'g', name: 'x', color: 0 }, members: ['c', 'a'] }]);
    expect(outcome.nodes.map((node) => node.id)).toEqual(['a', 'c']);
  });

  it('群組資料還沒問到（null）時 tag 搜尋是空的，不會退回一般搜尋', () => {
    expect(searchTree(roots, '#pasta', null).nodes).toEqual([]);
  });
});

describe('隱私空間搜尋', () => {
  const folders: PrivateFolder[] = [{ id: 'F', name: 'Travel', parentId: null, updatedAt: 1 }];
  const record = (id: string, title: string, folderId: string | null): PrivateBookmark => ({
    id,
    url: `https://${id}.example/`,
    title,
    folderId,
    createdAt: 1,
    updatedAt: 1,
  });
  const bookmarks = [record('r1', 'Hotel', 'F'), record('r2', 'Flight', 'F'), record('r3', 'Travel news', null)];

  it('一般的字找資料夾名稱與書籤，資料夾在前', () => {
    const hits = searchVault(folders, bookmarks, emptyLayout(), 'travel');
    expect(hits.map((hit) => (hit.kind === 'folder' ? hit.folder.id : hit.record.id))).toEqual(['F', 'r3']);
  });

  it('#名稱 找名稱相符的群組成員，照版面順序；書籤被搬離群組的資料夾就不算', () => {
    let layout = withFolderOrder(emptyLayout(), 'F', ['r2', 'r1'], new Set(['r1', 'r2']), 1);
    layout = withGroup(layout, 'g', { folderId: 'F', name: 'Trip', color: 0 }, 1);
    layout = withGroupOf(layout, ['r1', 'r2', 'r3'], 'g', 1);
    const hits = searchVault(folders, bookmarks, layout, '#trip');
    // r3 記著 g，但它在最上層、g 在 F：成員資格不成立
    expect(hits.map((hit) => (hit.kind === 'bookmark' ? hit.record.id : hit.folder.id))).toEqual(['r2', 'r1']);
    // 搜尋結果裡要畫出來的群組：成員只算還在群組那個資料夾裡的
    expect(vaultTagHits(bookmarks, layout, '#trip').map((hit) => [hit.group.id, hit.members.sort()])).toEqual([
      ['g', ['r1', 'r2']],
    ]);
    expect(vaultTagHits(bookmarks, layout, 'trip')).toEqual([]);
  });
});

describe('tag 搜尋結果的版面', () => {
  it('每個群組是一段（被別的結果隔開也聚起來），不在群組裡的照順序', () => {
    const board = searchBoard(
      ['a', 'x', 'b', 'c'],
      [
        { folderId: 'F', group: { id: 'g', name: 'w', color: 0 }, members: ['a', 'b'] },
        { folderId: 'H', group: { id: 'h', name: 'work', color: 1 }, members: ['c'] },
      ],
      1,
    );
    expect(board.grid.cells).toEqual(['a', 'b', 'x', 'c']);
    expect(board.memberOf.get('b')).toBe('g');
    expect(board.memberOf.get('c')).toBe('h');
    expect(board.memberOf.has('x')).toBe(false);
  });
});

describe('側邊欄的鍵盤挪動（一欄）', () => {
  const board = (cells: string, groups: Record<string, string> = {}): Board =>
    buildBoard({
      stored: null,
      fixed: false,
      children: cells.split(''),
      autoColumns: 1,
      groups: [...new Set(Object.values(groups))].map((id, color) => ({ id, name: id, color })),
      groupOf: (id) => groups[id] ?? null,
    });
  const ctx = { isLink: () => true, newId: () => 'n' };
  const step = (b: Board, id: string, dir: -1 | 1): Board => {
    const op = listNudge(b, id, dir);
    if (op === null) {
      throw new Error('blocked');
    }
    return applyOp(b, op, ctx);
  };
  const order = (b: Board) => b.grid.cells.join('');

  it('往下、往上各挪一格；到頭了是 null', () => {
    expect(order(step(board('abc'), 'a', 1))).toBe('bac');
    expect(order(step(board('abc'), 'c', -1))).toBe('acb');
    expect(listNudge(board('abc'), 'a', -1)).toBeNull();
    expect(listNudge(board('abc'), 'c', 1)).toBeNull();
  });

  it('挪到成員旁邊就加入，挪出最後一個成員就離開', () => {
    const joined = step(board('xab', { a: 'G', b: 'G' }), 'x', 1);
    expect(order(joined)).toBe('axb');
    expect(joined.memberOf.get('x')).toBe('G');
    const left = step(board('aby', { a: 'G', b: 'G' }), 'b', 1);
    expect(order(left)).toBe('ayb');
    expect(left.memberOf.has('b')).toBe(false);
  });
});
