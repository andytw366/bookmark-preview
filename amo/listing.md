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
用縮圖瀏覽書籤，而不是一排看不出內容的文字。內建以主密碼加密的隱私空間 —— 移進去的書籤會從 Firefox 的書籤選單中消失，只有解鎖後才看得到。沒有伺服器，不做任何遙測。
```

### 完整描述

```
書籤存了幾百個之後，書籤選單就只是一排看不出內容的文字。這個擴充套件把它換成看得懂的畫面：用縮圖預覽瀏覽書籤，另外附一個以主密碼加密、入口隱藏的隱私空間。

■ 縮圖預覽

側邊欄以縮圖列出書籤，三種顯示密度可切換（大卡／小列／純文字）。想一次看過幾十個封面時，用「全頁瀏覽」在整個視窗寬度下並排。

預覽圖以「內容封面」為優先 —— 漫畫與書籍封面、影片縮圖 —— 找不到才用網頁截圖。對內容頁來說封面比截圖更能代表那個書籤，截圖裡通常只看得到導覽列。封面維持原始長寬比不裁切。

判定完全不看網域，沒有站台清單，所以不需要為個別網站做調整。自動判定不可能對所有站台都準，因此也提供直接的出口：在任何頁面對著圖片按右鍵 →「設為這個書籤的預覽圖」。

■ 整理：拖拽、群組與搜尋

全頁瀏覽與側邊欄都能用拖拽排序，順序直接寫回 Firefox 的書籤；拖到資料夾上就移進去。把一張卡片疊在另一張上停一下，可以選擇建立群組或資料夾。

群組就是 tag：同一個資料夾裡的幾個書籤用彩色框線圈在一起，加上名稱與顏色。之後可以改名、換色、整組搬動、轉成子資料夾，或反過來把資料夾攤平成群組。在搜尋框輸入「#名稱」就能跨資料夾找出所有同名群組的書籤；一般搜尋也找得到資料夾。

全頁瀏覽支援瀏覽器的上一頁（Alt+←、滑鼠側鍵）回到剛才的資料夾，另有「↑」回上一層。

書籤群組預設會透過 Firefox 同步到你的其他裝置，可以在設定頁關掉。

■ 隱私空間

用主密碼建立一個加密的書籤空間。移進去的書籤會從 Firefox 的書籤管理員、書籤工具列與書籤選單中「消失」，只有解鎖後才看得到；連同它們的預覽圖一起加密（AES-256-GCM）。整個資料夾也可以連同層級一起移進去。排序、群組與搜尋在隱私空間裡一樣能用，搜尋只在本機的已解密資料上進行。

入口預設是隱藏的：側邊欄上沒有任何相關痕跡，要在搜尋框輸入一段自訂的觸發字串才會跳出密碼畫面。沒碰隱私空間滿一段時間（分鐘數可設定）、離開電腦、或關掉側邊欄，都會自動上鎖。

忘記主密碼是救不回來的，所以建立時會給一組救援金鑰，並可匯出加密的備份檔。也可以選擇把加密副本放進 Firefox 同步，在自己的其他裝置上使用 —— 送出去的是密文，同步伺服器讀不到內容。

■ 隱私

沒有伺服器、沒有帳號、不做任何遙測，開發者收不到你的任何資料。預覽圖與隱私空間存在本機（IndexedDB 與 storage.local）。會離開裝置的只有透過 Firefox 同步、存進你自己 Firefox 帳號的兩樣東西：書籤群組（預設開啟，與書籤本身一樣不另外加密，可在設定頁關掉），以及你自己勾選才會同步的隱私空間（只有密文）。

■ 鍵盤操作

整套流程都能不碰滑鼠完成：方向鍵在書籤間移動、Enter 開啟、右方向鍵進資料夾、Backspace 回上一層、Ctrl+Shift+方向鍵移動書籤或整個群組、選單鍵或 Shift+F10 開右鍵選單。

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
Browse bookmarks as visual previews instead of a wall of text. Includes a password-encrypted vault: bookmarks moved into it disappear from Firefox's bookmark menu until you unlock. No server, no telemetry.
```

### Description

```
Once you have a few hundred bookmarks, the bookmark menu is just a wall of text. This extension turns it into something you can actually look at: bookmarks as visual previews, plus a password-encrypted vault whose entrance is hidden.

The interface is available in English and Traditional Chinese, and follows your Firefox language.

■ Visual previews

A sidebar that lists bookmarks with thumbnails, in three densities (card / row / text-only). When you want to scan dozens of covers at once, "Full page" lays them out as a grid across the whole window.

Previews prefer the page's own cover art — comic and book covers, video thumbnails — and fall back to a screenshot only when there isn't one. For content pages a cover represents the bookmark far better than a screenshot, which usually just shows a navigation bar. Covers keep their original aspect ratio instead of being cropped.

The heuristics never look at the domain, so there is no site list to maintain and no per-site tweaking. Automatic detection can't be right everywhere, so there is a direct override: right-click any image on any page and choose "Use as this bookmark's preview".

■ Organise: drag and drop, groups and search

