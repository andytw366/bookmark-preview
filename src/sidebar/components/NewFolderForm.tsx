import { useState } from 'react';
import { Button } from '../../ui/Button';
import { t } from '@/shared/i18n';

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
        className="input"
        value={name}
        autoFocus
        placeholder={t('folder_name_placeholder')}
        aria-label={t('folder_name_label')}
        onChange={(event) => {
          setName(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onCancel();
          }
        }}
      />
      <Button type="submit" variant="primary" disabled={name.trim() === ''}>
        {t('action_create')}
      </Button>
      <Button variant="ghost" onClick={onCancel}>
        {t('action_cancel')}
      </Button>
      {hint === undefined ? null : <p className="newfolder__hint">{hint}</p>}
    </form>
  );
}
