# AMO 上架資料

送審 [addons.mozilla.org](https://addons.mozilla.org/developers/) 要用的東西都在這裡。
每一份都可以直接複製貼上到對應的欄位。

| 檔案 | 對應的 AMO 欄位 |
|---|---|
| [listing.md](listing.md) | 名稱、摘要、完整描述、分類、標籤、版本說明（zh-TW 與 en-US 各一份） |
| [privacy-policy.zh-TW.md](privacy-policy.zh-TW.md)、[privacy-policy.en.md](privacy-policy.en.md) | Privacy Policy（AMO 可分語系填） |
| [permissions.md](permissions.md) | Permissions justification。**上傳新版本的表單沒有這個欄位**（1.3.0 送審時確認）；權限或對外請求有變時，把要點寫進審查備註的「New in」那一節 |
| [reviewer-notes.md](reviewer-notes.md) | Notes to Reviewer（含原始碼與建置步驟）。**該欄位上限 3000 字元**，`scripts/amo-paste.py` 會檢查並在超過時失敗 |
| [screenshots/](screenshots/) | Screenshots（1280×800） |
| [icon-512.png](icon-512.png) | 附加元件圖示。**不填也可以** —— manifest 已宣告 48/96/128，AMO 會自己採用；上傳這張只是為了高解析度螢幕更清楚 |

**`permissions.md` 與 `reviewer-notes.md` 刻意用英文寫**：那兩份唯一的讀者是 Mozilla 的
審查員，中文會拖慢審查甚至被要求補件。商店文案與隱私政策則中英都備了，AMO 支援分語系填。

## 貼進表單前先跑這個

```bash
python3 scripts/amo-paste.py     # → amo/paste/*.txt
```

**上面那幾份 `.md` 不要整份貼。** 兩個理由：

1. `permissions.md` 與 `reviewer-notes.md` 開頭有「Paste into the … field」這種**寫給填表
   的人看的指示**，還有一句中文備註。貼進去審查員會看到一段莫名其妙的話。
2. AMO 的敘述欄只吃「部分 Markdown」，審查備註與權限說明則是純文字欄位 —— `##`、`**`、
   反引號會原樣顯示，Markdown 表格更是會爛成一堆直線。`permissions.md` 有 12 列表格。

`scripts/amo-paste.py` 會把這兩件事處理掉，輸出到 `amo/paste/`（那個目錄是產生出來的，
不進版本庫）。`listing.md` 不在轉換範圍內 —— 它的每一段本來就用 ``` 框好了，照框內容貼。

## 送審前的檢查清單

- [ ] `npm run verify` 四項全綠（typecheck、測試、打包、`web-ext lint`）
- [ ] `npm run package` 產生 `web-ext-artifacts/bookmark-preview-vault-<版本>.zip`
- [ ] `npm run package:source` 產生 `…-<版本>-source.zip` 並一併上傳（打包過的程式碼必須
      附原始碼，理由與建置步驟見 reviewer-notes.md）。它打包的是 **HEAD 而不是工作區**，
      有未提交的改動時腳本會出聲警告
- [ ] 平台選 **Firefox for Desktop only**（`sidebar_action` 在 Firefox for Android 上不存在）
- [ ] 貼上隱私政策、權限說明、審查備註
- [ ] 上傳四張截圖並加上說明文字（下面有現成的）
- [ ] 授權選 MPL-2.0，與版本庫的 `LICENSE` 一致

## 截圖說明文字

| 檔案 | 中文 | English |
|---|---|---|
| `01-sidebar.png` | 側邊欄以縮圖列出書籤，取代一排看不出內容的文字；群組以同色框標出，指向整個網站的書籤顯示網站圖示 | Bookmarks as visual previews in the sidebar instead of a wall of text — groups framed in colour, whole-site bookmarks shown with the site's icon |
| `02-gallery.png` | 全頁瀏覽：以整個視窗的寬度並排看過所有預覽，拖拽排序、把書籤框成群組，資料夾卡片預覽裡面的書籤 | Full-page view: scan every preview at once, drag to reorder, frame bookmarks into groups, and see what is inside each folder |
| `03-vault-unlock.png` | 隱私空間的入口是隱藏的 —— 在搜尋框打自訂的觸發字串才會跳出密碼框 | The vault entrance is hidden — type your own trigger string in the search box to bring up the password prompt |
| `04-options.png` | 設定頁：隱私空間的入口方式、觸發字串、移出落點與自動上鎖 | Settings: the vault's entrance mode, trigger string, where bookmarks land when moved out, and auto-lock |

## 送審表單要填的值

| 欄位 | 值 |
|---|---|
| 名稱 | `書籤預覽`（zh-TW）／`Bookmark Preview`（en-US） |
| 版本 | `1.3.0` |
| 擴充套件 ID | `bookmark-preview@andytw366.github.io`（**發布後不能再改**） |
| 授權條款 | **Mozilla Public License 2.0**（下拉選單裡選 MPL-2.0，與版本庫的 `LICENSE` 一致） |
| 首頁 | `https://github.com/andytw366/bookmark-preview` |
| 支援網址 | `https://github.com/andytw366/bookmark-preview/issues` |

版本庫還沒推上去的話，這兩個網址在建立版本庫之後才會生效 —— AMO 允許之後再補填。

## 截圖是怎麼拍的

用 `.claude/skills/firefox-e2e/` 那套無頭 Firefox 環境拍的，流程是：

```bash
npm run build && SEED_SHOWCASE=1 ./scripts/ff.sh start   # 乾淨 profile + 展示用書籤
# about:addons → 權限與資料 → 開啟「存取您所有網站中的資料」
# 側邊欄 ⋯ → 補抓預覽圖（抓 og:image），再造訪幾個沒有 og:image 的站讓它截圖
./scripts/ff.sh shot <名稱>                      # 整個畫面
./scripts/store-shot.sh <名稱> <輸出名稱>         # 裁成 1280x800
```

`SEED_SHOWCASE=1`（`scripts/test-headless.sh`）換上一組知名網站的書籤 —— GitHub、ChatGPT、
YouTube、Wikipedia、Google 之類的。預設那組是為了**測試**挑的，最上層塞著九筆
`127.0.0.1` 的封面判定素材，對商店頁的讀者只是雜訊。

**預覽圖必須是真的抓下來的。** 補抓之後展示組幾乎全是首頁，都會變成網站圖示；1.3.0 的截圖
把 GitHub、ChatGPT、YouTube 右鍵「改用頁面預覽」換成各站的 og:image，讓畫面裡封面和圖示並存。

1.3.0 的 `01`、`02` 讓群組入鏡：側邊欄「小列」密度，把 Stack Overflow 疊到 MDN（加入 tag「開發文件」）、
Google 疊到 Wikipedia（停一下 → Enter 建群組），點標籤 →「重新命名」取名「查資料」。`01` 主畫面開著
github.com（先關掉 Firefox 的翻譯提示）。`02` 關掉側邊欄（Ctrl+Shift+.）讓全頁瀏覽吃滿寬度。
`03` 先建立隱私空間並移入一筆（Hacker News），上鎖後在搜尋框打觸發字串。`04` 是解鎖狀態的設定頁、
點左側「隱私空間」；觸發字串改成自訂的（`;;open`），不然會出現「建議改掉」的黃色提醒。

`scripts/store-shot.sh` 會把「已停用安全沙盒」那條提示列去掉 —— 那是**容器環境專屬**的
產物（容器裡建不了 user namespace，測試時只好關掉沙盒），一般使用者不會看到它。
做法是把它上下兩段接起來，不動其他任何像素。**那兩個高度是量出來的，改視窗尺寸或
Firefox 版本後要重量一次**：提示列最左邊有一條橘色強調直條，只要多算幾個像素就會留在
接縫上（腳本註解裡有取樣的指令）。