Drag to reorder in the full-page view and the sidebar — the order is written back to Firefox's own bookmarks. Drop on a folder to move into it. Rest one card on another and choose to create a group or a folder.

A group is a tag: a few bookmarks in one folder framed together with a coloured outline, a name and a colour. Rename it, recolour it, move it as a whole, turn it into a subfolder, or flatten a folder into a group. Type "#name" in the search box to find every bookmark tagged with that name across all folders; plain search now finds folders too.

The full-page view supports the browser's Back (Alt+←, the mouse back button) to return to the folder you were just in, and "↑" to go up a level.

Bookmark groups sync to your other devices through Firefox Sync by default; you can turn that off in settings.

■ The vault

Create an encrypted bookmark space behind a master password. Bookmarks moved into it disappear from Firefox's bookmark manager, toolbar and menu; they are only visible after you unlock. Their preview images are encrypted too (AES-256-GCM). Whole folders can be moved in with their structure intact. Reordering, groups and search work in the vault too; search runs locally on the already-decrypted data.

The entrance is hidden by default: the sidebar shows no trace of it. You type a trigger string of your choosing into the search box to bring up the password screen. It re-locks automatically a configurable number of minutes after you last touched the vault, when you walk away from the machine, or when you close the sidebar.

A forgotten master password cannot be recovered, so you get a recovery key when you create the vault, and you can export an encrypted backup file. You can also opt in to putting an encrypted copy in Firefox Sync to use it on your own other devices — what leaves the device is ciphertext, unreadable to the sync server.

■ Privacy

No server, no account, no telemetry of any kind — the developer receives none of your data. Previews and the vault live on your device (IndexedDB and storage.local). Only two things leave it, both through Firefox Sync into your own Firefox Account: bookmark groups (on by default, not encrypted beyond what Firefox Sync does for your bookmarks themselves, can be turned off in settings), and the vault if you opt in (ciphertext only).

■ Keyboard

The whole flow works without a mouse: arrow keys to move between bookmarks, Enter to open, Right Arrow to enter a folder, Backspace to go up, Ctrl+Shift+arrows to move a bookmark or a whole group, Menu key or Shift+F10 for the context menu.

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

## 版本說明（1.2.0）

送審表單的「版本說明」欄，中英各一份。沒有新權限。

```
・全頁瀏覽支援瀏覽器的上一頁（Alt+←、滑鼠側鍵）回到剛才的資料夾，另有「↑」回上一層。
・拖拽排序，順序寫回 Firefox 的書籤；拖到資料夾上就移進去。側邊欄也能拖。
・兩張卡片疊在一起，可選擇建立群組或資料夾。
・群組＝tag：設定 tag、改名、換色、整組搬動、轉成資料夾，或把資料夾攤平成群組。
　側邊欄也顯示群組。
・搜尋找得到資料夾；輸入「#名稱」跨資料夾找出同名群組的書籤。
・隱私空間也能排序、建群組與搜尋（搜尋只在本機進行）。
・書籤群組預設透過 Firefox 同步到你的其他裝置，可在設定頁關掉。
```

```
・The full-page view supports the browser's Back (Alt+←, the mouse back button) to
  return to the folder you were just in, plus "↑" to go up a level.
・Drag to reorder; the order is written back to Firefox's bookmarks. Drop on a
  folder to move into it. Works in the sidebar too.
・Rest one card on another to create a group or a folder.
・Groups are tags: set a tag, rename, recolour, move a whole group, turn it into a
  folder, or flatten a folder into a group. The sidebar shows groups too.
・Search finds folders, and "#name" finds every bookmark in groups of that name
  across folders.
・The vault gets reordering, groups and search (search runs locally).
・Bookmark groups sync to your other devices through Firefox Sync by default; this
  can be turned off in settings.
```

---

## 版本說明（1.1.1）

送審表單的「版本說明」欄，中英各一份。全部是修正，沒有新功能、沒有新權限。

```
・書籤網址被轉址時（多年前存的 http://、或會轉到語系路徑的首頁），現在仍然抓得到
　預覽圖 —— 之前這種書籤怎麼按都不會有圖。
・防盜連的封面現在抓得到：改在你正開著的那個頁面裡下載，帶得到該網站需要的資訊。
・不再挑到版面裝飾、資訊流裡的第一張圖或輪播沒輪到的那幾張；這種頁面本來就沒有封面，
　改用網站自己的 logo。
・補抓成功後畫面沒更新、以及先跳出「安全檢查中」的網站被抓成檢查頁，都修好了。
```

```
・Bookmarks whose URL redirects — one saved years ago as http://, or a site root
  that redirects to a locale path — now get a preview at all. Previously nothing
  you did would give them one.
・Covers behind hotlink protection now work: the image is downloaded from inside
  the page you already have open, which carries what the site expects.
・Page decorations, the first image in a feed, and the carousel slides that are not
  showing no longer win. Pages like these have no cover of their own, so the site's
  own logo is used instead.
・Fixed: previews not appearing after a successful backfill, and sites that show a
  "checking your browser" page first being captured as that page.
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
