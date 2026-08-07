import { useCallback, useEffect, useState } from 'react';

const ORIGINS = { origins: ['<all_urls>'] };

interface HostPermissionState {
  /** null 代表尚未查詢完成 */
  granted: boolean | null;
  request: () => void;
}

/**
 * host 權限是選用的，安裝時不索取。
 *
 * permissions.request() 必須在使用者操作的處理器中呼叫，所以請求動作
 * 留在側邊欄（擴充套件頁面）而不是背景頁 —— 背景頁沒有使用者手勢。
 */
export function useHostPermission(): HostPermissionState {
  const [granted, setGranted] = useState<boolean | null>(null);

  useEffect(() => {
    const refresh = (): void => {
      void browser.permissions.contains(ORIGINS).then(setGranted, () => {
        setGranted(false);
      });
    };
    refresh();
    browser.permissions.onAdded.addListener(refresh);
    browser.permissions.onRemoved.addListener(refresh);
    return () => {
      browser.permissions.onAdded.removeListener(refresh);
      browser.permissions.onRemoved.removeListener(refresh);
    };
  }, []);

  const ask = useCallback(() => {
    void browser.permissions.request(ORIGINS).then(setGranted, () => undefined);
  }, []);

  return { granted, request: ask };
}
