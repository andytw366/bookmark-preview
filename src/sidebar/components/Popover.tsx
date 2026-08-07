import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

interface PopoverProps {
  /** 觸發點的視窗座標（滑鼠位置，或觸發按鈕的邊界） */
  x: number;
  y: number;
  className?: string;
  role?: string;
  onClose: () => void;
  children: ReactNode;
}

const MARGIN = 6;
/** 量到實際寬度之前的預設值，用於首次繪製的水平夾限 */
const ASSUMED_WIDTH = 190;

/** 選單裡真的能收到焦點的東西（停用的項目要跳過，否則方向鍵會卡在上面）。 */
const FOCUSABLE = [
  'button:not(:disabled)',
  'a[href]',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function focusablesIn(box: HTMLElement): HTMLElement[] {
  return [...box.querySelectorAll<HTMLElement>(FOCUSABLE)];
}

/**
 * 開啟時焦點要落在哪裡：預設第一個項目，但內容可以用 `data-autofocus` 指定。
 *
 * 為什麼不用 React 的 `autoFocus`：Popover 換內容時**不會重新掛載**（例如右鍵
 * 選單切成刪除確認，兩邊都是 `<Popover>`），React 依位置比對後會沿用原本那些
 * `<button>` 的 DOM 節點 —— 節點不是新掛載的，`autoFocus` 就不會生效。實測到的
 * 後果是刪除確認一打開，焦點落在「確定刪除」上，連按兩次 Enter 就刪掉了。
 */
function defaultFocusIn(box: HTMLElement): HTMLElement | undefined {
  return box.querySelector<HTMLElement>('[data-autofocus]') ?? focusablesIn(box)[0];
}

/**
 * 貼著觸發點浮動的容器，點外面或按 Escape 就關掉。
 *
 * 抽成共用元件是因為有三處需要一模一樣的行為（右鍵選單、隱私空間的右鍵選單、
 * 移入確認），而其中最容易出錯的是邊界夾限 —— 側邊欄又窄又矮，任何一處漏掉
 * 就會出現「選單被切掉」或「按鈕在畫面外點不到」。
 *
 * 焦點管理也放在這裡，理由相同：17 個叫用點各自處理必然會漏。開啟時焦點進到
 * 第一個項目、Tab 困在選單內、關閉時還給觸發元素 —— 少了最後這一項，用鍵盤
 * 開了選單再按 Escape，焦點會掉到 `<body>`，等於被丟回清單開頭。
 */
export function Popover({ x, y, className, role, onClose, children }: PopoverProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState({
    left: Math.max(MARGIN, Math.min(x, window.innerWidth - ASSUMED_WIDTH)),
    top: y,
  });

  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      if (boxRef.current !== null && !boxRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  /*
   * 關閉時把焦點還給打開選單的那個元素。
   *
   * 必須在焦點被移進選單**之前**記下來，所以這個 effect 排在下面那個前面 ——
   * 同一次 commit 裡的 effect 依宣告順序執行。
   *
   * 元素可能已經不在文件裡了（例如選單做的就是「刪除這一列」），那時候不做事
   * 比硬還原好：`.focus()` 對已卸載的元素無效，而 `<body>` 也不是有意義的落點。
   */
  useEffect(() => {
    const opener = document.activeElement;
    return () => {
      if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) {
        opener.focus();
      }
    };
  }, []);

  /*
   * 把焦點移進選單。
   *
   * 依賴 children 是為了涵蓋「內容換掉但 Popover 沒有重新掛載」那條路（例如
   * 右鍵選單切成刪除確認：兩邊都是 <Popover>，React 會沿用同一個元素，
   * 剛剛被按下的那個項目卻已經消失，焦點會掉到 <body>）。
   *
   * 焦點已經在選單裡就不動它 —— 否則使用者每按一次方向鍵都會被拉回第一項，
   * 而重新命名表單的 autoFocus 也會被搶走。
   */
  useEffect(() => {
    const box = boxRef.current;
    if (box === null || box.contains(document.activeElement)) {
      return;
    }
    defaultFocusIn(box)?.focus();
  }, [children]);

  /**
   * 選單內的鍵盤操作：Tab 困在裡面、方向鍵與 Home/End 在項目間移動。
   *
   * 焦點在輸入框裡時只保留 Tab —— 方向鍵與 Home/End 要留給游標。
   */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const box = boxRef.current;
    if (box === null) {
      return;
    }
    const items = focusablesIn(box);
    if (items.length === 0) {
      return;
    }
    const active = document.activeElement;
    const at = active instanceof HTMLElement ? items.indexOf(active) : -1;

    if (event.key === 'Tab') {
      event.preventDefault();
      const step = event.shiftKey ? -1 : 1;
      // at === -1（焦點還沒進來）時 -1 + 1 = 0，正好落在第一項
      const next = (at + step + items.length) % items.length;
      items[next]?.focus();
      return;
    }

    if (active instanceof HTMLElement && active.matches('input, textarea, select')) {
      return;
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        items[at < 0 ? 0 : (at + 1) % items.length]?.focus();
        return;
      case 'ArrowUp':
        event.preventDefault();
        items[at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length]?.focus();
        return;
      case 'Home':
        event.preventDefault();
        items[0]?.focus();
        return;
      case 'End':
        event.preventDefault();
        items[items.length - 1]?.focus();
        return;
      default:
        return;
    }
  };

  // 尺寸只有掛載後才知道。移入確認這類較高的內容從點擊位置往下畫常常會被切掉，
  // 量完之後往上翻。依賴 children 是為了讓內容切換（例如選單換成資料夾清單）
  // 重新計算；計算是純函式，收斂後 setPlacement 給相同值 React 會自動停下。
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box === null) {
      return;
    }
    const { offsetWidth: width, offsetHeight: height } = box;
    const left = Math.max(MARGIN, Math.min(x, window.innerWidth - width - MARGIN));
    const overflowsBottom = y + height + MARGIN > window.innerHeight;
    const top = overflowsBottom ? Math.max(MARGIN, y - height) : y;
    setPlacement((current) =>
      current.left === left && current.top === top ? current : { left, top },
    );
  }, [x, y, children]);

  return (
    <div
      ref={boxRef}
      className={className ?? 'rowmenu'}
      role={role}
      onKeyDown={onKeyDown}
      style={{ left: `${String(placement.left)}px`, top: `${String(placement.top)}px` }}
    >
      {children}
    </div>
  );
}
