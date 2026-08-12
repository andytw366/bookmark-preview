# Architecture

## Two Vite builds

The background script and the extension pages are built **twice**, which is a necessity
rather than a preference.

Firefox's MV3 does not support `background.service_worker`
([bug 1573659](https://bugzil.la/1573659)); it supports only `background.scripts` event
pages, and an event page loads classic scripts, not ES modules. The background must
therefore be bundled into a single self-contained IIFE
(`vite.config.background.ts`), which cannot share a build with the ES-module pages
(`vite.config.ts`).

Two related settings:

- `build.modulePreload: false` — MV3's default CSP forbids inline script, and Vite's
  modulepreload polyfill injects one.
- `emptyOutDir` is `false` in both configs; `npm run clean` clears the directory instead,
  so the two builds do not wipe each other's output in watch mode.

```
dist/
├── manifest.json          ← copied from public/
├── icons/icon-*.png       ← copied from public/
├── background.js          ← IIFE, the event page
├── sidebar/index.html
├── options/index.html
├── gallery/index.html     ← full-page view
└── assets/*.{js,css}
```

## Source layout

```
src/
├── shared/        Used by both ends: types, message protocol, URL helpers,
│                  merge and backup formats (pure functions)
├── crypto/        Encryption core (KDF, AES-GCM, gzip, chunking, vault codec)
├── storage/       Persistence (IndexedDB thumbnails, settings, vault, synced copy)
├── background/    Event page: bookmarks, capture pipeline, OG fetching, vault,
│                  auto-lock, sync
├── sidebar/       React UI (sidebar)
├── options/       Settings page
└── gallery/       Full-page view (reuses the sidebar's tree index, search, thumbnails)
```

## Invariants worth knowing before changing things

**Merge and backup formats live in `shared/`, not `background/`, because they are pure
functions.** They are the part of sync most likely to lose data silently (tombstone
precedence, reattaching orphans, breaking cycles), and only pure functions let every rule
be pinned by a test without first standing up a fake `browser.storage`.

**Every vault-mutating operation runs in a queue** (`exclusive` in `vault.ts`). This is
about correctness, not throughput. Each operation is "read the payload → await a few
things → modify it → save", and a sync merge replaces `payload` with a different object.
Interleaved, a modification lands on the object that has already been replaced, and the
subsequent save writes a payload that does not contain it. The worst combination is
moving a bookmark into the vault: the encrypted data never gets written but the native
bookmark is removed anyway, so the bookmark exists nowhere while the UI reports success.

**The lock is deliberately not reentrant.** A reentrant version looks reasonable and
provides no mutual exclusion at all; the reasoning is in the comments of
`shared/serial-queue.ts`. Batch operations must call the non-locking `*Locked` internals —
calling one `exclusive` function from inside another deadlocks outright. A static test
(`tests/vault-locking.test.ts`) scans `vault.ts` and fails if any locking function is
called from inside another, because neither type-checking nor ordinary tests catch it and
the symptom is that every subsequent vault write fails silently.

**Private browsing windows get a different, empty IndexedDB.** The sidebar normally reads
IndexedDB directly (avoiding a serialisation round trip per thumbnail), but that fast path
reads nothing in a private window — the thumbnail was captured and written to the
background page's database, yet the screen shows only colour cards. `useThumb` therefore
switches to the `thumbs/get` message when `browser.extension.inIncognitoContext` is set,
and keeps the fast path everywhere else. (Vault thumbnails were always fine, because that
path already asks the background page for bytes.)

**Matching a page to a bookmark is wide; the thumbnail key stays narrow.** A bookmark's URL
is often not where the browser ends up — an `http://` bookmark from years ago, a site root
that redirects to a locale path. `shared/url-match.ts` therefore matches across the
http/https difference and across redirects it has resolved, while `normalizeUrl` — which
doubles as the thumbnail key via `urlKey` — is left exactly as it was: widening it would
strand every thumbnail already on disk. Once a page matches, the key must come from **the
bookmark's** URL, not the tab's, or the thumbnail lands somewhere that bookmark will never
read. `open-tab.ts` returns both URLs in one object (`OpenTab`) so the two cannot be
confused: the tab's URL is what tells `coverThumbnailFor` whether the user has navigated
away, and passing the bookmark's URL there makes it decide they have, every time, silently.

Resolving a redirect has to happen **inside the page**, never from the background page:
`https://poedb.tw/` lands on `/tw/` with the user's cookies and on `/us/` without them, so
a cookieless background request answers a different question than the one being asked.

**Cache invalidation is subscribed at the cache's own layer, not in a component.** Every
path that writes or deletes a thumbnail broadcasts `thumbs/updated` (or `thumbs/cleared`),
but a broadcast is only worth as much as its listener: `sidebar/lib/thumb-cache.ts` holds
module-level state that outlives the rows, which virtual scrolling mounts and unmounts
constantly, so it subscribes once at import time and never unsubscribes. When that
subscription lived in `useThumb`'s effect instead, a "this bookmark has no thumbnail" entry
recorded for a row that later scrolled away was never invalidated — a successful backfill
wrote the image to IndexedDB, nobody was listening, and the row kept painting a colour card
until the sidebar was closed and reopened. Components still subscribe to the same broadcast,
but only to re-read and repaint themselves.

**Lock state cannot be determined from broadcasts alone.** When the MV3 event page is
unloaded the in-memory key simply disappears — effectively locking — but no code runs on
that path, so **no `vault/changed` broadcast is sent**. The UI would keep showing
"unlocked" while it was not: moving bookmarks in would fail while everything looked
normal. Three defences: the keepalive port's `onDisconnect` (the only reliable "is the
background page alive" signal), a re-check on `visibilitychange` / `focus`, and always
asking the background page for authoritative state before entering the vault rather than
trusting a cache. All three were verified against a real browser.

Keeping the event page alive needs an actual **heartbeat**, not just an open port: the
sidebar posts on the port every 15 seconds while unlocked, and `vault-lock.ts` registers a
listener that does nothing (receiving the message *is* the point — Firefox will not wake
anything for a message nobody listens to). 15 seconds is half the 30-second reclaim
threshold.

**The key exists only in the background page's memory.** The sidebar never receives it;
when it needs plaintext — a vault bookmark's thumbnail, say — it asks over a message. That
gives "where is the key" exactly one answer, with no need to track whether it was copied
into another context. When the event page unloads the key vanishes, which is auto-lock for
free.

**Vault thumbnails are encrypted, and the plaintext copy is deleted.** If a vault
bookmark's screenshot sat in IndexedDB as plaintext, anyone able to browse the extension's
storage directory could see the contents at a glance and the whole encryption design would
be theatre.

## The message protocol

`shared/messages.ts` is the only interface between the background page and the UI. A
single `Protocol` type constrains both caller and handler — adding a message type without
implementing its handler is a compile error.

Exceptions travel wrapped in a `Result`, because `Error` objects do not survive structured
clone: throwing directly would leave the caller with nothing but `undefined`.

## Tests

179 unit tests (`npm test`):

- **Crypto** — encrypt/decrypt round trips, wrong passwords, tamper detection, chunk
  boundaries, compression ratio, `storage.sync` capacity estimation, the keyring's two
  keys, and the recovery key's encoding and forgiving input.
- **Sync and backup** — every merge rule (newer wins, tombstone precedence, reattaching
  orphans, breaking cycles, tombstone expiry, idempotence), sanitising foreign data,
  backup round trips and each corruption's error message, and the content fingerprint's
  stability and order-independence.
- **The serial queue** — including two cases that fail against the reentrant version that
  once shipped.
- **Moving folders in and out** — preserving hierarchy, recreating empty folders, skipping
  `place:`, parents before children, cycle protection.
- **UI logic** — arrow-key index arithmetic (single column versus grid, both boundaries),
  the virtual-scroll window (total height is conserved, uneven row heights, over-scroll),
  and the thumbnail cache (an item on screen is never evicted; when a stale image is
  revoked).

Plus two static checks, both targeting classes of bug that are invisible to type-checking
and to manual testing: no locking function is called from inside another (see above), and
nobody attaches a raw DOM `contextmenu` handler — bypassing the shared helper loses the
keyboard-invoked coordinate handling, and **that is undetectable with a mouse**.
