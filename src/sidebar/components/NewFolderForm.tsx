import { useState } from 'react';

interface NewFolderFormProps {
  /** 說明會建在哪裡，例如「會建立在『其他書籤』」 */
  hint?: string | undefined;
  onCreate: (name: string) => void;
  onCancel: () => void;
}

/**
 * 新增資料夾的行內輸入框。
 *
 * 側邊欄、全頁瀏覽、隱私空間都用同一份 —— 三處各寫一次的話，
 * 「Escape 取消」「空白名稱不送出」這類細節遲早會有一處漏掉。
 */
export function NewFolderForm({ hint, onCreate, onCancel }: NewFolderFormProps) {
  const [name, setName] = useState('');

  return (
    <form
      className="newfolder"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = name.trim();
        if (trimmed === '') {
          onCancel();
          return;
        }
        onCreate(trimmed);
      }}
    >
      <input
        className="rowmenu__input"
        value={name}
        autoFocus
        placeholder="資料夾名稱"
        aria-label="新資料夾名稱"
        onChange={(event) => {
          setName(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onCancel();
          }
        }}
      />
      <button type="submit" className="chip chip--primary" disabled={name.trim() === ''}>
        建立
      </button>
      <button type="button" className="chip" onClick={onCancel}>
        取消
      </button>
      {hint === undefined ? null : <p className="newfolder__hint">{hint}</p>}
    </form>
  );
}
