---
name: release
description: 準備一個新版本送 AMO 審查：決定版號、改版號、更新審查備註「New in」與版本說明、驗證打包、產生原始碼壓縮檔、需要時重拍截圖、轉出可貼的文字並檢查字數，最後列出這次要貼哪些欄位。使用者說「送審」「上架」「版號改成 x.y.z」「有哪些文案要重貼」「給 reviewer 的要寫什麼」「compile 新版」或 /release 時使用。
---

# 準備送審

`amo/README.md` 是送審資料的總表，有檢查清單、截圖流程和表單值。這個 skill 是**照順序跑完那張清單**，每次送審都一樣的部分不要再從頭想。

## 1. 版號

看 `git log --oneline <上一個版號的 bump commit>..HEAD` 決定，使用者有指定就照用：

- 只有修 bug、文案 → patch（1.4.0 → 1.4.1）
- 新功能、資料格式變了、新權限 → minor（→ 1.5.0）

版號在這四處，一次改齊，commit 訊息照慣例 `chore: bump version to x.y.z`，內文寫一句為什麼是這一級：

```bash
grep -n '"version"' package.json public/manifest.json
npm version <x.y.z> --no-git-tag-version   # 會一起改 package-lock.json
```

再手動改 `public/manifest.json` 的 `version`，以及 `amo/README.md`「送審表單要填的值」表格裡的版本。

## 2. 文案

| 檔案 | 改什麼 | 限制 |
|---|---|---|
| `amo/reviewer-notes.md` | **整節換掉**「New in x.y.z」：只寫這次改了什麼、有沒有新權限或對外請求 | 整份轉出後 ≤ 3000 字元，目標 2000 出頭；開頭引言列的四件事不准砍 |
| `amo/listing.md` | 在最上面加一節「版本說明（x.y.z）」，中英各一個 code block；舊版本的留著 | 給使用者看的，講他會感覺到的差別，不講實作 |
| `amo/listing.md` 名稱／摘要 | 只有功能定位變了才動 | 名稱 50、摘要 250 字元 |
| `amo/permissions.md` | 權限或對外請求有變才動；**上傳新版的表單沒有這個欄位**，要點寫進審查備註的 New in | — |
| 隱私政策兩份 | 存取或同步的資料有變才動 | — |

改完檢查字數：

```bash
python3 scripts/amo-paste.py     # 審查備註超過 3000 會失敗
python3 - <<'PY'
import re
s = open('amo/listing.md').read()
for h in ('摘要', 'Summary', '名稱', 'Name'):
    m = re.search(rf'### {h}\n+```\n(.*?)\n```', s, re.S)
    if m: print(h, len(m.group(1)))
PY
```

## 3. 驗證與打包

```bash
npm run verify            # typecheck、測試、打包、web-ext lint，四項全綠才往下
npm run package:source    # 打包的是 HEAD，所以先 commit 再跑
ls -la web-ext-artifacts/*<x.y.z>*
```

`web-ext lint` 的三個已知警告在審查備註裡有解釋；出現**第四個**就停下來給使用者看。

## 4. 截圖（只有畫面有變才重拍）

照 `amo/README.md`「截圖是怎麼拍的」：`SEED_SHOWCASE=1 ./scripts/ff.sh start`、補抓預覽圖、`./scripts/ff.sh shot` → `./scripts/store-shot.sh`。操作細節用 `firefox-e2e` skill。拍完每張都用 Read 看過，再交給使用者。

## 5. 交給使用者

列一張表，只列**這次要貼或要上傳的**，沒變的欄位寫「不用動」：

| AMO 欄位 | 來源 | 這次 |
|---|---|---|
| 檔案上傳 | `web-ext-artifacts/bookmark-preview-vault-x.y.z.zip` | 上傳 |
| 原始碼 | `…-x.y.z-source.zip` | 上傳 |
| 版本說明（zh-TW／en-US） | `amo/listing.md` 版本說明（x.y.z） | 貼 |
| Notes to Reviewer | `amo/paste/reviewer-notes.txt`（N 字元） | 貼 |
| 截圖 | `amo/screenshots/` | 換／不用動 |
| 描述、隱私政策 | … | 不用動 |

平台一律 **Firefox for Desktop only**。使用者回報「送出了」之後，用 `wrap` skill 把 NEXT.md 的「最後更新」改成「x.y.z 已送審」並 commit。
