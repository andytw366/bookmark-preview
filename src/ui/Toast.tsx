import { useEffect, useRef, type ReactNode } from 'react';
import { IconButton } from './Button';
import { t } from '@/shared/i18n';

interface ToastProps {
  children: ReactNode;
  /** 右邊的連結（例如「查看缺的」） */
  action?: { label: string; onClick: () => void } | undefined;
  /** 幾毫秒後自己消失。滑鼠停在上面或焦點在裡面時暫停計時 */
  timeout: number;
  onClose: () => void;
}

/**
 * 浮在工具列上方的提示：深底白字，幾秒後自己消失，不佔清單或工具列的位置。
 *
 * 滑鼠移上去或焦點進來就停止倒數 —— 不然「查看缺的」還沒點到提示就先不見了。
 */
export function Toast({ children, action, timeout, onClose }: ToastProps) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const stop = (): void => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  const start = (): void => {
    stop();
    timer.current = setTimeout(() => {
      closeRef.current();
    }, timeout);
  };

  useEffect(() => {
    start();
    return stop;
    // 內容換了（新的一則）就重新計時
  }, [children, timeout]);

  return (
    <div className="toast" role="status" onMouseEnter={stop} onMouseLeave={start} onFocus={stop} onBlur={start}>
      <span className="toast__text">{children}</span>
      {action === undefined ? null : (
        <button type="button" className="link" onClick={action.onClick}>
          {action.label}
        </button>
      )}
      <IconButton icon="close" label={t('action_close')} onClick={onClose} />
    </div>
  );
}
