import { Fragment, type ReactNode } from 'react';

/**
 * 一句話裡有幾個字要粗體或等寬時用這個。訊息裡用 `*` 夾住要粗體的、用反引號夾住
 * 要等寬的：
 *
 *     "建立後會給你一串*救援金鑰*，那是唯一的備用鑰匙，請抄下來。"
 *     "不想等就到 `about:preferences#sync` 按「立即同步」。"
 *
 * 為什麼不直接在 JSX 裡寫 `{前半}<strong>{那個詞}</strong>{後半}`：那會把一句話切成
 * 三條互不相干的訊息，而**順序被程式碼寫死了**。中文的「建立後會給你一串救援金鑰」
 * 與英文的「you'll be given a recovery key」裡，那個詞的位置不一樣；切成三段之後
 * 翻譯的人只能硬把英文塞回中文的語序。整句留在同一條訊息裡，標記的位置才是
 * 翻譯的人說了算。
 *
 * **粗體裡面可以再放等寬**（`*Firefox for Android 完全不同步 `storage.sync`*`），反過來不行。
 * 這一條是實機看出來的：原本完全不處理巢狀，那句話的反引號就原樣印在畫面上 ——
 * 型別檢查與測試都不會抱怨，因為輸出仍然是一個合法的字串。
 *
 * 不跳脫。這裡要的是「一句話裡強調幾個字」，不是 Markdown —— 真的要顯示一個星號時，
 * 改寫那句話比為它加一套跳脫規則便宜。標記沒有成對時（少打一個）不會丟例外，
 * 那一段原樣顯示：一句漏了粗體比整個畫面炸掉好。
 */
const TOKEN = /(\*[^*]+\*|`[^`]+`)/g;
const CODE = /(`[^`]+`)/g;

function wrapped(part: string, mark: string): boolean {
  return part.length > 2 && part.startsWith(mark) && part.endsWith(mark);
}

/** 粗體裡面的等寬。只有這一層，所以不會遞迴下去。 */
function inner(text: string): ReactNode[] {
  return text.split(CODE).map((part, index) =>
    wrapped(part, '`') ? <code key={index}>{part.slice(1, -1)}</code> : <Fragment key={index}>{part}</Fragment>,
  );
}

export function Rich({ text }: { text: string }): ReactNode {
  return text.split(TOKEN).map((part, index) => {
    if (part === '') {
      return null;
    }
    if (wrapped(part, '*')) {
      return <strong key={index}>{inner(part.slice(1, -1))}</strong>;
    }
    if (wrapped(part, '`')) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}
