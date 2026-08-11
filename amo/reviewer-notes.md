# Notes to Reviewer

Paste into the "Notes to Reviewer" field on the AMO submission form. **That field is
limited to 3000 characters**, so this is deliberately terse — run
`python3 scripts/amo-paste.py` and paste `amo/paste/reviewer-notes.txt`.

> 這份刻意用英文寫：它唯一的讀者是 Mozilla 的審查員。
>
> **目前只剩 4 個字元的餘裕（2996 / 3000）。要加東西就得先砍掉等量的東西。**
>
> 1.1.0 加了三段之後爆掉 1498 字元，削了七輪才進去 —— 一句一句削效率極差，
> 直接砍掉一整段才有用。最後砍的是「Encryption」那一節：它描述的是 1.0.0 已經審過、
> 這版沒動的設計，而審查員真正需要的那句（不上傳、沒有開發者端點、同步只帶密文）
> 已經在 Network requests 裡，演算法細節則在 `src/crypto/` 與隱私政策。
>
> **不要為了塞新內容去砍這三段**：三個 lint 警告的解釋、`runtime.reload()` 的理由、
> 建置指令。它們各自替審查員省下一次來回提問，砍掉換來的是審查變慢。
>
> 每次改版要更新的是「New in」那一節 —— 更新審查最先看的就是那裡。

---

## New in 1.1.0

No new permissions, APIs or deps.

- English interface; strings moved to `_locales/` (`en`, `zh_TW`), `default_locale` `en`.
- Preview lookup reads more of the page it already fetches — see below.
- Vault bookmarks may fall back to a screenshot (`tabs.captureVisibleTab`, already used for
  ordinary ones), encrypted on the way in — no plaintext thumbnail is stored.

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

Two, both `credentials: 'omit'`, both to build a preview: the bookmark's own URL, then the
cover image it declares — often the site's CDN, the one host contacted that the user did
not bookmark, and always a URL taken from the bookmarked page.

All of it is `src/background/og-fetcher.ts`. Candidates come from `og:image`,
`twitter:image`, `link[rel=image_src]`, JSON-LD, `<video poster>`, and a player's
`poster=`-style query parameter — that last one new in 1.1.0, found by scanning the HTML as
text because such URLs often sit in serialised page data rather than an attribute. A
candidate is used only if absolute http(s) and the response is `image/*`.

**Nothing is uploaded; there is no developer endpoint.** Bookmarks, thumbnails and the
vault stay on the device, except through Firefox Sync — user-enabled, and AES-256-GCM
ciphertext only (`src/crypto/`; the key never touches disk).

## Optional permissions

`<all_urls>` and `history` are `optional_*`, requested when the user presses the matching
button. Without `<all_urls>`: no previews, only per-domain colour cards. Without `history`:
"also clear this URL from history" does nothing — it is used solely for
`browser.history.deleteUrl`, never read, never sent.

After `<all_urls>` is granted the add-on calls `runtime.reload()` on itself — necessary,
not cosmetic: Firefox fixes the API surface when the extension context is created, so
`tabs.captureVisibleTab` is absent if the permission was not held at startup.
