#!/usr/bin/env python3
"""把 amo/*.md 轉成可以直接貼進 AMO 表單的純文字。

為什麼需要這一步：那幾份 .md 有兩類東西不能原樣送出去 ——

1. **寫給我們自己的字句。** `reviewer-notes.md` 與 `permissions.md` 開頭都有
   「Paste into the … field」這種操作指示，以及一句中文備註。那是給填表的人看的，
   貼進去審查員會看到一段莫名其妙的話。
2. **Markdown 標記。** AMO 的敘述欄只吃「部分 Markdown」，而審查備註與權限說明是
   純文字欄位；`##`、`**`、反引號會原樣顯示，表格更是會爛成一堆直線。

轉法刻意保守：不試著重新排版，只把標記拿掉、把表格攤成「欄名：值」的段落。
"""
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "amo" / "paste"


def width(s: str) -> int:
    """顯示寬度。中文字佔兩欄，底線要照這個算才會對齊。"""
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in s)


def strip_preamble(text: str) -> str:
    """砍掉第一條 --- 之前的所有東西（標題、操作指示、中文備註）。"""
    parts = text.split("\n---\n", 1)
    return parts[1] if len(parts) == 2 else text


def unmark(s: str) -> str:
    s = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1 (\2)", s)  # 連結攤平成 文字 (網址)
    s = s.replace("**", "").replace("`", "")
    s = re.sub(r"(?<!\w)\*([^*]+)\*(?!\w)", r"\1", s)      # 斜體
    return s.strip()


def convert(text: str) -> str:
    out, headers, in_code = [], None, False
    for line in strip_preamble(text).split("\n"):
        line = line.rstrip()

        # 圍欄本身連同語言標記一起丟掉，內容縮排兩格代替。留著 ``` 或那行 "bash"
        # 都只會讓純文字欄位多出一行看不懂的東西。
        if line.startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            out.append("  " + line if line else "")
            continue

        if re.match(r"^\|[\s-]*\|[\s|-]*$", line):          # 表格的分隔列
            continue
        if line.startswith("|"):
            cells = [unmark(c) for c in line.strip("|").split("|")]
            if headers is None:
                headers = cells
            else:
                out.append("")
                for head, cell in zip(headers, cells):
                    out.append(f"{head}: {cell}")
            continue
        headers = None

        if line.startswith("#"):
            title = unmark(line.lstrip("#"))
            out += ["", title, "-" * width(title)]
            continue

        out.append(unmark(line))

    text = "\n".join(out)
    return re.sub(r"\n{3,}", "\n\n", text).strip() + "\n"


def main() -> int:
    OUT.mkdir(exist_ok=True)
    for name in ("reviewer-notes", "permissions", "privacy-policy.zh-TW", "privacy-policy.en"):
        src = ROOT / "amo" / f"{name}.md"
        dst = OUT / f"{name}.txt"
        dst.write_text(convert(src.read_text()), encoding="utf-8")
        print(f"{dst.relative_to(ROOT)}  ({len(dst.read_text())} 字元)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
