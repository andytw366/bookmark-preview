# Privacy Policy

**Bookmark Preview**

Last updated: 2026-08-07

## Short version

This add-on **collects nothing** and has no server. Everything stays on your own device.

## What is collected

Nothing. This add-on:

- Performs no telemetry, analytics or usage tracking.
- Has no backend server and no accounts.
- Never sends your bookmarks, browsing history, preview images or master password to the
  developer or to anyone else.

This matches what the add-on declares in `manifest.json`:

```json
"data_collection_permissions": { "required": ["none"] }
```

## Where data is stored

All of it lives in your browser's local storage:

| Data | Location |
|---|---|
| Preview images (screenshots and cover art) | IndexedDB (`bookmark-preview` database) |
| Preferences (density, preview source, trigger string, …) | `storage.local` |
| The vault (encrypted bookmarks and preview images) | `storage.local`, encrypted with AES-GCM |

The decryption key exists only in the background script's memory and is never written to
disk. It disappears when you lock the vault, close the browser, or the idle timeout fires.

## When data leaves your device

Only two cases, both of which you trigger yourself:

**1. You turn on "put an encrypted copy in Firefox Sync".**
The vault's **ciphertext** is then stored in your own Firefox Account via `storage.sync`
so you can use it on your own other devices. On this path:

- What is sent is encrypted bytes. Neither Mozilla's sync servers nor the developer can
  read them.
- Decryption requires your master password or recovery key. Neither is ever synced.
- It is off by default and can be turned off at any time in the settings page.

**2. Fetching preview images requests the sites you have bookmarked.**
"Fetch missing previews" and "Refresh preview" connect to **the bookmark's own URL** to
read the page's cover image (`og:image` and similar). This is an ordinary web request,
equivalent to you opening that URL yourself; it goes only to that site, with no
intermediary server. You can exclude specific sites under "Domains to skip" in settings.

## Screenshots

Screen capture uses Firefox's `tabs.captureVisibleTab`, which only captures **the tab you
are looking at**, and the result is stored only if that URL is one of your bookmarks.
Screenshots stay in local IndexedDB and are never uploaded.

## Browsing history

The browsing-history permission is used only when you move a bookmark into the vault and
tick "also clear this URL from history", and only to **delete**: the URL is removed from
history so it stops autocompleting in the address bar. This add-on never reads, stores or
transmits your browsing history.

## How to delete your data

- **Preview images**: Settings → "Clear all previews".
- **The vault**: Vault page → "Delete the entire vault" (irreversible).
- **The synced copy**: Settings → "Remove the cloud copy and turn off sync".
- **Everything**: Uninstall the add-on; Firefox deletes all of its local storage with it.

## Contact

Please open an issue at https://github.com/andytw366/bookmark-preview/issues
