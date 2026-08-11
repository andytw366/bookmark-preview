/**
 * 取字串的唯一入口。文案本體在 `public/_locales/<語系>/messages.json`。
 *
 * 為什麼要包一層，而不是各處直接呼叫 `browser.i18n.getMessage`：
 *
 * 1. **純函式層在 vitest 裡沒有 `browser`。** `crypto/` 與 `shared/` 幾個模組刻意
 *    不碰任何擴充套件 API，才能直接單元測試（`vault-merge`、`vault-backup`、
 *    `keyring` 都是這樣測的）。直接呼叫 `browser.i18n` 會讓它們一 import 就爆。
 *    這裡查不到就退回鍵名，於是那些測試改成比對**鍵名**而不是文案 —— 那也比較穩：
 *    之後修一個字的措辭不會再弄壞測試。
 * 2. **查不到時回鍵名，不回空字串。** `getMessage` 對未知的鍵回傳 `''`，在畫面上
 *    就是一片空白 —— 看起來像「本來就沒有訊息」而不是像壞了。回鍵名的話
 *    `vault_locked` 會直接出現在按鈕上，一眼就知道是漏翻或打錯鍵。
 * 3. 單複數要自己處理，見 `tn()`。
 *
 * 鍵名沒有型別可查（JSON 不進 bundle），改用 `tests/i18n.test.ts` 靜態掃過整個
 * `src/`：每個用到的鍵兩個語系都要有、兩邊的 placeholder 數目要一致、沒有人用的
 * 鍵要刪掉。打錯字會在測試裡失敗，而不是在使用者的畫面上。
 */

interface I18nApi {
  getMessage(key: string, substitutions?: string[]): string;
}

function api(): I18nApi | undefined {
  return (globalThis as { browser?: { i18n?: I18nApi } }).browser?.i18n;
}

function lookup(key: string, subs: readonly (string | number)[]): string {
  const values = subs.map((value) => String(value));
  const text = api()?.getMessage(key, values);
  if (text !== undefined && text !== '') {
    return text;
  }
  // 退路帶著代入的值一起回：少了它，`t('backup_filename', stamp)` 在 Node 裡會退化成
  // 一個不含日期的常數，於是「檔名要帶日期」那條測試比對的是一句與日期無關的字串 ——
  // 把日期算錯也照樣通過。查不到鍵時在畫面上也是同樣的道理：看得到參數才查得下去。
  return values.length === 0 ? key : `${key}(${values.join(', ')})`;
}

/**
 * 取一條字串。`subs` 依序填進 messages.json 裡的 `$1`…`$9`。
 *
 * 用具名 placeholder（`"content": "$1"`）而不是把 `$1` 直接寫在句子裡：中英語序
 * 常常不同，翻譯的人看到 `$COUNT$` 才知道那個位置放的是什麼。
 */
export function t(key: string, ...subs: (string | number)[]): string {
  return lookup(key, subs);
}

/**
 * 帶數量的字串。messages.json 要有 `<key>_one` 與 `<key>_other` 兩條，數量固定是 `$1`。
 *
 * `browser.i18n` 沒有任何單複數支援，而英文的「1 bookmark」／「2 bookmarks」沒辦法
 * 用同一句話混過去（「1 bookmark(s)」是能避免的醜）。中文兩條寫一樣的內容就好 ——
 * 多出來的那份重複，換的是英文那邊不必將就。
 *
 * **一句話裡有兩個數量時不要硬塞進一個 `tn()`**（「已移入 3 個書籤與 1 個資料夾」）：
 * 各自 `tn()` 成詞組，再用 `t()` 把詞組組起來，語序才留給各語言自己決定。
 */
export function tn(key: string, count: number, ...subs: (string | number)[]): string {
  return lookup(`${key}_${count === 1 ? 'one' : 'other'}`, [count, ...subs]);
}
