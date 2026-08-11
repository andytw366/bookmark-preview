#!/usr/bin/env python3
"""把一批新訊息寫進所有語系目錄，並補上取字串用的 import。

    python3 scripts/i18n-add.py batch.json

搬字串的每一批都要做這兩件機械動作，手刻兩次就各出過一次錯，所以固定下來：

1. **兩個語系的 placeholder 宣告必須完全一致。** 手寫時很容易只在中文那邊補上宣告，
   而 `tests/i18n.test.ts` 會擋下來 —— 但那是事後才發現。這裡改成由 `args` 一次
   產生兩邊的宣告，不可能不一致。
2. **import 不能用「最後一個 import 開頭的行」去插。** `vault.ts` 的 import 有多行的
   形式（`import {` … `} from '…';`），插在開頭那行後面會把它切成兩半，症狀是一串
   看不懂的 TS1003 / TS1005。這裡認的是**敘述的結尾**。

batch.json 的格式：

    {
      "replace": {
        "src/sidebar/components/Toolbar.tsx": [
          ["title=\"更多選項\"", "title={t('toolbar_more')}", 1],

          // 只有文字的 JSX 行用 @line：比對的是**去掉縮排之後**的內容，
          // 換上去時把原本的縮排補回來。JSX 的縮排深度沒有規律，
          // 連著縮排一起比對的話每一條都要先去數空白，數錯就是「預期 1 實際 0」。
          ["@line 全選", "{t('action_select_all')}", 1]
        ]
      },

      "messages": {
        "toolbar_select": { "zh": "選取", "en": "Select" },

        "vault_moved": {
          "args": ["count"],                      // 呼叫端的參數順序 → $1、$2…
          "zh": "已移動 $COUNT$ 個項目。",
          "en": "Moved $COUNT$ items."
        },

        // tn() 用的：自己寫成兩條，沒有特別的複數模式
        "unit_bookmarks_one":   { "args": ["count"], "zh": "$COUNT$ 個書籤", "en": "$COUNT$ bookmark" },
        "unit_bookmarks_other": { "args": ["count"], "zh": "$COUNT$ 個書籤", "en": "$COUNT$ bookmarks" }
      },
      "imports": ["src/sidebar/components/Toolbar.tsx"]
    }

`args` 是**呼叫端傳參數的順序**，不是句子裡出現的順序 —— 中英語序常常相反，
`t('x', size, quota)` 在英文可能是「$SIZE$ … $QUOTA$」而中文是「$QUOTA$ … $SIZE$」，
兩邊的宣告卻都必須是 size→$1、quota→$2。腳本會檢查每個語系句子裡的 `$NAME$`
恰好等於 `args` 那一組，少一個或多一個都直接失敗。
"""
import collections
import json
import pathlib
import re
import sys

LOCALES_DIR = pathlib.Path('public/_locales')
IMPORT_LINE = "import { t } from '@/shared/i18n';"
IMPORT_TN_LINE = "import { t, tn } from '@/shared/i18n';"
# 一行就寫完的 import，或多行 import 的結尾
IMPORT_END = re.compile(r"^(import .* from '[^']*';|\} from '[^']*';|import '[^']*';)$")
PLACEHOLDER = re.compile(r'\$([A-Za-z0-9_]+)\$')


def locales() -> list[str]:
    return sorted(p.name for p in LOCALES_DIR.iterdir() if p.is_dir())


def declarations(args: list[str], messages: dict[str, str], key: str) -> dict:
    """由 args 產生 placeholders 宣告，順便確認每個語系都用到同一組名字。"""
    wanted = {name.lower() for name in args}
    for locale, text in messages.items():
        used = {m.lower() for m in PLACEHOLDER.findall(text)}
        if used != wanted:
            missing = sorted(wanted - used)
            extra = sorted(used - wanted)
            raise SystemExit(
                f'{key} / {locale}：句子裡的 placeholder 與 args 不符'
                + (f'，少了 {missing}' if missing else '')
                + (f'，多了 {extra}' if extra else '')
            )
    return {name: {'content': f'${i}'} for i, name in enumerate(args, 1)}


