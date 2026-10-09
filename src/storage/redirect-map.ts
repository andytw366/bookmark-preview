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

/**
 * 把這些網址的紀錄拿掉（書籤移進隱私空間時），回傳被拿掉的那幾筆的最終網址 ——
 * 呼叫端要拿那些網址去清其他地方（分頁停在的是最終網址，不是書籤網址）。
 *
 * **鍵或值是這些網址都算。** 值也要比：另一個書籤（例如已經刪掉的 `https://x/`）轉址到的
 * 正好是這個隱私書籤的網址（`https://x/zh-TW`）時，那筆紀錄同樣把隱私網址明文留著 ——
 * 2026-10-09 實機就是這樣留下 MDN 的。
 */
export async function forgetRedirects(urls: readonly string[]): Promise<string[]> {
  if (urls.length === 0) {
    return [];
  }
  const gone = new Set(urls.map(normalizeUrl));
  const stored = await read();
  const finals: string[] = [];
  let changed = false;
  for (const [key, target] of Object.entries(stored)) {
    if (gone.has(key) || gone.has(target)) {
      finals.push(target);
      delete stored[key];
      changed = true;
    }
  }
  if (changed) {
    await browser.storage.local.set({ [KEY]: stored });
  }
  return finals;
}
