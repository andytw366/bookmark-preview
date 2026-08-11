# AMO 商店頁文案

各欄位可直接複製貼上。AMO 的描述欄只吃有限的 HTML（`<b>` `<i>` `<a>` `<ul>` `<li>` `<code>`），
所以下面刻意只用條列與粗體，沒有標題階層。

字數上限：名稱 50 字元、摘要 250 字元。下面的版本都在上限內。

---

## 正體中文（zh-TW，主要語系）

### 名稱

```
書籤預覽
```

### 摘要

```
用縮圖瀏覽書籤，而不是一排看不出內容的文字。內建以主密碼加密的隱私空間 —— 移進去的書籤會從 Firefox 的書籤選單中消失，只有解鎖後才看得到。所有資料留在本機，不做任何遙測。
```

### 完整描述

```
書籤存了幾百個之後，書籤選單就只是一排看不出內容的文字。這個擴充套件把它換成看得懂的畫面：用縮圖預覽瀏覽書籤，另外附一個以主密碼加密、入口隱藏的隱私空間。

■ 縮圖預覽

側邊欄以縮圖列出書籤，三種顯示密度可切換（大卡／小列／純文字）。想一次看過幾十個封面時，用「全頁瀏覽」在整個視窗寬度下並排。

預覽圖以「內容封面」為優先 —— 漫畫與書籍封面、影片縮圖 —— 找不到才用網頁截圖。對內容頁來說封面比截圖更能代表那個書籤，截圖裡通常只看得到導覽列。封面維持原始長寬比不裁切。

判定完全不看網域，沒有站台清單，所以不需要為個別網站做調整。自動判定不可能對所有站台都準，因此也提供直接的出口：在任何頁面對著圖片按右鍵 →「設為這個書籤的預覽圖」。

■ 隱私空間

用主密碼建立一個加密的書籤空間。移進去的書籤會從 Firefox 的書籤管理員、書籤工具列與書籤選單中「消失」，只有解鎖後才看得到；連同它們的預覽圖一起加密（AES-256-GCM）。整個資料夾也可以連同層級一起移進去。

入口預設是隱藏的：側邊欄上沒有任何相關痕跡，要在搜尋框輸入一段自訂的觸發字串才會跳出密碼畫面。沒碰隱私空間滿一段時間（分鐘數可設定）、離開電腦、或關掉側邊欄，都會自動上鎖。

忘記主密碼是救不回來的，所以建立時會給一組救援金鑰，並可匯出加密的備份檔。也可以選擇把加密副本放進 Firefox 同步，在自己的其他裝置上使用 —— 送出去的是密文，同步伺服器讀不到內容。

■ 隱私

所有資料都留在你自己的裝置上（IndexedDB 與 storage.local）。沒有伺服器、沒有帳號、不做任何遙測。只有在你自己勾選同步時才會有資料離開裝置，而且是加密後的位元組。

■ 鍵盤操作

整套流程都能不碰滑鼠完成：方向鍵在書籤間移動、Enter 開啟、右方向鍵進資料夾、Backspace 回上一層、選單鍵或 Shift+F10 開右鍵選單。

■ 權限

「存取所有網站」與「瀏覽記錄」都是選用的，不給也能用：
・存取所有網站 — 產生預覽圖需要讀取已渲染的頁面。不給的話只顯示網域色卡。
・瀏覽記錄 — 把書籤移入隱私空間時，順便刪掉該網址的瀏覽記錄（否則網址列打幾個字仍會把它自動完成出來）。只做刪除，不讀取也不傳送。
```

### 分類

- Bookmarks
- Privacy & Security

### 標籤

```
bookmarks, thumbnails, preview, privacy, encryption
```

---

## English（en-US）

### Name

```
Bookmark Preview
```

### Summary

```
Browse bookmarks as visual previews instead of a wall of text. Includes a password-encrypted vault: bookmarks moved into it disappear from Firefox's bookmark menu until you unlock. Everything stays on your device. No telemetry.
```