def replace_in(path: pathlib.Path, pairs: list) -> int:
    """把字面值換成 t() 呼叫。`count` 必須完全對上，少一個或多一個都停下來。

    要求對上次數不是龜毛：`'取消'` 這種短字串在同一個檔案裡常常出現好幾次，
    而其中一次可能是別的意思。數字對不上就代表這一條的比對範圍不是你以為的那樣。
    """
    lines = path.read_text(encoding='utf-8').split('\n')
    done = 0
    for old, new, count in pairs:
        if old.startswith('@line '):
            target = old[len('@line ') :]
            hits = [i for i, l in enumerate(lines) if l.strip() == target]
            if len(hits) != count:
                raise SystemExit(f'{path}：「{target}」預期 {count} 次，實際 {len(hits)} 次')
            for i in hits:
                indent = lines[i][: len(lines[i]) - len(lines[i].lstrip())]
                lines[i] = indent + new
        else:
            text = '\n'.join(lines)
            found = text.count(old)
            if found != count:
                raise SystemExit(f'{path}：預期 {count} 次，實際 {found} 次\n  {old[:70]}')
            lines = text.replace(old, new).split('\n')
        done += count
    path.write_text('\n'.join(lines), encoding='utf-8')
    return done


def add_messages(spec: dict) -> int:
    known = locales()
    for locale in known:
        path = LOCALES_DIR / locale / 'messages.json'
        data = json.loads(path.read_text(encoding='utf-8'), object_pairs_hook=collections.OrderedDict)
        for key, entry in spec.items():
            if locale not in entry:
                continue  # 這個語系沒翻這一條，允許（Firefox 會退回 default_locale）
            if key in data:
                raise SystemExit(f'{locale}：{key} 已經存在，要改文案請直接編輯 messages.json')
            record: dict = {'message': entry[locale]}
            if entry.get('description'):
                record['description'] = entry['description']
            if entry.get('args'):
                record['placeholders'] = declarations(
                    entry['args'],
                    {loc: entry[loc] for loc in known if loc in entry},
                    key,
                )
            data[key] = record
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(f'{locale}: {len(data)} 條')
    return len(spec)


def add_import(path: pathlib.Path, need_tn: bool) -> str:
    text = path.read_text(encoding='utf-8')
    if "from '@/shared/i18n'" in text or "from './i18n'" in text:
        return '已經有了'
    line = IMPORT_TN_LINE if need_tn else IMPORT_LINE
    lines = text.split('\n')
    ends = [i for i, l in enumerate(lines) if IMPORT_END.match(l)]
    if ends:
        lines.insert(max(ends) + 1, line)
    else:
        # 完全沒有 import 的檔案（例如 crypto/chunk.ts）：放在最前面
        lines.insert(0, line + '\n')
    path.write_text('\n'.join(lines), encoding='utf-8')
    return '已插入'


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit('用法：python3 scripts/i18n-add.py batch.json')
    spec = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))

    for name, pairs in spec.get('replace', {}).items():
        path = pathlib.Path(name)
        if not path.exists():
            raise SystemExit(f'找不到檔案：{name}')
        print(f'{name}: 換掉 {replace_in(path, pairs)} 處')

    if spec.get('messages'):
        count = add_messages(spec['messages'])
        print(f'新增 {count} 條')

    for name in spec.get('imports', []):
        path = pathlib.Path(name)
        if not path.exists():
            raise SystemExit(f'找不到檔案：{name}')
        need_tn = bool(re.search(r'\btn\(', path.read_text(encoding='utf-8')))
        print(f'{name}: {add_import(path, need_tn)}')

    print('\n接著跑：npm run verify')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
