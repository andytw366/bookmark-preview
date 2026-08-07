# Permissions

Permissions are requested when they become useful, not all at once up front.

| Permission | Purpose | Requested |
|---|---|---|
| `bookmarks` | Read the bookmark tree; remove the original when moving into the vault | At install |
| `storage`, `unlimitedStorage` | Settings, encrypted vault, IndexedDB thumbnails | At install |
| `idle` | Idle auto-lock | At install |
| `scripting` | Inject a small function into a tab to read its cover image (needs the host permission below to actually run) | At install |
| `menus` | The "Use as this bookmark's preview" image context menu | At install |
| `<all_urls>` | Screen capture and OG image fetching | When the user presses "Grant permission" |
| `history` | Clear that URL from history when moving a bookmark into the vault | When that option is ticked and "Move in" is pressed |

The last two are `optional_*`: the extension works without them. Without `<all_urls>` you
get colour cards instead of previews; without `history` the "also clear this URL from
history" option has no effect.

## A Firefox-specific trap with optional permissions

A WebExtension's API surface is computed from **the permissions held when that context was
created**. If the background page starts without `<all_urls>`, `tabs.captureVisibleTab` is
never injected, and granting the permission afterwards does not add it.

The background page therefore listens for `permissions.onAdded` and calls
`browser.runtime.reload()` when it detects "permission held but API still missing". The
same trap applies to `history`.

The permission pattern must also be the literal string `<all_urls>`. Substituting the
equivalent `*://*/*` makes `captureVisibleTab` never appear, even with the permission
granted and even after restarting the browser.

## Minimum version

`strict_min_version` is **140.0**, and not arbitrarily:
`browser_specific_settings.gecko.data_collection_permissions` is mandatory for newly
listed extensions, and that key requires Firefox 140+. That floor also covers
`CompressionStream` (113+, used for compression) and `optional_host_permissions` (116+).

## Data collection

`data_collection_permissions` declares `required: ["none"]`. All data stays on the device
and none is sent to the developer or any third party. The optional sync goes through the
user's own Firefox Account with contents already encrypted client-side, which likewise
does not constitute data collection.

**Switching to a third-party thumbnail service would require changing this declaration** —
one of the reasons `PLAN.md` ruled that approach out.

## Known lint warnings

`npm run lint:ext` reports 0 errors and 3 warnings, all three reviewed and accepted:

- `UNSAFE_VAR_ASSIGNMENT` ×2 — `innerHTML` inside React's minified runtime, not code
  written here (grepping the source for `innerHTML` returns nothing). Unavoidable when
  using React; AMO accepts it, and the source is submitted for review alongside the build.
- `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION` — the Android build would need 142+.
  This is a desktop-only extension (`sidebar_action` does not exist on Firefox for
  Android) and declares no `gecko_android`, so the warning does not apply.