### Description

```
Once you have a few hundred bookmarks, the bookmark menu is just a wall of text. This extension turns it into something you can actually look at: bookmarks as visual previews, plus a password-encrypted vault whose entrance is hidden.

The interface is available in English and Traditional Chinese, and follows your Firefox language.

■ Visual previews

A sidebar that lists bookmarks with thumbnails, in three densities (card / row / text-only). When you want to scan dozens of covers at once, "Full page" lays them out as a grid across the whole window.

Previews prefer the page's own cover art — comic and book covers, video thumbnails — and fall back to a screenshot only when there isn't one. For content pages a cover represents the bookmark far better than a screenshot, which usually just shows a navigation bar. Covers keep their original aspect ratio instead of being cropped.

The heuristics never look at the domain, so there is no site list to maintain and no per-site tweaking. Automatic detection can't be right everywhere, so there is a direct override: right-click any image on any page and choose "Use as this bookmark's preview".

■ The vault

Create an encrypted bookmark space behind a master password. Bookmarks moved into it disappear from Firefox's bookmark manager, toolbar and menu; they are only visible after you unlock. Their preview images are encrypted too (AES-256-GCM). Whole folders can be moved in with their structure intact.

The entrance is hidden by default: the sidebar shows no trace of it. You type a trigger string of your choosing into the search box to bring up the password screen. It re-locks automatically a configurable number of minutes after you last touched the vault, when you walk away from the machine, or when you close the sidebar.

A forgotten master password cannot be recovered, so you get a recovery key when you create the vault, and you can export an encrypted backup file. You can also opt in to putting an encrypted copy in Firefox Sync to use it on your own other devices — what leaves the device is ciphertext, unreadable to the sync server.

■ Privacy

Everything stays on your device (IndexedDB and storage.local). No server, no account, no telemetry of any kind. Data leaves your device only if you opt into sync, and then only as encrypted bytes.

■ Keyboard

The whole flow works without a mouse: arrow keys to move between bookmarks, Enter to open, Right Arrow to enter a folder, Backspace to go up, Menu key or Shift+F10 for the context menu.

■ Permissions

"Access your data for all websites" and "browsing history" are both optional — the extension works without them:
・All websites — needed to read the rendered page when generating previews. Without it you get colour cards keyed to the domain.
・Browsing history — when you move a bookmark into the vault, this deletes that URL from history (otherwise the address bar still autocompletes it). Deletion only; nothing is read or transmitted.
```

### Categories

- Bookmarks
- Privacy & Security

### Tags

```
bookmarks, thumbnails, preview, privacy, encryption
```

---

## 版本說明（1.1.0）

送審表單的「版本說明」欄，中英各一份。

```
・介面新增英文，跟著 Firefox 的介面語言自動切換。
・「補抓預覽圖」現在找得到只寫在頁面初始資料裡的封面（嵌入式播放器的 poster 參數、
　JSON-LD、video poster），不再只看 og:image。
・隱私書籤重新抓預覽圖時多了截圖退路，供無法從伺服器端取得封面的網站使用；
　截圖同樣經過加密，不會以明文寫入。
```

```
・The interface is now available in English, following your Firefox language.
・"Fetch missing previews" now finds covers that only appear in a page's initial
  data — an embedded player's poster parameter, JSON-LD, a video poster — instead
  of looking only at og:image.
・Vault bookmarks can now fall back to a screenshot when a site's cover cannot be
  fetched from the server. The screenshot is encrypted like everything else in the
  vault; no plaintext is written.
```

---

## 版本說明（1.0.0，首次送審）

```
首次發布。

・以縮圖預覽瀏覽書籤，三種顯示密度，另有整頁的網格檢視。
・預覽圖以內容封面優先、網頁截圖次之，並可用右鍵手動指定。
・以主密碼加密的隱私空間，含救援金鑰、加密備份檔與選用的跨裝置同步。
・完整的鍵盤操作。
・所有資料留在本機，不做任何遙測。
```
