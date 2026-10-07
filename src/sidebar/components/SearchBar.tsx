import { useEffect, useRef } from 'react';
import { t } from '@/shared/i18n';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  /** 隱私空間用另一句（「搜尋隱私書籤…」），否則分不出在搜哪一邊 */
  placeholder?: string | undefined;
}

/**
 * 搜尋框。
 *
 * 這裡曾經兼任隱私空間的入口（直接把主密碼打進來按 Enter），現在只負責搜尋 ——
 * 主密碼改走觸發字串跳出的獨立密碼畫面。差別在於密碼再也不會進入搜尋狀態，
 * 也不會明文顯示在這個框裡。
 *
 * 觸發字串的比對由呼叫端在 onChange 裡做：那裡才拿得到設定值。
 */
export function SearchBar({ value, onChange, placeholder }: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // 側邊欄開啟時直接可以打字搜尋
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="search">
      <input
        ref={inputRef}
        type="search"
        className="search__input"
        placeholder={placeholder ?? t('search_placeholder')}
        title={t('search_tag_hint')}
        value={value}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onChange('');
          }
        }}
        aria-label={placeholder ?? t('search_label')}
      />
    </div>
  );
}
