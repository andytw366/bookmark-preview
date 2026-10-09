# Privacy Policy

**Bookmark Preview**

Last updated: 2026-10-08

## Short version

This add-on **collects nothing** and has no server. Your data stays on your own device and,
where it syncs, in your own Firefox Account — never with the developer.

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
| Bookmark groups and pinned column counts (full-page view) | `storage.local`, and by default also `storage.sync` (see below) |

The decryption key exists only in the background script's memory and is never written to
disk. It disappears when you lock the vault, close the browser, leave the vault unused for
a configurable number of minutes, step away from the machine, or close the last extension
page.

## When data leaves your device

Three cases. The developer receives nothing in any of them.

**1. You turn on "put an encrypted copy in Firefox Sync".**
The vault's **ciphertext** is then stored in your own Firefox Account via `storage.sync`
so you can use it on your own other devices. On this path:

- What is sent is encrypted bytes. Neither Mozilla's sync servers nor the developer can
  read them.
- Decryption requires your master password or recovery key. Neither is ever synced.
- It is off by default and can be turned off at any time in the settings page.

**2. Bookmark groups sync through Firefox Sync — on by default.**
The groups you make in the full-page view (their names and colours, which bookmarks belong
to each, identified by Firefox's own bookmark IDs) and the column counts you pin are kept
in `storage.sync`, so the same groups appear on your other devices. On this path:

- It only goes anywhere if you are signed in to Firefox Sync with add-on data syncing;
  otherwise `storage.sync` stays on this device.
- It is **not encrypted by this add-on**. It travels and is stored the same way Firefox
  Sync carries your bookmarks themselves — group names are the same kind of information
  as bookmark titles, which is why this is on by default. A random device ID is included
  to settle conflicts between your devices.
- It never includes anything from the vault. Groups inside the vault are part of the
  vault and sync only as ciphertext, under case 1.
- It uses a fixed 20 KB of the sync space and can be turned off in Settings → "Sync
  bookmark layout and groups"; turning it off also removes this data from sync.

**3. Fetching preview images requests the sites you have bookmarked.**
"Fetch missing previews" and "Refresh preview" connect to **the bookmark's own URL** to
read the page's cover image (`og:image` and similar) or, for a bookmark that points to a
whole site, that site's icon and Web App manifest. This is an ordinary web request,
equivalent to you opening that URL yourself; it goes only to that site, with no
intermediary server. When the page is open in a tab, the request for the image itself is
made **from that page**, so it carries the same cookies the page used to load the image —
some sites serve their images no other way. Nothing is sent anywhere else. You can exclude
specific sites under "Domains to skip" in settings.

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
- **The synced copy of the vault**: Settings → "Remove the cloud copy and turn off sync".
- **Synced bookmark groups**: Settings → untick "Sync bookmark layout and groups" (removes
  them from sync; this device keeps its own copy).
- **Everything**: Uninstall the add-on; Firefox deletes all of its local storage with it.

## Contact

Please open an issue at https://github.com/andytw366/bookmark-preview/issues
