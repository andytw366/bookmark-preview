import { useEffect, useRef } from 'react';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
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
export function SearchBar({ value, onChange }: SearchBarProps) {
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
        placeholder="搜尋書籤…"
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
        aria-label="搜尋書籤"
      />
    </div>
  );
}
