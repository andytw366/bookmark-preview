# Notes to Reviewer

Paste into the "Notes to Reviewer" field on the AMO submission form. **That field is
limited to 3000 characters**, so this is deliberately terse — run
`python3 scripts/amo-paste.py` and paste `amo/paste/reviewer-notes.txt`.

> 這份刻意用英文寫：它唯一的讀者是 Mozilla 的審查員。

---

## Source code and build

The JavaScript in the `.zip` is bundled and minified by Vite, so the source is attached.
Licensed **MPL-2.0** (`LICENSE` in the archive); also at
https://github.com/andytw366/bookmark-preview.

Requires Node.js 22 (developed on v22.21.1) and npm 10. OS-independent:

```bash
npm ci          # installs exactly what package-lock.json pins
npm run build   # produces dist/
```

`npm run build` cleans `dist/`, then runs `vite build` twice — once for the extension
pages, once with `vite.config.background.ts` for the background event page (MV3 background
scripts must be a single IIFE, so they cannot share a build with ES-module pages). The
submitted `.zip` is `npm run package` (build + `web-ext build`).

Verified: `npm ci && npm run build` on the attached source yields a `dist/` md5-identical
to the submitted package.

## No remote code

No `eval`, no `new Function`, no remote scripts, no `nativeMessaging`, no backend server.
The only runtime dependencies are React and ReactDOM, both bundled.

`web-ext lint`: 0 errors, 3 warnings, all expected.

- 2 × `UNSAFE_VAR_ASSIGNMENT` (`innerHTML`) point inside **React's minified runtime**
  (`assets/styles-*.js`). Grepping this add-on's source for `innerHTML` returns nothing.
- 1 × `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`: `data_collection_permissions`
  wants Android 142, `strict_min_version` is 140. **Desktop only** — `sidebar_action`, the
  entire interface, does not exist on Firefox for Android.

## Network requests

Exactly one kind: to generate a preview, the add-on fetches **the bookmark's own URL** to
read its cover image (`og:image`, `twitter:image`, JSON-LD, `<video poster>`). Nothing is
ever sent to the developer or a third party. See `src/background/og-fetcher.ts`.

## Optional permissions

`<all_urls>` and `history` are `optional_*`, requested only when the user presses the
corresponding button. Without `<all_urls>`: no previews, just per-domain colour cards.
Without `history`: the "also clear this URL from history" option does nothing (`history` is
used solely for `browser.history.deleteUrl`; history is never read or sent).

After `<all_urls>` is granted the add-on calls `runtime.reload()` on itself. This is
necessary, not cosmetic: Firefox computes the API surface when the extension context is
created, so `tabs.captureVisibleTab` does not exist if the host permission was not held at
startup.

## Encryption

AES-256-GCM. The data key is wrapped twice — by PBKDF2-SHA256 (600,000 iterations) from
the master password, and by HKDF from a random recovery key — which is what makes both
recovery and password changes without re-encryption possible. See `src/crypto/`.

The decrypted key lives only in the background event page's memory, is never written to
disk, and is discarded on lock, on event-page unload, and on three triggers in
`src/background/vault-lock.ts`: time since the vault was last used, system idle, or the
last extension page closing.
