import type { PrivateFolder } from '@/shared/types';
import { Popover } from './Popover';

interface VaultFolderPickerProps {
  x: number;
  y: number;
  folders: PrivateFolder[];
  heading?: string;
  /**
   * 停用的目標（例如書籤目前所在的資料夾）。`null` 代表「目前就在最上層」。
   *
   * **省略與傳 `null` 是兩件事**：省略＝沒有「目前位置」這回事（多選時每一筆
   * 各自在不同地方），此時每個目標都要能選。這裡曾經把預設值寫成 `null`，
   * 於是多選的「移動到…」永遠停用「最上層」—— 東西搬得進資料夾卻搬不回來。
   */
  disabledId?: string | null | undefined;
  /**
   * 這些資料夾**與它們的子孫**都不是合法目標。
   *
   * 搬移中的資料夾要放進來：搬進自己的子樹會造成環狀 `parentId`。背景頁的
   * `isWithin` 會擋，但那時使用者只會拿到一筆沒有解釋的失敗計數 ——
   * 不合法的目標一開始就不該出現在清單上。
   */
  excludeIds?: readonly string[] | undefined;
  onPick: (folderId: string | null) => void;
  onClose: () => void;
}

interface Choice {
  id: string;
  name: string;
  depth: number;
}

/** 攤平成有縮排深度的清單。 */
function flatten(
  folders: PrivateFolder[],
  parentId: string | null,
  depth: number,
  excludeIds: readonly string[],
): Choice[] {
  const out: Choice[] = [];
  for (const folder of folders.filter((item) => item.parentId === parentId)) {
    // 被排除的資料夾連同整棵子樹一起跳過（不遞迴進去）
    if (excludeIds.includes(folder.id)) {
      continue;
    }
    out.push({ id: folder.id, name: folder.name, depth });
    // 深度上限防資料損毀造成的環狀 parentId 讓遞迴爆掉
    if (depth < 16) {
      out.push(...flatten(folders, folder.id, depth + 1, excludeIds));
    }
  }
  return out;
}

/**
 * 選一個**隱私空間內**的資料夾。
 *
 * 與 `FolderPicker` 分開而不是加參數：那個取的是原生書籤資料夾（走
 * `bookmarks/folders`），這裡的資料夾是隱私空間自己的一套（`PrivateFolder`，
 * 只存在解密後的記憶體裡）。兩者的 id 空間不同，混用會搬到錯的地方。
 */
export function VaultFolderPicker({
  x,
  y,
  folders,
  heading = '移動到…',
  disabledId,
  excludeIds = [],
  onPick,
  onClose,
}: VaultFolderPickerProps) {
  return (
    <Popover x={x} y={y} className="rowmenu rowmenu--list" onClose={onClose}>
      <p className="rowmenu__heading">{heading}</p>
      <button
        type="button"
        className="rowmenu__item"
        disabled={disabledId === null}
        onClick={() => {
          onPick(null);
        }}
      >
        最上層
      </button>
      {flatten(folders, null, 0, excludeIds).map((choice) => (
        <button
          key={choice.id}
          type="button"
          className="rowmenu__item"
          disabled={choice.id === disabledId}
          onClick={() => {
            onPick(choice.id);
          }}
        >
          {' '.repeat(choice.depth * 2)}
          {choice.name || '（未命名）'}
        </button>
      ))}
    </Popover>
  );
}
