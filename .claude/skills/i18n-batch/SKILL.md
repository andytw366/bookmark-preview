---
name: i18n-batch
description: 把這個擴充套件裡還寫死的中文字串搬進 _locales/（一次一批目錄）。當使用者要求做 i18n、英文化、搬字串、加語系、或問「還剩多少沒搬」時使用。
---

# 搬一批字串進 `_locales/`

介面原本全中文，正在分批搬進 `public/_locales/`。**進度、批次表與已定下的慣例都在
[NEXT.md](../../../NEXT.md) 的「i18n 進度」那一節 —— 動手前先讀那一段**，這裡只寫每一批
怎麼跑。

## 一批的六個步驟

```bash
python3 scripts/scan-strings.py src --dump     # 1. 看這一批要搬哪些（逐行寫到 /tmp/strings.json）
# 2. 編輯原始碼，把字面值換成 t() / tn()
python3 scripts/i18n-add.py /tmp/batch.json    # 3. 寫進所有語系目錄 + 補 import
npm run verify                                 # 4. 四項全綠
# 5. 實機看一眼（見下面）
# 6. 把批次表那一列改成 ✅，把新踩到的坑寫進 NEXT.md
```

第 3 步的 `batch.json` 格式寫在 `scripts/i18n-add.py` 的檔頭。它只做兩件手刻會出錯的事：
**兩個語系的 placeholder 宣告由同一份 `args` 產生**（不可能不一致），以及
**import 插在敘述的結尾而不是開頭**（`vault.ts` 有多行 import，插錯位置會切成兩半）。

## 判斷哪些要搬

| | 例子 | 處理 |
|---|---|---|
| 註解 / 文件 | `// 心跳刻意不算活動` | **不動**，永遠留中文 |
| 使用者看得到的字串 | 按鈕、錯誤訊息、確認提示、檔名 | **搬** |
| `console.warn` / `console.info` | `[書籤預覽] 擷取縮圖失敗` | **不搬**，改寫成英文字面值，前綴用 `[bookmark-preview]` |
| 測試資料 / 內部識別字 | `title: '本機改的'`、`vault/unlock` | **不動** |

`scan-strings.py` 已經把註解濾掉了，它列出來的就是第二、三類。

## 三個共用的東西

| 什麼時候 | 用什麼 |
|---|---|
| 一句話裡有一段要粗體或等寬 | `<Rich text={t('x')} />`，訊息裡用 `*` 夾粗體、反引號夾等寬（`src/sidebar/lib/rich.tsx`）。粗體裡面可以再放等寬 |
| 帶數量的句子 | `tn('unit_bookmarks', n)`，messages.json 要有 `_one` 與 `_other` |
| 句子中間夾一個輸入框 | 拆成 `_before` / `_after` 兩條（「閒置 `[5]` 分鐘後上鎖」／「Lock after `[5]` minutes of inactivity」）。那個空位可以落在任一端 |
| `<html lang>` 與分頁標題 | `applyDocumentLocale(t('page_title_x'))`（`src/shared/document-locale.ts`） |

**鍵名一定要出現在 `t(` / `tn(` 裡面。** 靜態檢查是掃原始碼找那個形狀的，鍵名一旦變成
別的函式的參數（`doSomething('some_key')`）就掃不到，於是「漏翻」與「沒人用的鍵」兩道
檢查同時對它失效 —— 而且不會有任何錯誤訊息。

## 四個已經踩過的坑

1. **語序不同的句子不能靠字串相接。** 中文可以黏成「主密碼錯誤」，英文得是
   「Wrong master password」。把那個名詞本身也做成一條訊息（`vault_secret_password`），
   再當成 placeholder 代進去。
2. **一句話裡有兩個數量時不要硬塞進一個 `tn()`**（「已移入 3 個書籤與 1 個資料夾」）。
   各自 `tn()` 成詞組，再用 `t()` 把詞組組起來，語序才留給各語言自己決定。
3. **測試比對的是鍵名，不是文案**（`toThrow(/crypto_decrypt_failed/)`）。搬到有測試蓋著的
   字串時要一起改，好處是之後改措辭不會再弄壞測試。
4. **耦合的檔案要同一批搬。** `capture.ts` 的 `skip(..., detail)` 會被 `diagnostics.ts` 接進
   「擷取畫面失敗：$REASON$」—— 分兩批搬，中途會出現中英夾雜的句子。

## 實機驗證

用 `firefox-e2e` skill。每一批至少要看到**這一批搬過的字串真的顯示出來**，而不只是
「畫面沒壞」—— 漏翻的症狀是畫面上出現鍵名（`vault_locked` 之類），不是空白，很好認。

**有些缺陷只有看畫面才會發現。** 第 4 批就有一個：`<Rich>` 當時不處理巢狀，於是
`*…`storage.sync`…*` 的反引號原樣印在畫面上 —— 輸出仍然是合法字串，typecheck 與全部
測試都綠。所以「四項全綠」不能代替看一眼。

**設定頁的網址每次都要重抓 UUID**：`./scripts/ff.sh start` 不帶 `KEEP_PROFILE=1` 會建新的
profile，內部 UUID 跟著換。用舊網址會停在空白分頁，看起來像頁面壞了。

```bash
python3 -c "
import re, json
s = open('.test-profile/prefs.js', encoding='utf-8').read()
m = re.search(r'\"extensions\.webextensions\.uuids\",\s*\"(.*?)\"\);', s, re.S)
d = json.loads(m.group(1).encode().decode('unicode_escape'))
print([v for k,v in d.items() if 'bookmark-preview@' in k][0])"
```

**要驗英文得繞一下**：容器裡的 Firefox 是 zh-TW 單語系建置，`intl.locale.requested`
設成 `en-US` 沒有用（沒有語言包，會退回 zh-TW，看起來就像「英文那份沒生效」）。改成：

```bash
npm run build
rm -rf dist/_locales/zh_TW      # 只留一份，顯示出來的就一定是那一份
python3 -c "
import json,pathlib
p=pathlib.Path('dist/manifest.json'); d=json.loads(p.read_text())
d['default_locale']='en'; p.write_text(json.dumps(d,indent=2))"
./scripts/ff.sh start
```

驗完 `npm run build` 就還原了。這條路驗的是「那份 JSON 解析得了、鍵查得到」，
語系挑選是 Firefox 的事。

## 加一個新語系

放一個資料夾進去就好，`src/` 一個字都不用改：

```bash
cp -r public/_locales/en public/_locales/ja   # 翻完跑 npm run verify
```

翻一半是允許的（Firefox 對缺的鍵退回 `default_locale`，目前是 `en`）。`en` 與 `zh_TW`
是我們自己維護的兩份，少一條就是缺陷，`tests/i18n.test.ts` 會擋下來。
