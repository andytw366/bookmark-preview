#!/usr/bin/env python3
"""
列出 Firefox 寫到磁碟上的 session restore 內容（每個分頁的歷史項目：網址與 state）。

用來驗「隱私空間的資訊有沒有落到磁碟」：Firefox 大約每 15 秒寫一次
`sessionstore-backups/recovery.jsonlz4`，操作完等一下再跑。

    ./scripts/session-entries.py                  # 讀 .test-profile 的那一份
    ./scripts/session-entries.py FILE --grep 字串  # 另外回報整份檔案裡有沒有出現這個字串

檔案格式是 mozLz4：8 位元組魔數 + 4 位元組原始長度 + 一個 LZ4 block。容器裡沒有
python 的 lz4 模組，所以這裡自己解（LZ4 block 格式只有字面量與回溯複製兩種序列）。
"""
import json
import struct
import sys
from pathlib import Path


def decompress(data: bytes) -> bytes:
    if data[:8] != b'mozLz40\0':
        raise SystemExit('不是 mozLz4 檔案')
    src = data[12:]
    out = bytearray()
    i = 0
    while i < len(src):
        token = src[i]
        i += 1
        length = token >> 4
        if length == 15:
            while True:
                extra = src[i]
                i += 1
                length += extra
                if extra != 255:
                    break
        out += src[i:i + length]
        i += length
        if i >= len(src):
            break
        offset = src[i] | src[i + 1] << 8
        i += 2
        match = token & 15
        if match == 15:
            while True:
                extra = src[i]
                i += 1
                match += extra
                if extra != 255:
                    break
        for _ in range(match + 4):
            out.append(out[-offset])
    return bytes(out)


def main() -> None:
    args = sys.argv[1:]
    needle = None
    if '--grep' in args:
        at = args.index('--grep')
        needle = args[at + 1]
        del args[at:at + 2]
    root = Path(__file__).resolve().parent.parent
    path = Path(args[0]) if args else root / '.test-profile/sessionstore-backups/recovery.jsonlz4'
    text = decompress(path.read_bytes()).decode()
    for window in json.loads(text)['windows']:
        for tab in window['tabs']:
            for entry in tab['entries']:
                # state 是 structured clone 的 base64，看得出鍵名與字串內容就夠了
                print(entry.get('url'), '| state:', entry.get('structuredCloneState', '-'))
    if needle is not None:
        print(f'檔案裡{"有" if needle in text else "沒有"}「{needle}」')


main()
