# AMO 上架資料

送審 [addons.mozilla.org](https://addons.mozilla.org/developers/) 要用的東西都在這裡。
每一份都可以直接複製貼上到對應的欄位。

| 檔案 | 對應的 AMO 欄位 |
|---|---|
| [listing.md](listing.md) | 名稱、摘要、完整描述、分類、標籤、版本說明（zh-TW 與 en-US 各一份） |
| [privacy-policy.zh-TW.md](privacy-policy.zh-TW.md)、[privacy-policy.en.md](privacy-policy.en.md) | Privacy Policy（AMO 可分語系填） |
| [permissions.md](permissions.md) | Permissions justification |
| [reviewer-notes.md](reviewer-notes.md) | Notes to Reviewer（含原始碼與建置步驟） |
| [screenshots/](screenshots/) | Screenshots（1280×800） |

**`permissions.md` 與 `reviewer-notes.md` 刻意用英文寫**：那兩份唯一的讀者是 Mozilla 的
審查員，中文會拖慢審查甚至被要求補件。商店文案與隱私政策則中英都備了，AMO 支援分語系填。

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
| `01-sidebar.png` | 側邊欄以縮圖列出書籤，取代一排看不出內容的文字 | Bookmarks as visual previews in the sidebar, instead of a wall of text |
| `02-gallery.png` | 全頁瀏覽：以整個視窗的寬度並排看過所有封面 | Full-page view: scan every cover at once across the whole window |
| `03-vault-unlock.png` | 隱私空間的入口是隱藏的 —— 在搜尋框打自訂的觸發字串才會跳出密碼畫面 | The vault entrance is hidden — type your own trigger string in the search box to bring up the password screen |
| `04-options.png` | 設定頁：入口方式、觸發字串、備份與同步都在這裡 | Settings: entrance mode, trigger string, backup and sync |

## 送審表單要填的值

| 欄位 | 值 |
|---|---|
| 名稱 | `書籤預覽`（zh-TW）／`Bookmark Preview`（en-US） |
| 版本 | `1.0.0` |
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

**預覽圖必須是真的抓下來的。** 補抓走的是各站自己的 og:image，沒有 og:image 的（Google
首頁、Hacker News）就造訪一次讓擷取管線截圖。目前四張裡有兩筆刻意留成色卡（MDN 與
Stack Overflow）—— 那是沒有預覽圖時的實際樣子，截圖不該假裝每一筆都有圖。

`scripts/store-shot.sh` 會把「已停用安全沙盒」那條提示列去掉 —— 那是**容器環境專屬**的
產物（容器裡建不了 user namespace，測試時只好關掉沙盒），一般使用者不會看到它。
做法是把它上下兩段接起來，不動其他任何像素。**那兩個高度是量出來的，改視窗尺寸或
Firefox 版本後要重量一次**：提示列最左邊有一條橘色強調直條，只要多算幾個像素就會留在
接縫上（腳本註解裡有取樣的指令）。
