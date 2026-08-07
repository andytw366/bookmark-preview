import { useCallback, useEffect, useState } from 'react';
import { request } from '@/shared/messages';
import type { Settings } from '@/shared/types';
import { onSettingsChanged } from '@/storage/settings';

interface SettingsState {
  settings: Settings | null;
  update: (patch: Partial<Settings>) => void;
}

export function useSettings(): SettingsState {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    void request('settings/get', undefined).then(setSettings, () => {
      // 讀不到就維持 null，UI 顯示載入中而不是崩掉
    });
    // 設定可能從其他擴充套件頁面改動，直接聽 storage 變化比輪詢乾淨
    return onSettingsChanged(setSettings);
  }, []);

  const update = useCallback((patch: Partial<Settings>) => {
    void request('settings/patch', patch).then(setSettings, () => undefined);
  }, []);

  return { settings, update };
}
