#!/usr/bin/env python3
"""
在擴充套件的 IndexedDB（`storage.local` 也存在這裡）裡找字串。

    ./scripts/idb-grep.py 字串1 字串2 …

**直接 grep profile 沒有用**：Firefox 把 IndexedDB 的值用 snappy 壓過，短字串常被拆成
回溯複製，明文寫進去的東西 grep 也找不到（2026-10-07 實測：擴充套件以明文存的群組名稱
grep 不到，解壓之後就找到了）。所以「grep 不到 = 沒有寫到磁碟」這個推論不成立，要先解壓。

驗隱私空間的東西有沒有以明文落地時，**一定要同時放一個「明知是明文」的字串當對照組**
（例如原生書籤的群組名稱）：對照組找得到、隱私的那個找不到，結論才有意義。

逐列解 `object_data.data`（snappy block 格式，容器裡沒有 python-snappy，自己解），
同時比對 Latin-1 與 UTF-16 兩種字串編碼（structured clone 兩種都會用）。
"""
import glob
import os
import shutil
import sqlite3
import sys
def varint(b, i):
    r = s = 0
    while True:
        c = b[i]; i += 1; r |= (c & 0x7f) << s; s += 7
        if c < 0x80: return r, i
def snappy(b):
    n, i = varint(b, 0); out = bytearray()
    while i < len(b):
        t = b[i]; i += 1; k = t & 3
        if k == 0:
            l = t >> 2
            if l >= 60:
                nb = l - 59; l = int.from_bytes(b[i:i+nb], 'little'); i += nb
            l += 1; out += b[i:i+l]; i += l; continue
        if k == 1:
            l = ((t >> 2) & 7) + 4; off = ((t >> 5) << 8) | b[i]; i += 1
        elif k == 2:
            l = (t >> 2) + 1; off = int.from_bytes(b[i:i+2], 'little'); i += 2
        else:
            l = (t >> 2) + 1; off = int.from_bytes(b[i:i+4], 'little'); i += 4
        for _ in range(l): out.append(out[-off])
    return bytes(out)
needles = sys.argv[1:]
for db in glob.glob('.test-profile/storage/default/moz-extension*/idb/*.sqlite'):
    # 複製一份再開：Firefox 開著時直接讀會撞到鎖，WAL 也要一起帶走
    tmp = os.path.join(os.environ.get('TMPDIR', '/tmp'), 'idb-grep.sqlite')
    shutil.copy(db, tmp)
    for ext in ('-wal', '-shm'):
        if os.path.exists(db + ext): shutil.copy(db + ext, tmp + ext)
        elif os.path.exists(tmp + ext): os.remove(tmp + ext)
    c = sqlite3.connect(tmp)
    rows = c.execute('select data from object_data').fetchall()
    found = {n: 0 for n in needles}; ok = 0
    for (data,) in rows:
        try: plain = snappy(data); ok += 1
        except Exception: plain = data
        for n in needles:
            if n.encode('latin1', 'ignore') in plain or n.encode('utf-16-le') in plain: found[n] += 1
    print(os.path.basename(os.path.dirname(os.path.dirname(db)))[:40], 'rows', len(rows), 'decoded', ok, found)
