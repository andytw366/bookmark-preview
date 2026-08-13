# Notes to Reviewer

Paste into the "Notes to Reviewer" field on the AMO submission form. **That field is
limited to 3000 characters**, so this is deliberately terse — run
`python3 scripts/amo-paste.py` and paste `amo/paste/reviewer-notes.txt`.

> 這份刻意用英文寫：它唯一的讀者是 Mozilla 的審查員。
>
> **目標長度是 2000 出頭，不是「貼到 3000 為止」。** 上限是 3000，1.1.1 這一輪刻意壓到
> 2308 —— 審查員是掃讀的，落落長的說明反而讓真正重要的那幾句（建置指令、三個 lint
> 警告、為什麼帶 cookie）被淹掉。剩下的近 700 字元是給下一版的，不要拿來鋪陳。
>
> **內容一句都沒有少，砍掉的是修飾。** 做法是整份重寫成「一件事一句話」，
> 而不是一句一句削 —— 1.1.0 那次一句一句削了七輪才進去，效率極差。
>
> **這四件事不准砍**（每一件都替審查員省下一次來回提問）：建置指令、
> 「重建結果逐檔相同」那句、三個 lint 警告的解釋、`runtime.reload()` 的理由。
>
> 每次改版要更新的是「New in」那一節，而且是**整節換掉**：它寫的是「這次改了什麼」，
> 已經審過的版本留在那裡對更新審查毫無用處。

---

## New in 1.1.1

Fixes only; no new permissions, APIs or deps. Two new kinds of request, both made from a
page the user already has open, using `scripting` and `<all_urls>` — see below.

## Source and build

Minified by Vite, so the source is attached (MPL-2.0). Node.js 22 (v22.21.1), npm 10:

```bash
npm ci
npm run build
```

`vite build` runs twice (the pages, then `vite.config.background.ts`) because an MV3
background script must be one IIFE. The `.zip` is `npm run package`.

Verified for 1.1.1: those commands reproduce the submitted `dist/`, all 24 files identical.

## No remote code

No `eval`, `new Function`, remote scripts, `nativeMessaging` or backend. React and
ReactDOM are the only runtime dependencies, both bundled.

`web-ext lint`: 0 errors, 3 warnings. Two `UNSAFE_VAR_ASSIGNMENT` (`innerHTML`) are inside
**React's minified runtime**; this add-on's own source has none. The third:
`data_collection_permissions` wants Android 142, `strict_min_version` is 140 — **desktop
only**, `sidebar_action` does not exist on Android.

## Network requests

All to build a preview; every URL is the bookmark's own or one its page declares
(`og:image`, JSON-LD, `<video poster>`, player `poster=`), http(s) only.

- The bookmarked URL, `credentials: 'omit'`, when no tab has it open (`og-fetcher.ts`).
- The cover image, from the background page or from that page (`image-grab.ts`). This one
  sends cookies: an extension cannot set a cross-origin `Referer`, so a CDN that checks it
  answers 403 from the background page. The host is the one the page just loaded that
  image from; only bytes are read.
- `HEAD` on the bookmarked URL, from the page, to see where it redirects — a bookmark
  saved as `http://` must still match the open tab.

**Nothing is uploaded; no developer endpoint.** Everything stays on the device, except
Firefox Sync — user-enabled, AES-256-GCM ciphertext only; the key never touches disk.

## Optional permissions

`<all_urls>` and `history` are `optional_*`, requested on a button press. Without it: no
previews, only colour cards. `history` is used solely for `browser.history.deleteUrl` —
never read, never sent.

After `<all_urls>` is granted the add-on calls `runtime.reload()`: Firefox fixes the API
surface when the context is created, so `tabs.captureVisibleTab` would otherwise be absent.
