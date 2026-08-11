#!/usr/bin/env python3
"""數出還有多少中文字串要搬進 _locales/。

直接 grep 中文會**連註解一起算**，數字會膨脹將近兩成（`crypto/bytes.ts` 整份都是註解，
卻會榜上有名）。這支腳本先把 `//` 與 `/* */` 消掉再數，剩下的才是字面值與 JSX 文字 ——
也就是真的會出現在使用者眼前、需要搬走的那些。

    python3 scripts/scan-strings.py            # 逐檔行數 + 總數
    python3 scripts/scan-strings.py --dump     # 另外把每一行寫進 /tmp/strings.json

消註解時得自己走一遍字元，不能用正則：`'https://…'` 裡面的 `//` 不是註解的開頭。

**`'` 與 `"` 的字串一定在行尾結束**，這一條看起來多餘，其實是整支腳本最要緊的地方。
`cover.ts` 有一行 `/url\\((['"]?)(.*?)\\1\\)/.exec(...)` —— 那是正則字面值，裡面的 `'`
落單。少了行尾結束這條規則，狀態機會從那裡一路吃到檔案結尾，**之後的註解全都消不掉**，
`cover.ts` 於是憑空多出 24 行「待搬」，而它們一條都不用搬。

一開始是想教它認得正則字面值，但那條路更糟：JSX 的 `</div>` 開頭也是 `<` 加 `/`，
判成正則之後 `.tsx` 反而開始多算。行尾結束不必分辨正則與除法，而且把任何誤判的
影響限制在一行之內。樣板字串真的能跨行，所以 `` ` `` 不套這條規則。
"""
import json
import pathlib
import re
import sys

CJK = re.compile(r'[一-鿿]')
SUFFIXES = ('.ts', '.tsx', '.html', '.css')
# HTML 的 <!-- --> 沒有處理：三個 index.html 各只有一行中文（<title>），不值得為它加一套狀態機
STRIPPABLE = ('.ts', '.tsx', '.css')


def strip_comments(text: str) -> str:
    """把註解換成空白，保持位移不變（行號才對得起來）。"""
    out = list(text)
    i, n = 0, len(text)
    state = None  # None | line | block | sq | dq | tpl
    while i < n:
        c = text[i]
        nxt = text[i + 1] if i + 1 < n else ''
        if state is None:
            if c == '/' and nxt == '/':
                state = 'line'
                out[i] = out[i + 1] = ' '
                i += 2
                continue
            if c == '/' and nxt == '*':
                state = 'block'
                out[i] = out[i + 1] = ' '
                i += 2
                continue
            if c == "'":
                state = 'sq'
            elif c == '"':
                state = 'dq'
            elif c == '`':
                state = 'tpl'
        elif state == 'line':
            if c == '\n':
                state = None
            else:
                out[i] = ' '
        elif state == 'block':
            if c == '*' and nxt == '/':
                out[i] = out[i + 1] = ' '
                state = None
                i += 2
                continue
            if c != '\n':
                out[i] = ' '
        else:  # 字串裡面：只找結尾，順便跳過跳脫字元
            if c == '\\':
                i += 2
                continue
            if (state, c) in (('sq', "'"), ('dq', '"'), ('tpl', '`')):
                state = None
            elif c == '\n' and state != 'tpl':
                # `'` 與 `"` 的字串不能跨行。少了這一條，任何一個落單的引號
                # （最常見的來源是正則字面值裡的 `['"]`）都會讓狀態機一路吃到
                # 檔案結尾，那之後的註解全都消不掉。樣板字串才真的能跨行。
                state = None
        i += 1
    return ''.join(out)


def main() -> int:
    root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('-') else 'src')
    if not root.is_dir():
        print(f'找不到目錄：{root}', file=sys.stderr)
        return 1

    per_file: dict[str, list[tuple[int, str]]] = {}
    for path in sorted(root.rglob('*')):
        if path.suffix not in SUFFIXES:
            continue
        text = path.read_text(encoding='utf-8')
        code = strip_comments(text) if path.suffix in STRIPPABLE else text
        lines = text.split('\n')
        hits = [(no, lines[no - 1].strip()) for no, line in enumerate(code.split('\n'), 1) if CJK.search(line)]
        if hits:
            per_file[str(path)] = hits

    total = sum(len(h) for h in per_file.values())
    for name, hits in sorted(per_file.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        print(f'{len(hits):4d}  {name}')
    print(f'\n{total} 行待搬，散在 {len(per_file)} 個檔案')

    if '--dump' in sys.argv:
        pathlib.Path('/tmp/strings.json').write_text(
            json.dumps(per_file, ensure_ascii=False, indent=1), encoding='utf-8'
        )
        print('每一行寫到 /tmp/strings.json')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
