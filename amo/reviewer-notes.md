# Notes to Reviewer

Paste into the "Notes to Reviewer" field on the AMO submission form.

> 這份刻意用英文寫：它唯一的讀者是 Mozilla 的審查員。

---

## Why source code is attached

The JavaScript in the submitted `.zip` is bundled and minified by Vite (Rollup + esbuild),
so the source is submitted alongside it as AMO requires. The source archive contains the
full `src/`, `public/`, the build configuration and `package-lock.json`.

The add-on is licensed under the **Mozilla Public License 2.0**; the verbatim license
text is in `LICENSE` at the root of the source archive. Source is also published at
https://github.com/andytw366/bookmark-preview.

## Build instructions (reproducible)

Requires Node.js 22 (developed on v22.21.1) and npm 10. OS-independent.

```bash
npm ci          # installs exactly what package-lock.json pins
npm run build   # produces dist/
```

`npm run build` runs:

1. `npm run clean` — removes `dist/`
2. `vite build` — bundles the three extension pages (sidebar, options, full-page view);
   configuration in `vite.config.ts`
3. `vite build --config vite.config.background.ts` — bundles the background event page.
   This is a second pass because a Firefox MV3 background script must be a single IIFE
   file and cannot share a build with the ES-module pages.

The submitted `.zip` is produced by `npm run package`, which runs the build and then
`web-ext build` over `dist/`.

`npm run verify` runs type-checking, unit tests, packaging and `web-ext lint` in one go.

## No remote code

- No `eval`, no `new Function`, no remotely loaded scripts anywhere in the package.
- No `nativeMessaging`. No backend server of any kind.
- The only runtime dependencies are React and ReactDOM (see `dependencies` in
  `package.json`); both are bundled into `dist/`.

`web-ext lint` reports 0 errors and 3 warnings, all expected:

- Two `UNSAFE_VAR_ASSIGNMENT` warnings. Both point at `innerHTML` inside **React's
  minified runtime** (`assets/styles-*.js`), not at code written for this add-on —
  grepping the source for `innerHTML` returns nothing.
- One `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`, because
  `data_collection_permissions` needs Firefox for Android 142 while `strict_min_version`
  is 140. **This add-on is Firefox for Desktop only** — `sidebar_action`, the whole
  interface, does not exist on Firefox for Android — so the Android version floor is not
  applicable. It is submitted for Desktop only.

## Network requests

There is exactly one kind: when generating a preview image, the add-on fetches
**the bookmark's own URL** to read the page's cover image (`og:image`, `twitter:image`,
JSON-LD, `<video poster>`). Nothing is ever sent to the developer or to any third party.
See `src/background/og-fetcher.ts` and `src/background/cover.ts`.

## Optional permissions

`<all_urls>` and `history` are both declared as `optional_*`. They are not requested at
install time; the add-on calls `permissions.request()` only when the user presses the
corresponding button. Everything works without them:

- Without `<all_urls>`: no preview images are generated; the add-on falls back to
  colour cards derived from the domain name.
- Without `history`: the "also clear this URL from history" option when moving a
  bookmark into the vault has no effect.

After `<all_urls>` is granted the add-on calls `runtime.reload()` on itself. This is
necessary rather than cosmetic: Firefox decides which APIs to inject when the extension
context is created, so `tabs.captureVisibleTab` simply does not exist if the host
permission was not held at startup. The UI explains this to the user; it is not a fault.

## Encryption

The vault uses AES-256-GCM. The key encrypting the data is wrapped twice — once by a key
derived from the master password via PBKDF2-SHA256 (600,000 iterations, the current OWASP
recommendation), and once by a key derived from a randomly generated recovery key via
HKDF. Either unwraps the same data key, which is what makes both "recover with the
recovery key" and "change the master password without re-encrypting everything" possible.

Implementation is in `src/crypto/`. `tests/crypto.test.ts` and `tests/keyring.test.ts`
cover round-trips, wrong passwords, tamper detection and chunk boundaries.

The decrypted key exists only in the background event page's memory. It is never written
to disk. It disappears when the user locks the vault, when the event page is unloaded, and
on any of three automatic triggers (`src/background/vault-lock.ts`): a configurable number
of minutes since the vault was last used, the same span of system-wide idle time
(`browser.idle`), or the last extension page being closed.
