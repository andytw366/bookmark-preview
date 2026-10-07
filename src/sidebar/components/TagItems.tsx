import { useId, useState } from 'react';
import { Popover } from './Popover';
import { t } from '@/shared/i18n';

/**
 * 右鍵選單裡與群組（＝ tag）有關的項目。
 *
 * `onSetTag` 只負責打開輸入框（由呼叫端畫，選單本身會關掉）；`onLeave` 是 null 代表
 * 這張卡片不在任何群組裡，「移出群組」就不列出來。
 */
export interface TagActions {
  onSetTag: (x: number, y: number) => void;
  onLeave: (() => void) | null;
  /** 資料夾卡片：攤平成群組。null = 不提供（裡面還有資料夾） */
  onFlatten?: (() => void) | null | undefined;
}

export function TagItems({
  tag,
  x,
  y,
  isFolder,
  onClose,
}: {
  tag: TagActions;
  x: number;
  y: number;
  isFolder: boolean;
  onClose: () => void;
}) {
  if (isFolder) {
    return tag.onFlatten === undefined ? null : (
      <button
        type="button"
        role="menuitem"
        className="rowmenu__item"
        disabled={tag.onFlatten === null}
        title={tag.onFlatten === null ? t('group_flatten_has_folders') : t('group_flatten_hint')}
        onClick={() => {
          tag.onFlatten?.();
          onClose();
        }}
      >
        {t('group_flatten')}
      </button>
    );
  }
  return (
    <>
      <button
        type="button"
        role="menuitem"
        className="rowmenu__item"
        onClick={() => {
          onClose();
          tag.onSetTag(x, y);
        }}
      >
        {t('tag_set')}
      </button>
      {tag.onLeave !== null ? (
        <button
          type="button"
          role="menuitem"
          className="rowmenu__item"
          onClick={() => {
            tag.onLeave?.();
            onClose();
          }}
        >
          {t('tag_leave')}
        </button>
      ) : null}
    </>
  );
}

/**
 * 「設定 tag…」的輸入框。自動完成這個資料夾已有的群組名稱 —— 打一樣的名字就是加入那一組
 * （不分大小寫），打新的名字就建一組。一個書籤只有一個 tag，所以這是「換到」而不是「加上」。
 */
export function TagPrompt({
  x,
  y,
  current,
  names,
  onClose,
  onSubmit,
}: {
  x: number;
  y: number;
  current: string;
  names: readonly string[];
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(current);
  const listId = useId();
  return (
    <Popover x={x} y={y} onClose={onClose}>
      <form
        className="rowmenu__form"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = name.trim();
          if (trimmed !== '') {
            onSubmit(trimmed);
          }
          onClose();
        }}
      >
        <input
          className="rowmenu__input"
          value={name}
          list={listId}
          data-autofocus=""
          placeholder={t('tag_placeholder')}
          aria-label={t('tag_label')}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <datalist id={listId}>
          {names.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
        <button type="submit" className="chip chip--primary">
          {t('action_save')}
        </button>
      </form>
    </Popover>
  );
}
