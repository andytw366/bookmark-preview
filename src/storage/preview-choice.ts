import type { PreviewChoice } from '@/shared/types';
import { urlKey } from '@/shared/url';

/**
 * 一般書籤「預覽要用什麼」的手動記錄：`{ [urlKey]: 'icon' | 'page' | 'manual' }`。
 *
 * - `icon`／`page`：列選單的「改用網站圖示／改用頁面預覽」。救入口規則判錯的（一層的個人頁）
 *   與抓不到的（`mail.google.com/mail/u/0/` 三層路徑）。**優先於設定與入口規則。**
 * - `manual`：右鍵「設為這個書籤的預覽圖」指定過。自動擷取不再覆蓋它 —— 以前那張圖存成
 *   `source: 'cover'`，被當成自動產生的，過了 `thumbMaxAgeDays` 再造訪就被蓋掉。
 *   使用者明確按「重新抓預覽圖」時清掉（`refreshThumbnail`）。
 *
 * 要記住，不然下次自動擷取又會照規則蓋回去。
 *
 * **鍵是雜湊、不含明文網址**，與縮圖鍵同性質。即使如此，書籤移進隱私空間時仍要清掉
 * （`vault-traces.ts`）—— 雜湊對得上「某個猜得到的網址」，那筆選擇改記在加密的 payload 裡。
 * 隱私書籤**絕不**寫進這裡。
 */
const KEY = 'previewChoices';

type ChoiceMap = Record<string, PreviewChoice>;

async function readAll(): Promise<ChoiceMap> {
  const stored = await browser.storage.local.get(KEY);
  const value = stored[KEY] as ChoiceMap | undefined;
  return typeof value === 'object' && value !== null ? value : {};
}

async function writeAll(map: ChoiceMap): Promise<void> {
  await browser.storage.local.set({ [KEY]: map });
}

export async function getPreviewChoice(url: string): Promise<PreviewChoice | undefined> {
  return (await readAll())[await urlKey(url)];
}

/** 一次讀全部，給補抓那種逐筆查的迴圈用（鍵是 `urlKey`） */
export async function getPreviewChoices(): Promise<ChoiceMap> {
  return readAll();
}

/** null 代表清掉，回到設定與入口規則 */
export async function setPreviewChoice(url: string, choice: PreviewChoice | null): Promise<void> {
  const map = await readAll();
  const key = await urlKey(url);
  if (choice === null) {
    if (!(key in map)) {
      return;
    }
    delete map[key];
  } else {
    map[key] = choice;
  }
  await writeAll(map);
}

export async function forgetPreviewChoices(urls: readonly string[]): Promise<void> {
  const map = await readAll();
  let changed = false;
  for (const url of urls) {
    const key = await urlKey(url);
    if (key in map) {
      delete map[key];
      changed = true;
    }
  }
  if (changed) {
    await writeAll(map);
  }
}

/** 書籤被刪掉之後留下的記錄。與孤兒縮圖一起整理（`maintenance.ts`） */
export async function prunePreviewChoices(keep: ReadonlySet<string>): Promise<void> {
  const map = await readAll();
  const kept = Object.fromEntries(Object.entries(map).filter(([key]) => keep.has(key)));
  if (Object.keys(kept).length !== Object.keys(map).length) {
    await writeAll(kept);
  }
}
