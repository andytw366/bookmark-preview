import { t } from './i18n';

/**
 * 把 `<html lang>` 與分頁標題換成目前語系的值。三個進入點（側邊欄、全頁瀏覽、設定頁）
 * 各在掛載前呼叫一次。
 *
 * 為什麼不寫在 HTML 裡：`index.html` 是靜態檔，`browser.i18n` 碰不到它，而
 * `__MSG_x__` 只有 manifest 認得。MV3 的 CSP 也禁止 inline script，沒辦法在
 * `<head>` 裡先改掉。
 *
 * **三個 `index.html` 的 `<html>` 刻意不帶 `lang`。** 原本寫 `lang="en"`（對齊
 * `default_locale`），結果中文介面每次打開全頁瀏覽都會跳出 Firefox 的翻譯提示、
 * 而且說「原始語言：英文」—— Firefox 在 JS 改掉它之前就把那個屬性讀走了。
 * 完全不寫的話 Firefox 改用內容判斷，那是對的，接著這裡再補上正確的值。
 *
 * 收的是**已經取好的字串**（`applyDocumentLocale(t('page_title_options'))`）而不是鍵名。
 * 鍵名一定要出現在 `t(` 裡面 —— `tests/i18n.test.ts` 是掃原始碼找 `t('…')` 的，鍵名一旦
 * 變成別的函式的參數就掃不到，於是「漏翻」與「沒人用的鍵」兩道檢查同時對它失效。
 *
 * `lang` 不是裝飾：它決定瀏覽器挑哪一套字型與斷行規則，也決定螢幕閱讀器用哪種語言
 * 唸出來。留著 `zh-Hant` 會讓英文介面被當成中文唸。
 */
export function applyDocumentLocale(title: string): void {
  document.documentElement.lang = t('html_lang');
  document.title = title;
}
