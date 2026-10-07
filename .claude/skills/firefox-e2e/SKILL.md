---
name: firefox-e2e
description: 在容器裡用 Xvfb + xdotool 實機驗證這個 Firefox 擴充套件（側邊欄、全頁瀏覽、設定頁、隱私空間）。當使用者要求實機測試、驗證某個 UI 行為、複驗 NEXT.md 表格裡的 ⬜ 項目、或需要截圖確認畫面時使用。
---

# 實機驗證這個擴充套件

容器沒有圖形介面，用 Xvfb（`:99`）跑真的 Firefox。**所有操作都走 `./scripts/ff.sh`**，不要自己拼 xdotool / import / convert —— 那正是這支腳本要省掉的東西。

## 起手式

```bash
npm run build && ./scripts/ff.sh start
```

`start` 用 `setsid` 脫離呼叫端的 shell，所以 Firefox 會活過整個 session，後續每個操作都能各自一條指令（**不必**再把整段流程塞進同一條 bash 指令）。

指令可以串接，一行做完一段互動：

```bash
./scripts/ff.sh click 120 220 type '###' wait 2 sidebar gate
```

截圖存在 `.test-shots/<名稱>.png`，路徑會印出來，直接用 Read 看。點擊類子指令後面會自動等 `FF_WAIT`（預設 1.2 秒）。

常用：`start stop alive click rclick move scroll type key wait shot sidebar crop zoom trigger unlock`。完整說明在 `scripts/ff.sh` 開頭的註解。

## 每次都會用到的座標（1500x950、側邊欄 240px）

| 位置 | 座標 |
|---|---|
| 側邊欄搜尋框 | `120 220`（有分頁列時 `120 271`） |
| 「書籤」/「隱私空間」分頁 | `60 224` / `180 224` |
| 觸發字串跳出的密碼欄位 | `120 485` |
| 底部工具列：選取 / 全頁瀏覽 / ⋯ | `120 834` / `181 834` / `233 834` |
| 多選第二列的動作鈕（移動到…） | `40 834` |
| 全頁瀏覽的模式列（書籤／隱私空間／選取） | `285 219` / `334 219` / `392 219` |

**座標會漂移**：通知列、麵包屑、分頁列出現與否都會讓整欄上下移動約 30～50px。動作之前先 `sidebar` 截一張確認，比事後猜為什麼點空了便宜。

## 必踩的坑（每一條都是實測換來的）

- **隱私空間會自己上鎖**（MV3 事件頁被回收）。慢慢一步一截圖必定撞到。要嘛整段操作一行跑完，要嘛用下面的 DevTools 手法釘住事件頁。修好之後這條就不成立了 —— 先確認 `NEXT.md` 的狀態。
- **釘住事件頁的唯一有效手法**：`about:debugging` → 該擴充套件 →「檢測」掛上 DevTools toolbox。副作用是那是個**總在最上層**的浮動面板，會蓋住其他分頁（沒有視窗管理員，restack 不了）。`extensions.eventPages.enabled=false` 對 MV3 無效。
- **背景頁 console 點得到**（它是一般分頁內容），掛 listener 觀察事件比從 UI 猜快得多。**先確認 console 右下角的 context 選單指到 `_generated_background_page.html`** —— 預設常常指到側邊欄或全頁瀏覽，掛錯 context 會什麼都收不到。背景頁被回收時那一項會消失，只剩 `Web Extension Fallback Document`。
- **`<all_urls>` 權限**：權限 doorhanger 是 XUL 彈出面板，點不到。改走 `about:addons` → 擴充套件 → 該套件 →「權限與資料」→ 切「存取您所有網站中的資料」。授予後擴充套件會自己 `runtime.reload()`。
- **設定頁**直接開 `moz-extension://<內部 UUID>/options/index.html`（UUID 在 `about:debugging` 或 `grep -o 'uuids[^)]*' .test-profile/prefs.js`）。
- **勾選框點不到**（`.row__check` / `.card__check` 是純視覺的兄弟元素）—— 點卡片本體。
- **確認提示裡取消勾選會改變版面高度**（提示文字消失），按鈕往上移約 22px。取消勾選後要重新截圖定位，否則點到 popover 外面把它關掉。
- **數字輸入框連續打字會掉字**（受控 input + 非同步 settings），每個字之間停 1 秒以上。
- 進程名是 `firefox-bin`，`pkill -x firefox` 殺不掉；也**不要**用 `pkill -f firefox`（會殺到腳本自己）。用 `./scripts/ff.sh stop`。

## 拖拽

`./scripts/ff.sh drag X1 Y1 X2 Y2` 一次做完。要在拖到一半時截圖（看插入線、合併的虛線框、停留時間）就拆開：
`press X Y glide X Y wait 0.6 glide X+2 Y+2 crop … release`。HTML5 拖拽要「按住 → 分好幾段移動」
才會開始，一次跳到終點只會得到一個點擊；腳本的 `glide` 已經處理好。拖到分頁列開出的新分頁會搶焦點，拖完要切回來。

**動到 `src/background/` 之後要 `stop` 再 `start`**：`web-ext run` 重建後背景頁可能還是舊的（NEXT.md 有記）。

## 驗「有沒有寫到磁碟」

隱私空間的東西不能出現在網址、`history.state` 這類會被 session restore 存下來的地方。
操作完等 15 秒，`./scripts/session-entries.py --grep <名稱>` 直接解開 profile 裡的
`recovery.jsonlz4` 看。這比在 DevTools 裡看 `history.state` 更接近真正的威脅（磁碟上的檔案）。

`storage.local`（IndexedDB）**不能直接 grep**（值被 snappy 壓過，明文也 grep 不到）：用
`./scripts/idb-grep.py 對照組字串 要驗的字串`，對照組放一個明知是明文的東西（例如原生書籤的群組名稱）。

## 封面排序的驗證不必載入擴充套件

要改 `cover.ts` 的評分時走擴充套件那條路很貴。`cover.ts` 沒有任何 import，`npx esbuild src/background/cover.ts --format=esm` 就是自足模組，把它注入 `tests/fixtures/site/` 的頁面即可拿到真實版面下的候選清單與分數。細節見 NEXT.md「測試環境的注意事項」。

## 收工

驗證完把狀態變化寫回 `NEXT.md`（表格 + 新踩到的坑），不要只留在對話裡。程式碼有動過就跑 `npm run verify`（typecheck + 測試 + 打包 + web-ext lint，四項全綠才算沒壞）。
