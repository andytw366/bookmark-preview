import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { t, tn } from '../src/shared/i18n';

/**
 * 靜態檢查：`_locales/` 與程式碼不會各自漂走。
 *
 * 鍵名沒有型別可查（messages.json 刻意不進 bundle，見 `src/shared/i18n.ts`），
 * 打錯一個字的症狀是**畫面上出現鍵名**而不是編譯失敗 —— 而那要有人真的走到那條
 * 路徑才看得到。所以改用掃原始碼的方式，把三種會靜靜壞掉的情況釘住：
 *
 * 1. 用了一個不存在的鍵（打錯字、或搬到一半忘了加進 messages.json）
 * 2. 中文加了新的一條，英文忘了跟上（英文使用者會看到鍵名）
 * 3. 兩邊的 placeholder 數目不同（少一個 → 變數不見；多一個 → `$2$` 原樣顯示）
 *
 * 另外反過來查沒有人用的鍵：文案改寫之後，舊的那條會一直留著，翻譯的人不知道
 * 可以跳過它。
 */
/**
 * `default_locale`。每個用到的鍵都必須在這一份裡，因為它是所有退路的終點。
 *
 * 是 `en` 而不是 `zh_TW`（介面的原稿語言）—— 退路要挑**最多人讀得懂的**那一份。
 * 日後收到一份翻一半的日文或德文時，沒翻到的鍵會退回這裡；對那些使用者來說，
 * 英文至少猜得出來，中文等於整段消失。正體中文使用者不受影響：`zh_TW` 是補齊的，
 * 永遠走不到退路。
 */
const DEFAULT_LOCALE = 'en';

/**
 * 我們自己維護、承諾補齊的語系。這兩份少一條就是缺陷。
 *
 * 其他語系（外部貢獻進來的）**允許翻一半** —— Firefox 對缺的鍵會自動退回
 * `default_locale`，所以半份翻譯是能用的，要求 100% 只會把想幫忙的人擋在門外。
 * 它們仍然要通過「不能有多出來的鍵」與「placeholder 要一致」兩關。
 */
const MAINTAINED = [DEFAULT_LOCALE, 'zh_TW'];

