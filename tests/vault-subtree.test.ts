import { describe, expect, it } from 'vitest';
import type { PrivateBookmark, PrivateFolder } from '@/shared/types';
import { planFolderExport, planFolderImport, type NativeNode } from '@/shared/vault-subtree';

/**
 * 整個資料夾進出隱私空間的轉換規則。
 *
 * 這些測試存在的理由：做錯的代價是**整棵子樹的書籤消失**。單筆移入做錯只損失
 * 一筆，資料夾移入做錯就是幾百筆 —— 所以每一條規則都要有測試釘住，而不是
 * 靠讀程式碼推論。
 */

/** 可預測的 id，方便斷言巢狀關係。 */
function counter(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `f${String(n)}`;
  };
}

const TREE: NativeNode = {
  id: 'n1',
  title: '研究',
  children: [
    { id: 'n2', title: 'arXiv', url: 'https://arxiv.org/' },
    {
      id: 'n3',
      title: '子分類',
      children: [
        { id: 'n4', title: 'IEEE', url: 'https://ieeexplore.ieee.org/' },
        { id: 'n5', title: '空資料夾', children: [] },
      ],
    },
    { id: 'n6', title: '最近的書籤', url: 'place:type=6&sort=14' },
    { id: 'n7', title: '', type: 'separator' },
  ],
};

describe('planFolderImport', () => {
  it('根節點自己也會變成一個資料夾，掛在指定的父底下', () => {
    const plan = planFolderImport(TREE, null, counter());
    expect(plan.folders[0]).toEqual({ id: 'f1', name: '研究', parentId: null });
  });

  it('保留層級：子資料夾的 parentId 指向父資料夾', () => {
    const plan = planFolderImport(TREE, null, counter());
    const sub = plan.folders.find((folder) => folder.name === '子分類');
    expect(sub?.parentId).toBe('f1');
    const empty = plan.folders.find((folder) => folder.name === '空資料夾');
    expect(empty?.parentId).toBe(sub?.id);
  });

  it('空的子資料夾照建（否則結構會被壓平）', () => {
    const plan = planFolderImport(TREE, null, counter());
    expect(plan.folders.map((folder) => folder.name)).toContain('空資料夾');
  });

  it('書籤掛在正確的資料夾底下', () => {
    const plan = planFolderImport(TREE, null, counter());
    const arxiv = plan.bookmarks.find((item) => item.title === 'arXiv');
    const ieee = plan.bookmarks.find((item) => item.title === 'IEEE');
    expect(arxiv?.folderId).toBe('f1');
    expect(ieee?.folderId).not.toBe('f1');
    expect(plan.folders.some((folder) => folder.id === ieee?.folderId)).toBe(true);
  });

  it('place: 智慧書籤與分隔線略過並計數', () => {
    const plan = planFolderImport(TREE, null, counter());
    expect(plan.bookmarks.map((item) => item.url)).not.toContain('place:type=6&sort=14');
    expect(plan.skipped).toBe(2);
  });

  it('父一定排在子之前（呼叫端照順序建立就不會找不到父）', () => {
    const plan = planFolderImport(TREE, null, counter());
    const seen = new Set<string>();
    for (const folder of plan.folders) {
      if (folder.parentId !== null && plan.folders.some((item) => item.id === folder.parentId)) {
        expect(seen.has(folder.parentId)).toBe(true);
      }
      seen.add(folder.id);
    }
  });

  it('可以掛進既有的隱私資料夾底下', () => {
    const plan = planFolderImport(TREE, 'existing', counter());
    expect(plan.folders[0]?.parentId).toBe('existing');
  });

  it('環狀／過深的結構不會讓遞迴爆掉', () => {
    // 造一棵 40 層的樹，超過深度上限
    let deep: NativeNode = { id: 'leaf', title: 'leaf', children: [] };
    for (let i = 0; i < 40; i += 1) {
      deep = { id: `d${String(i)}`, title: `d${String(i)}`, children: [deep] };
    }
    const plan = planFolderImport(deep, null, counter());
    expect(plan.folders.length).toBeLessThanOrEqual(21);
  });
});

const FOLDERS: PrivateFolder[] = [
  { id: 'a', name: '工作', parentId: null, updatedAt: 1 },
  { id: 'b', name: '子分類', parentId: 'a', updatedAt: 1 },
  { id: 'c', name: '空的', parentId: 'b', updatedAt: 1 },
  { id: 'd', name: '別的', parentId: null, updatedAt: 1 },
  { id: 'gone', name: '已刪除', parentId: 'a', updatedAt: 1, deleted: true },
];

const BOOKMARKS: PrivateBookmark[] = [
  { id: 'x', url: 'https://a.example/', title: 'A', folderId: 'a', createdAt: 1, updatedAt: 1 },
  { id: 'y', url: 'https://b.example/', title: 'B', folderId: 'b', createdAt: 1, updatedAt: 1 },
  { id: 'z', url: 'https://d.example/', title: 'D', folderId: 'd', createdAt: 1, updatedAt: 1 },
  {
    id: 'dead',
    url: 'https://dead.example/',
    title: '墓碑',
    folderId: 'a',
    createdAt: 1,
    updatedAt: 1,
    deleted: true,
  },
];

describe('planFolderExport', () => {
  it('只取那一棵子樹，不碰兄弟資料夾', () => {
    const plan = planFolderExport(FOLDERS, BOOKMARKS, 'a');
    expect(plan.folders.map((folder) => folder.id)).toEqual(['a', 'b', 'c']);
    expect(plan.bookmarks.map((item) => item.id)).toEqual(['x', 'y']);
  });

  it('父在子之前', () => {
    const plan = planFolderExport(FOLDERS, BOOKMARKS, 'a');
    expect(plan.folders.findIndex((folder) => folder.id === 'a')).toBeLessThan(
      plan.folders.findIndex((folder) => folder.id === 'b'),
    );
  });

  it('空的子資料夾照建', () => {
    const plan = planFolderExport(FOLDERS, BOOKMARKS, 'a');
    expect(plan.folders.map((folder) => folder.id)).toContain('c');
  });

  it('墓碑一律不算（資料夾與書籤都是）', () => {
    const plan = planFolderExport(FOLDERS, BOOKMARKS, 'a');
    expect(plan.folders.map((folder) => folder.id)).not.toContain('gone');
    expect(plan.bookmarks.map((item) => item.id)).not.toContain('dead');
  });

  it('找不到根資料夾時回傳空計畫，而不是丟例外', () => {
    expect(planFolderExport(FOLDERS, BOOKMARKS, 'nope')).toEqual({ folders: [], bookmarks: [] });
  });

  it('環狀 parentId 不會讓遞迴爆掉', () => {
    const cyclic: PrivateFolder[] = [
      { id: 'p', name: 'p', parentId: 'q', updatedAt: 1 },
      { id: 'q', name: 'q', parentId: 'p', updatedAt: 1 },
    ];
    const plan = planFolderExport(cyclic, [], 'p');
    expect(plan.folders.length).toBeLessThanOrEqual(21);
  });
});
