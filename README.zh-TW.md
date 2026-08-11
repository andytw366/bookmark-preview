# 書籤預覽

Firefox 側邊欄擴充套件：用**縮圖**瀏覽書籤，而不是一排看不出內容的文字；另外提供一個
**以主密碼加密的隱私空間**，放那些不希望留在書籤選單裡的東西。

English: [README.md](README.md)

![側邊欄以縮圖列出書籤，旁邊是開啟中的網頁](amo/screenshots/01-sidebar.png)

## 它做什麼

**縮圖預覽。** 側邊欄以縮圖列出書籤，三種顯示密度可切換（大卡／小列／純文字）。
「全頁瀏覽」則用整個視窗的寬度把它們並排。

預覽圖以頁面**自己的封面**為優先 —— 漫畫與書籍封面、影片縮圖 —— 找不到才用網頁截圖。
判定完全不看網域，所以沒有站台清單要維護。判斷錯的時候，在任何頁面對著圖片按右鍵 →
「設為這個書籤的預覽圖」。

**加密的隱私空間。** 移進去的書籤會從 Firefox 的書籤管理員、書籤工具列與書籤選單中消失，
只有解鎖後才看得到，縮圖也一併加密（AES-256-GCM）。整個資料夾可以連同層級進出。

入口預設是隱藏的 —— 側邊欄上沒有任何痕跡，要在搜尋框打一段自訂的觸發字串才會跳出密碼畫面。
沒碰隱私空間滿一段時間（分鐘數可設定）、離開電腦、或關掉側邊欄，都會自動上鎖。

**忘記主密碼是救不回來的**，所以建立時會給一組救援金鑰，也可以匯出加密的備份檔，
或選擇把加密副本放進 Firefox 同步，在自己的其他裝置上使用。

**所有資料都留在你的裝置上。** 沒有伺服器、沒有帳號、不做任何遙測。只有你自己勾選同步時
才會有資料離開這台機器，而且是密文。

**完全可以用鍵盤操作。** 方向鍵移動、Enter 開啟、右方向鍵進資料夾、Backspace 回上一層、
選單鍵或 `Shift+F10` 開右鍵選單。清單與網格都做了虛擬滾動，3000 個書籤的資料夾約 8 毫秒
就畫得出來。

## 安裝

還沒上架 [addons.mozilla.org](https://addons.mozilla.org/)。要從原始碼跑：

```bash
npm install
npm run build
```

然後開 `about:debugging#/runtime/this-firefox` →「載入臨時附加元件」→ 選 `dist/manifest.json`。

需要 Firefox 140 以上，僅限桌面版（`sidebar_action` 在 Firefox for Android 上不存在）。

介面有**正體中文與英文**兩種，跟著 Firefox 的介面語言走。要再加一種語言，把一個資料夾
放進 `public/_locales/` 就好，`src/` 裡沒有任何地方寫死語系 —— 做法見
[docs/development.md](docs/development.md#strings-and-translations)。

## 文件

深入的技術文件在 `docs/`，**以英文撰寫**：

| | |
|---|---|
| [docs/previews.md](docs/previews.md) | 預覽圖怎麼挑出來的，以及全站共用的 `og:image` 為何被降級 |
| [docs/vault.md](docs/vault.md) | 隱藏入口、金鑰環、救援金鑰、資料夾進出 |
| [docs/sync-and-backup.md](docs/sync-and-backup.md) | 備份檔、跨裝置同步與合併規則 |
| [docs/interface.md](docs/interface.md) | 鍵盤對照表、虛擬滾動、工具列、全頁瀏覽 |
| [docs/architecture.md](docs/architecture.md) | 建置架構、原始碼結構、動手改之前該知道的不變量 |
| [docs/permissions.md](docs/permissions.md) | 每一個權限與它存在的理由 |
| [docs/development.md](docs/development.md) | 建置、字串與翻譯、在 Windows 上測試、容器內的無頭測試 |

中文文件：`PLAN.md` 是原始設計與分階段計畫，**`NEXT.md` 是接手指南** —— 目前狀態、
哪些功能已在實機驗證過、以及測試環境的陷阱清單。要繼續開發先讀那一份。

## 螢幕截圖

| | |
|---|---|
| ![全頁瀏覽的網格](amo/screenshots/02-gallery.png) | ![隱私空間的解鎖畫面](amo/screenshots/03-vault-unlock.png) |
| 全頁瀏覽 —— 一次看過所有封面 | 隱私空間的入口藏在觸發字串後面 |

## 授權

Copyright (c) 2026 andytw366

本專案以 **Mozilla Public License 2.0** 授權，全文見 [LICENSE](LICENSE)。

> This Source Code Form is subject to the terms of the Mozilla Public
> License, v. 2.0. If a copy of the MPL was not distributed with this
> file, You can obtain one at https://mozilla.org/MPL/2.0/.

選 MPL-2.0 而不是 MIT：它是 Mozilla 自己的授權，對 Firefox 擴充套件是自然的選擇，
而且是**檔案層級**的 copyleft —— 別人改了這裡的檔案要釋出改動，但可以把它和自己的
閉源程式碼組合起來。比 GPL 寬鬆，又比 MIT 多保留一點東西。

**原始碼裡沒有逐檔的授權標頭，這是刻意的。** MPL-2.0 的 Exhibit A 明文允許把通知放在
「收件者會去找的地方（例如相關目錄下的 LICENSE 檔）」而不是每一個檔案裡；根目錄的
`LICENSE` 加上這一節就滿足了，七十幾個檔案各加三行樣板是純粹的雜訊。

唯一的執行期相依套件是 React 與 ReactDOM（MIT 授權），與 MPL-2.0 相容。