/** 語系清單從磁碟上讀，不寫死 —— 加一個語系只要放一個資料夾進去，這裡不用改。 */
const LOCALES = readdirSync('public/_locales', { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

interface Message {
  message: string;
  description?: string;
  placeholders?: Record<string, { content: string; example?: string }>;
}

function load(locale: string): Record<string, Message> {
  return JSON.parse(readFileSync(join('public/_locales', locale, 'messages.json'), 'utf8')) as Record<
    string,
    Message
  >;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** 程式碼與 manifest 實際用到的鍵。`tn()` 一次用掉 `_one` 與 `_other` 兩條。 */
function usedKeys(): Set<string> {
  const used = new Set<string>();
  for (const file of sourceFiles('src')) {
    // i18n.ts 自己的 JSDoc 舉過例子，別把那些當成真的用法
    if (file.endsWith('shared/i18n.ts')) {
      continue;
    }
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\bt\(\s*'([a-z0-9_]+)'/g)) {
      used.add(match[1] ?? '');
    }
    for (const match of text.matchAll(/\btn\(\s*'([a-z0-9_]+)'/g)) {
      used.add(`${match[1] ?? ''}_one`);
      used.add(`${match[1] ?? ''}_other`);
    }
  }
  for (const match of readFileSync('public/manifest.json', 'utf8').matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) {
    used.add(match[1] ?? '');
  }
  return used;
}

/**
 * 一條訊息裡出現的 `$NAME$`，去重。placeholders 宣告與句子本身都要對得起來。
 *
 * 去重是必要的：同一個 placeholder 可以在一句話裡出現兩次（`vault_secret_changed_elsewhere`
 * 的「$SECRET$已在另一台裝置更改…請改用新的$SECRET$」），但宣告只會有一條。
 */
function placeholdersOf(entry: Message): string[] {
  return [
    ...new Set([...entry.message.matchAll(/\$([A-Za-z0-9_]+)\$/g)].map((match) => (match[1] ?? '').toLowerCase())),
  ].sort();
}

describe('_locales', () => {
  const catalogs = new Map(LOCALES.map((locale) => [locale, load(locale)]));
  const base = catalogs.get(DEFAULT_LOCALE) as Record<string, Message>;
  const catalogOf = (locale: string): Record<string, Message> =>
    catalogs.get(locale) as Record<string, Message>;

  it(`${DEFAULT_LOCALE} 與 manifest 存在，而且是我們維護的那幾份`, () => {
    // 這一條只是讓下面幾條在「資料夾被改名」時給出看得懂的失敗，而不是一堆 undefined
    expect(LOCALES).toEqual(expect.arrayContaining(MAINTAINED));
  });

  it('程式碼與 manifest 用到的鍵，default_locale 都有', () => {
    const missing = [...usedKeys()].filter((key) => !(key in base)).sort();
    expect(missing).toEqual([]);
  });

  it('沒有沒人用的鍵', () => {
    const used = usedKeys();
    expect(Object.keys(base).filter((key) => !used.has(key)).sort()).toEqual([]);
  });

  it('我們維護的語系都補齊了', () => {
    for (const locale of MAINTAINED) {
      const missing = Object.keys(base)
        .filter((key) => !(key in catalogOf(locale)))
        .sort();
      expect(missing, `${locale} 少了這幾條`).toEqual([]);
    }
  });

  it('沒有語系帶著 default_locale 沒有的鍵', () => {
    for (const locale of LOCALES) {
      const extra = Object.keys(catalogOf(locale))
        .filter((key) => !(key in base))
        .sort();
      expect(extra, `${locale} 多了這幾條（${DEFAULT_LOCALE} 沒有）`).toEqual([]);
    }
  });

  it('每個語系的 placeholder 都與 default_locale 一致，而且句子裡用到的都有宣告', () => {
    for (const locale of LOCALES) {
      for (const [key, entry] of Object.entries(catalogOf(locale))) {
        const expected = placeholdersOf(base[key] as Message);
        expect(placeholdersOf(entry), `${locale} / ${key}`).toEqual(expected);
        expect(Object.keys(entry.placeholders ?? {}).sort(), `${locale} / ${key} 的宣告`).toEqual(expected);
      }
    }
  });

  it('每一條訊息都有內容', () => {
    for (const locale of LOCALES) {
      for (const [key, entry] of Object.entries(catalogOf(locale))) {
        expect(entry.message.trim(), `${locale} / ${key}`).not.toBe('');
      }
    }
  });
});

describe('取字串的包裝', () => {
  /**
   * 沒有 `browser` 時退回鍵名 —— 純函式層（crypto、shared）的測試就是靠這個性質
   * 在 Node 裡跑起來的，而且比對鍵名比比對文案穩。這一條壞掉的話，那些測試會
   * 開始比對空字串而**照樣通過**（`''` 不含任何東西，`not.toContain` 之類的斷言
   * 全部變成廢話），所以要明確釘住。
   */
  it('查不到就回鍵名，不回空字串', () => {
    expect(t('crypto_no_data')).toBe('crypto_no_data');
    expect(t('this_key_does_not_exist')).toBe('this_key_does_not_exist');
  });

  /**
   * 退路要把代入的值帶著走。只回鍵名的話，帶參數的函式在 Node 裡會退化成一個常數 ——
   * `backupFilename()` 的日期算錯也照樣回同一個字串，那條測試就白寫了。
   */
  it('退路帶著代入的值', () => {
    expect(t('backup_filename', '2026-08-04')).toBe('backup_filename(2026-08-04)');
    expect(t('crypto_recovery_key_length', 32)).toBe('crypto_recovery_key_length(32)');
  });

  it('tn() 依數量選 _one / _other，數量固定是第一個參數', () => {
    expect(tn('unit_bookmarks', 1)).toBe('unit_bookmarks_one(1)');
    expect(tn('unit_bookmarks', 0)).toBe('unit_bookmarks_other(0)');
    expect(tn('unit_bookmarks', 7)).toBe('unit_bookmarks_other(7)');
  });
});
