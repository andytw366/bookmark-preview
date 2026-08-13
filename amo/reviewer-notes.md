# Notes to Reviewer

Paste into the "Notes to Reviewer" field on the AMO submission form. **That field is
limited to 3000 characters**, so this is deliberately terse — run
`python3 scripts/amo-paste.py` and paste `amo/paste/reviewer-notes.txt`.

> 這份刻意用英文寫：它唯一的讀者是 Mozilla 的審查員。
>
> **目前只剩 2 個字元的餘裕（2998 / 3000）。要加東西就得先砍掉等量的東西。**
>
> 1.1.0 加了三段之後爆掉 1498 字元，削了七輪才進去 —— 一句一句削效率極差，
> 直接砍掉一整段才有用。最後砍的是「Encryption」那一節：它描述的是 1.0.0 已經審過、
> 這版沒動的設計，而審查員真正需要的那句（不上傳、沒有開發者端點、同步只帶密文）
> 已經在 Network requests 裡，演算法細節則在 `src/crypto/` 與隱私政策。
>
> **不要為了塞新內容去砍這三段**：三個 lint 警告的解釋、`runtime.reload()` 的理由、
> 建置指令。它們各自替審查員省下一次來回提問，砍掉換來的是審查變慢。
>
> 1.1.1 要加「頁面內下載」與「HEAD 解析轉址」兩件事，額度是這樣挪出來的：
> **「New in」那一節整個換掉**，1.1.0 的三條全部刪除。那三條描述的是**已經審過**的版本，
> 對這次更新審查毫無用處 —— 每次改版都該這樣做，那一節寫的是「這次改了什麼」。
>
> 每次改版要更新的是「New in」那一節 —— 更新審查最先看的就是那裡。

---

## New in 1.1.1

Fixes only. No new permissions, APIs or deps: both additions below use `scripting` and
`<all_urls>`, already held, on a page the user has open.

- The cover image may now be fetched **from inside that page** (`scripting.executeScript`,
  the injected function returning a `data:` URL).
- One `HEAD` request, also from the page, to see where a bookmark's URL redirects, so one
  saved as `http://` still matches the tab.

## Source and build

The JavaScript in the `.zip` is bundled and minified by Vite, so the source is attached
(MPL-2.0). Node.js 22 (developed on v22.21.1), npm 10, OS-independent:

```bash
npm ci
npm run build
```

`vite build` runs twice — once for the pages, once with `vite.config.background.ts`, since
an MV3 background script must be a single IIFE. The submitted `.zip` is `npm run package`.

Verified for this version: those two commands on the attached source yield a `dist/`
identical to the submitted package, file for file.

## No remote code

No `eval`, no `new Function`, no remote scripts, no `nativeMessaging`, no backend. React
and ReactDOM are the only runtime dependencies, both bundled.

`web-ext lint`: 0 errors, 3 warnings, all expected.

- 2 × `UNSAFE_VAR_ASSIGNMENT` (`innerHTML`) point inside **React's minified runtime**
  (`assets/styles-*.js`); this add-on's own source contains no `innerHTML`.
- 1 × `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`: `data_collection_permissions` wants
  Android 142, `strict_min_version` is 140. **Desktop only** — `sidebar_action`, the whole
  interface, does not exist on Firefox for Android.

## Network requests

All to build a preview. Every URL is the bookmark's own or one its page declares
(`og:image`, JSON-LD, `<video poster>`, a player's `poster=`); http(s) only.

- The bookmarked URL, `credentials: 'omit'`, when no tab has it open (`og-fetcher.ts`).
- The cover image, from the background page or the page (`image-grab.ts`).
  This one sends cookies: an extension cannot set a cross-origin `Referer`, so a CDN that
  checks it answers 403 however the background page asks. The host is the one the page just
  loaded that image from; only bytes are read.
- `HEAD` on the bookmarked URL, from the page, to resolve redirects.

**Nothing is uploaded; there is no developer endpoint.** Bookmarks, thumbnails and the
vault stay on the device, except through Firefox Sync — user-enabled, AES-256-GCM
ciphertext only (`src/crypto/`; the key never touches disk).

## Optional permissions

`<all_urls>` and `history` are `optional_*`, requested when the user presses the matching
button. Without `<all_urls>`: no previews, only per-domain colour cards. Without `history`:
"also clear this URL from history" does nothing — it is used solely for
`browser.history.deleteUrl`, never read, never sent.

After `<all_urls>` is granted the add-on calls `runtime.reload()` on itself — necessary,
not cosmetic: Firefox fixes the API surface when the extension context is created, so
`tabs.captureVisibleTab` is absent if the permission was not held at startup.
