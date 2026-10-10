import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { IconButton } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { t } from '@/shared/i18n';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  /** 隱私空間用另一句（「搜尋隱私書籤」），否則分不出在搜哪一邊 */
  placeholder?: string | undefined;
  /** 全頁瀏覽用大一號（32px），並在右側提示快捷鍵 */
  size?: 'md' | 'lg';
  shortcut?: string | undefined;
  /** 開啟時直接可以打字（側邊欄要；全頁瀏覽不搶焦點，方向鍵要留給格子） */
  autoFocus?: boolean;
  className?: string | undefined;
}

/**
 * 搜尋框：放大鏡、輸入、有字時的清除鈕。
 *
 * 這裡曾經兼任隱私空間的入口（直接把主密碼打進來按 Enter），現在只負責搜尋 ——
 * 主密碼改走觸發字串跳出的獨立密碼畫面。差別在於密碼再也不會進入搜尋狀態，
 * 也不會明文顯示在這個框裡。
 *
 * 觸發字串的比對由呼叫端在 onChange 裡做：那裡才拿得到設定值。
 */
export const SearchBar = forwardRef<HTMLInputElement, SearchBarProps>(function SearchBar(
  { value, onChange, placeholder, size = 'md', shortcut, autoFocus = true, className },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inputRef.current as HTMLInputElement);

  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus();
    }
  }, [autoFocus]);

  const label = placeholder ?? t('search_label');
  const classes = ['search', size === 'lg' ? 'search--lg' : '', className ?? ''].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      <Icon name="search" />
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
          if (event.key === 'Escape' && value !== '') {
            event.stopPropagation();
            onChange('');
          }
        }}
        aria-label={label}
      />
      {value !== '' ? (
        <IconButton
          icon="close"
          label={t('search_clear')}
          onClick={() => {
            onChange('');
            inputRef.current?.focus();
          }}
        />
      ) : shortcut !== undefined ? (
        <span className="kbd" aria-hidden="true">
          {shortcut}
        </span>
      ) : null}
    </div>
  );
});
