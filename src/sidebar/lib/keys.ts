import type { MouseEvent as ReactMouseEvent } from 'react';

/** 選單要貼在哪裡（視窗座標）。 */
export interface MenuAnchor {
  x: number;
  y: number;
}

/** 選單貼在這個元素的左下角 —— 與滑鼠版「貼著游標」在視覺上是同一件事。 */
export function anchorOf(element: Element): MenuAnchor {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
}

/**
 * 從 `contextmenu` 事件取出選單座標。
 *
 * 鍵盤（選單鍵、Shift+F10）叫出來的 `contextmenu` 沒有可用的游標位置 ——
 * 照抄 `clientX/clientY` 會把選單畫到畫面角落。`detail === 0` 是「不是真的按了
 * 滑鼠鍵」的訊號，這時改用元素本身的位置；座標為 (0, 0) 是第二道保險。
 */
export function menuAnchorFrom(event: ReactMouseEvent<HTMLElement>): MenuAnchor {
  const keyboard = event.detail === 0 || (event.clientX === 0 && event.clientY === 0);
  return keyboard ? anchorOf(event.currentTarget) : { x: event.clientX, y: event.clientY };
}

/**
 * 一列（或一張卡片）的右鍵選單入口，滑鼠與鍵盤共用。
 *
 * 做成一組 props 而不是各處自己寫，是因為漏掉這一段不會有任何徵兆 ——
 * 滑鼠測起來一切正常，只有拔掉滑鼠才看得出那一列打不開選單。
 *
 * **只掛在 `contextmenu` 上，不要另外攔 keydown。** 選單鍵與 Shift+F10 本來就會
 * 產生 `contextmenu`，而那個事件是唯一擋得掉原生選單的地方：實測 Firefox 153
 * 對 Shift+F10 的 keydown 呼叫 `preventDefault()` **沒有用**，原生選單照樣跳出來，
 * 於是自己畫的選單與原生選單疊在一起。走 `contextmenu` 這一條就只有一個選單，
 * 而且滑鼠與鍵盤的行為一定一致。
 */
export function contextMenuHandlers(open: (anchor: MenuAnchor) => void) {
  return {
    onContextMenu: (event: ReactMouseEvent<HTMLElement>): void => {
      event.preventDefault();
      open(menuAnchorFrom(event));
    },
  };
}
