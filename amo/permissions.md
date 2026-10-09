# Permissions justification

Paste into the "Permissions justification" field on the AMO submission form. Each entry
cites the code that uses it so a reviewer can check quickly.

> 這份與 `reviewer-notes.md` 一樣刻意用英文寫：讀者是 Mozilla 的審查員。

---

## Required

| Permission | Why it is needed | Where |
|---|---|---|
| `bookmarks` | This add-on *is* a bookmark browser: it reads the bookmark tree to render the list and offers rename, move, delete and new-folder. Moving a bookmark into the vault must also remove the native bookmark — otherwise it still shows up in the bookmark menu and hiding it is pointless. | `src/background/bookmark-tree.ts`, `src/background/vault.ts` |
| `storage` | Stores preferences (density, preview source, trigger string, auto-lock minutes) and the encrypted vault. The same permission covers `storage.sync`, used two ways: the vault's opt-in encrypted copy, and bookmark groups and pinned column counts from the full-page view (on by default, fixed 20 KB budget, can be turned off in settings; never contains vault data). | `src/storage/settings.ts`, `src/storage/vault-store.ts`, `src/background/bookmark-grid.ts`, `src/storage/grid-sync.ts` |
| `unlimitedStorage` | Preview images are images. A few hundred bookmarks' worth of screenshots and cover art easily exceeds the default quota, after which Firefox starts evicting data — which the user experiences as previews mysteriously disappearing. | IndexedDB (`src/storage/thumbs-db.ts`) |
| `idle` | One of the vault's auto-lock triggers: clears the key from memory once the user has been away from the machine, with a user-configurable timeout. (The primary trigger is time since the vault was last used, which needs no permission.) | `src/background/vault-lock.ts` |
| `scripting` | Finding cover art requires running a small script in the page to inspect the **rendered DOM**. It reads image URLs and dimensions only; it does not modify the page. Parsing the HTML is not sufficient — many sites insert their cover image with JavaScript or place it in a CSS background. The same mechanism fetches the image bytes and resolves where a bookmark's URL redirects, both of which only work correctly from within the page. | `src/background/cover.ts`, `src/background/image-grab.ts`, `src/background/redirect-resolve.ts` |
| `menus` | Adds one context-menu item, "Use as this bookmark's preview", so the user can right-click any image on a page and pin it as that bookmark's preview. | `src/background/pick-cover.ts` |

## Optional (the add-on works without them)

| Permission | Why it is needed | Without it |
|---|---|---|
| `<all_urls>` | **Generating previews requires reading the rendered page.** Both paths need it: `tabs.captureVisibleTab` for a screenshot of the currently visible tab, and executing the cover-detection script in the page. A bookmark can point anywhere, so no fixed host list is possible. | Only colour cards (a per-domain colour and initial). Everything else works normally. |
| `history` | When a bookmark is moved into the vault, **delete** that URL from browsing history. Without this the bookmark is hidden but the address bar still autocompletes the URL after a few keystrokes, which is a visible hole in the privacy the feature promises. | The "also clear this URL from history" checkbox has no effect. Everything else works normally. |

`history` is used solely to delete a single URL (`browser.history.deleteUrl` in
`src/background/vault.ts`). Browsing history is never read, stored or transmitted.

## What Firefox actually shows the user

Verified in `about:addons` → "Permissions and data" on Firefox 153:

- **Required**: Access bookmarks
- **Optional**: Access browsing history / Access your data for all websites /
  **Access your files** (`存取您電腦上的檔案`)

`storage`, `unlimitedStorage`, `idle`, `scripting` and `menus` do not appear on that
screen — they are not user-consented permissions.

That last entry is not requested separately: it is part of `<all_urls>`, whose match
pattern covers `file://`. In practice the add-on touches local files only if the user has
bookmarked a `file://` page, and does exactly what it does for any other URL (generate a
preview). It never reads files other than bookmarked ones.

## Permissions deliberately not requested

Worth stating because reviewers commonly ask:

- **No `tabs`.** `captureVisibleTab` is gated by the `<all_urls>` host permission and
  does not require `tabs`.
- **No `webRequest` / `proxy` / `cookies`.** No network traffic is intercepted or
  modified.
- **No `nativeMessaging`**, no remote code. Everything ships in the package; there is no
  `eval` and no dynamically loaded script.
- **No backend server.** The only outbound requests go to the bookmark's own site, to read
  its `og:image` or, for a bookmark of a whole site, its icon and Web App manifest — no
  third-party icon service; sync (vault ciphertext, opt-in; bookmark groups, default on) goes
  through Firefox's own `storage.sync`.
