import { normalizeUrl } from '@/shared/url';

/**
 * 「這個書籤網址最後會停在哪裡」的對照表。
 *
 * 為什麼要記下來：轉址得靠一個請求才知道，而那個答案幾乎不會變。不記的話，
 * 每次造訪同一個站台都要重新問一次 —— 那是把「一個書籤問一次」變成
 * 「每逛一頁問一次」。
 *
 * **只放原生書籤。** 隱私書籤的網址不准寫進 `storage.local`：藏起來的網址從那裡
 * 漏出去，與縮圖沒加密是同一級的問題（與 `recordCapture` 同一條規則，
 * 見 `tests/vault-thumb-privacy.test.ts`）。隱私空間那條路要解析轉址時，
 * 結果只留在記憶體裡、用完就丟。
 */
const KEY = 'redirectTargets';

/**
 * 上限。
 *
 * 超過就從最早寫入的開始丟（物件的鍵是插入順序）。這張表是純快取，丟掉只是下次
 * 再問一次，所以不需要 LRU 那種精確度。
 */
const MAX_ENTRIES = 200;

type Stored = Record<string, string>;

async function read(): Promise<Stored> {
  const stored = await browser.storage.local.get(KEY);
  return (stored[KEY] as Stored | undefined) ?? {};
}

export async function loadRedirects(): Promise<Map<string, string>> {
  return new Map(Object.entries(await read()));
}

/**
 * 記下解析結果。
 *
 * **沒有轉址（最後停在自己）也要記。** 不記的話那個書籤每次都會被重新解析一次,
 * 而「沒轉址」正是最常見的答案。
 */
export async function rememberRedirect(bookmarkUrl: string, finalUrl: string): Promise<void> {
  const stored = await read();
  stored[normalizeUrl(bookmarkUrl)] = normalizeUrl(finalUrl);
  const keys = Object.keys(stored);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) {
    delete stored[key];
  }
  await browser.storage.local.set({ [KEY]: stored });
}

/** 這個書籤解析過了沒有（不論結果是什麼）。 */
export async function isResolved(bookmarkUrl: string): Promise<boolean> {
  return normalizeUrl(bookmarkUrl) in (await read());
}
