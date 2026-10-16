# Backup and cross-device sync

"Forget the master password and the data is gone" is the one failure mode this extension
cannot repair. Both features here exist to address it, and both live in the settings page.

## The encrypted backup file

`vault/backup-export` / `backup-import` writes a JSON file containing the encrypted
bookmarks plus the entire `VaultMeta` — salt, KDF parameters, and the data key wrapped
once under the master password and once under the recovery key.

**That metadata has to be in the file.** Without it, even remembering the password would
not derive the key, and the file would be a permanently unopenable pile of bytes. Because
it is there, the backup can also be opened with the **recovery key** — without that, a
backup is worthless in exactly the situation it was made for.

The file **does not contain preview images**. Images can be re-fetched; bookmarks cannot.
Including them would only make the file too large to keep somewhere safe.

**Export requires unlocking first.** The file is encrypted either way, so this is not
about the contents — it makes you prove, at the moment of export, that you still remember
the password. A backup that cannot be opened is worse than no backup, because you will
believe you have one.

Import takes one of two paths:

- **No vault on this device yet** — the KDF parameters are adopted along with the data
  (new machine, reinstall, disaster recovery). From then on, the backup file's password
  unlocks it.
- **A vault already exists** — unlock first, then merge item by item. The backup's
  password may differ from the local one: it is opened with the backup's key and written
  back with the local key.

The file also carries the **layout** (the order you arranged things in, see
[vault.md](vault.md#order)) as an optional, separately encrypted `layout` field — same key.
It is an extra field rather than a version bump on purpose: an older `parseBackup` rejects
files with a newer `version` but ignores fields it does not know, so a backup made by this
version still restores in an older one, just without the order.

## Cross-device sync

Off by default, and it must be turned on deliberately: enabling it means handing your
encrypted bookmarks to Mozilla's sync servers for safekeeping.

The primary store is always `storage.local`. `storage.sync` holds only an encrypted copy,
so the 100 KB quota limits **how much can sync**, not how much can be stored — and with
[syncing through bookmarks](#syncing-through-bookmarks-opt-in-off-by-default) not even that.

Four rules, each corresponding to a real way data gets lost:

1. **Merge and upload only while unlocked.** Merging requires decrypting the remote copy,
   and the key exists only while unlocked. Pushing the local copy up while locked would
   flatly overwrite whatever another device added.
2. **Do nothing while the remote copy is still in transit.** `storage.sync` propagates key
   by key; until every chunk has arrived we do not hold the complete remote content, and
   uploading then is overwriting. This one is especially easy to miss — if the guard lives
   only inside the "remote is complete" branch, the moment that most demands caution
   becomes an unconditional overwrite. Disaster recovery on a new device *is* that moment.
3. **Stop and report when the salts differ.** Two independently created vaults have
   mutually unintelligible keys; there is no possible merge, so the user has to pick a
   side explicitly.
4. **Decide "does this need uploading" from a content fingerprint, not from ciphertext.**
   Every encryption uses a fresh IV, so the same content never produces the same
   ciphertext. Comparing ciphertext makes two devices take turns concluding "the cloud
   differs from me" and overwriting each other, each overwrite triggering the next — a
   write loop that never settles.

### Merge rules

`src/shared/vault-merge.ts`, pure functions: keyed by `id`, the larger `updatedAt` wins,
**a tombstone beats an edit** regardless of timestamp ("I thought I deleted that and it
came back" is far worse than "I deleted the wrong thing and have to add it again"), and
tombstones are kept for 30 days.

The merged result is then normalised: records whose parent no longer exists are reattached
at the top level, and cyclic `parentId` chains are broken. Two devices each moving a folder
is enough to produce both states, and their symptom is "the bookmark is still in the data
but can never be seen on screen" — indistinguishable from having lost it.

### One compact copy in the cloud

`storage.sync` holds a single document, `vaultPack` + `vaultPackC0…` (`src/storage/pack-sync.ts`):
the bookmarks **and** the layout (order, groups, column counts — see [vault.md](vault.md#order))
in a compact encoding (`src/shared/sync-pack.ts`), then gzip and AES-GCM like every other vault
blob, written as **base91** (`src/crypto/base91.ts`) instead of base64. The local store, the backup file and the merge rules do not use this
encoding; it exists only between "push" and "pull".

Why: the plain JSON spent most of the quota on things gzip cannot shrink. 400 bookmarks took
about 70 KB, and only ~12 KB of that was URLs and titles. A record's random UUID appeared
three times (bookmark, `order`, `groupOf`) in two separately compressed documents, and every
record carried two or three 13-digit millisecond timestamps. The compact form keeps one id
table and refers to it by index, sorts bookmarks by `createdAt` and stores the gaps (a batch
import is milliseconds apart), and stores `updatedAt` as the offset from `createdAt`. Version 2
of the encoding also stores UUIDs as 16 bytes in base64url rather than 32 hex digits, `order`
members and `groupOf` keys as gaps between neighbours, and the URL's scheme + host in a table.

base91 uses only ASCII that JSON does not escape (`"` and `\` are left out of the alphabet), so
every character costs exactly one byte of quota; it carries about 6.5 bits per character
against base64's 6. On a realistic 400-bookmark sample: 1.3.0's two documents 57 KB, version 1
of the compact copy 36 KB, version 2 31 KB.

The metadata's `version` says how to read the chunks: 1 is base64 with encoding version 1 (only
ever written by unreleased builds, still read), 2 is base91 with encoding version 2. **Bump it
whenever the format changes.** A version that does not recognise it treats the copy as still in
transit and waits ("the cloud copy was written by a newer version") instead of calling it
unreadable — which would make it overwrite the cloud with its own copy, unmerged, every round
until it is updated.

**Timestamps keep full millisecond precision.** If the decoded copy differed from the local
one by even a millisecond, the content fingerprints would never agree and two devices would
overwrite each other forever. For the same reason every upload decodes what it just encoded
and compares both fingerprints (bookmarks and layout); on a mismatch it uploads the plain
form instead (`{ v: 0, payload, layout }`, same envelope). Layout entries or sections the
encoder does not recognise are carried verbatim, so a newer version's additions survive.

The encoding needs the key, so **nothing is uploaded while locked** — including the first
upload when the cloud is empty, which older versions did from the stored ciphertext.
"Restore from the cloud to this device" therefore writes only the `VaultMeta`; the first
unlock reads the content from the cloud and stores it in the local format.

#### Moving off the 1.3.x format

Versions up to 1.3.x wrote two documents: `vaultSync` + `vaultSyncC…` (bookmarks) and
`vaultLayoutMeta` + `vaultLayoutC…` (layout). Both together and the new copy do not fit in
100 KB at once, so the switch is a cutover, not a dual write:

1. A newer version reads the old documents too and, while unlocked, merges them in.
2. When it pushes, it first checks that the new copy fits, then deletes the old documents,
   then writes the new one. If it does not fit, the old documents stay as they are.
3. A device still on 1.3.x cannot read the new copy. It sees "no cloud copy" and pushes its
   own in the old format; the next round on an updated device merges that and deletes it
   again. Nothing is lost (merging is per record), it just repeats until that device updates.
   Meanwhile the old device does not receive changes made elsewhere.

The new keys must not start with `vaultSyncC` or `vaultLayoutC`: 1.3.x deletes every key with
those prefixes as a stale chunk. The deletion marker (`vaultSyncGone`) is unchanged, so
deleting the vault still stops devices on either version.

Merging is per entry, newer `updatedAt` wins, regardless of what the entry contains — so
layout sections a version does not understand are kept and merged rather than dropped.

The upload checks that the copy fits in 100 KB minus a 1 KB reserve for the metadata and
minus what bookmark layout (below) currently uses plus 4 KB of headroom, and stops with the
usual over-quota warning if not.

### Syncing through bookmarks (opt-in, off by default)

`storage.sync` caps everything at 100 KB; at roughly 115 bytes per bookmark that is around
800 vault bookmarks. Options → *Sync through bookmarks* moves the chunks somewhere without
that cap: a bookmark folder, carried between devices by Firefox's own **bookmark sync**.
Only the metadata (about 1 KB) stays in `storage.sync`.

**Where the chunks live is a property of the cloud copy, not a per-device setting.** The
`vaultPack` metadata says so: `version: 3`, `store: 'bookmarks'` and the folder's id
(Firefox Sync keeps bookmark GUIDs, so the id is the same on every device). Every push
writes back to wherever the cloud metadata says; the local setting `vaultSyncBookmarks`
only decides where the *first* copy goes when the cloud has none. Otherwise two devices
could each believe the copy lives somewhere else and overwrite each other or never read
it. A copy kept in `storage.sync` is still written as `version: 2`, so people who never
turn this on do not need every device updated at once; a build that only knows version 2
sees version 3 as "written by a newer version" and waits.

The folder sits under Other Bookmarks: "書籤預覽：隱私空間的同步資料（請勿修改）" /
"Bookmark Preview: vault sync data (do not edit)", in the language of the device that
created it. Inside, one bookmark per chunk (`src/storage/bookmark-store.ts`):

- **Empty title.** Titles are matched by the address bar, and Firefox truncates them to
  4,096 characters anyway, so data goes only in the URL.
- **URL `data:,` + base32** (lowercase `a-z2-7`, no padding; `src/crypto/base32.ts`). Each
  chunk is a 1-byte chunk number plus up to 37,499 bytes of ciphertext: exactly 60,000
  characters, under Places' 65,536-character URL limit. base91 is not used here because
  Firefox rewrites some of its characters inside a `data:` URL. Not base64url either: `-`
  and `_` are word boundaries for the address bar, which matches only at word starts; with
  a letters-and-digits-only body, typing text from the middle of a chunk never brings these
  bookmarks up. **They do still come up** when the user types `data` (the scheme is a word
  start) or the first letters of a chunk (`aa…`, right after `data:,`) — verified on
  Firefox 153, see NEXT.md. A `javascript://` URL would be filtered out of the address bar
  entirely; that trade-off is an open decision.
- **Order comes from the chunk number, not the bookmark position** — a sync merge can
  reorder bookmarks. At most 256 chunks (about 9.6 MB of ciphertext).
- Reading checks chunk numbers 0..n−1 are all present, exactly as many as the metadata
  says, then the same digest as for `storage.sync` (over the reassembled base32).
- Writing updates the existing bookmarks' URLs in place (`bookmarks.update`, less sync
  traffic and no new GUIDs), creates any missing ones and removes extras. Chunks first,
  metadata last, as always.

Bookmark sync and `storage.sync` are two independent channels, so **metadata arriving
before the bookmarks is normal**. Until the chunks match the digest the copy is "still
arriving", and the usual rule applies: do nothing. Bookmark events do not fire
`storage.onChanged`, so the background also listens for bookmark events inside the folder
and schedules a sync with the same debounce.

Switching (`setSyncStore` in `src/background/vault-sync.ts`) requires the vault to be
unlocked and sync to be on, and first runs a normal sync; anything other than a completed
merge stops the switch with the reason (rewriting an unmerged cloud copy would overwrite
what another device added).

- **On**: write the bookmarks → write the metadata (version 3) → delete `vaultPackC*`.
- **Off**: first check the copy fits in `storage.sync`; if it does not, refuse with the
  size and leave the cloud copy alone. Otherwise write `vaultPackC*` → metadata → delete the
  folder last, so a failure half-way still leaves the metadata pointing at intact data.
- Ordinary pushes never delete the folder — only switching back, "Remove the cloud copy"
  and deleting the vault do. Deleting it on every push would let a device that has not yet
  received the new metadata delete the folder another device just wrote.

If the user edits the folder — deletes a chunk, changes a URL, moves the folder — the
digest no longer matches and sync reports the copy as still arriving. If the folder's id no
longer matches (cut and paste, export and re-import), it is found again by title under
Other Bookmarks. *Overwrite the cloud with this device* rebuilds it: missing chunks are
recreated, changed ones rewritten, extras (including subfolders someone put there)
removed.

The add-on hides the folder from its own views: the sidebar, the full-page view, search,
the Other Bookmarks count, the "Move to…" folder list, preview capture, the bookmark index
and grid layout (`src/background/sync-folder-guard.ts`). Reordering, grouping and
moving into the vault refuse it. Events inside it do not refresh the sidebar.
It does still appear in Firefox's own Bookmarks menu and Library; the options page shows
an example of what it looks like.

Not verified: two real devices with this switch on (only the bookmark-sync transport
itself was checked on two machines: a 60,006-character `data:` bookmark arrived intact,
same folder id). **Firefox for Android was not tested** for whether it syncs this folder;
even if it does, the metadata is in `storage.sync`, which Android does not sync, so a
phone cannot use it either way.

### Bookmark layout and groups sync too (on by default)

The native bookmarks' groups and pinned column counts (`grid:<folder guid>`, see
[interface.md](interface.md#groups-tags)) are copied to `storage.sync` under the same keys
(the order itself is Firefox's bookmark order and syncs with the bookmarks). They are plain
bookmark data, so this is **on by default** (Options → *Bookmark layout and groups*);
turning it off removes the cloud copies and keeps the local ones.

- Each folder is one item; the newer document wins (`updatedAt`, then `deviceId`). Firefox
  Sync keeps bookmark GUIDs identical across devices, which is what makes this work.
- A budget of **at most 20 KB** (`src/storage/grid-sync.ts`), and never more than what the
  vault copy leaves free. A folder whose document exceeds the 8 KB item limit stays local
  only; if all of them together exceed the budget, syncing layout stops entirely (cloud
  copies removed) and the options page lists the largest folders — the space stays with
  the vault. The vault, in turn, reserves only what these documents use now plus 4 KB, not
  the whole 20 KB (80 bookmarks' layout is a few KB; reserving 20 KB cost the vault about
  150 bookmarks).
- Remote removals never delete local documents (stopping because of the budget would
  otherwise wipe other devices).

Not verified with two real devices (a single profile cannot be two devices): checked that
the `grid:*` items in `storage-sync-v2.sqlite` are correct and that turning the option off
and on removes and re-uploads them. The 8 KB / 20 KB limits are covered by code only.

### Deletion

Deleting the whole vault leaves a **deletion marker** in `storage.sync`. Merely clearing
the cloud copy is not enough: another device seeing "no copy in the cloud" would push its
own up, and the device that deleted would pull the entire vault back on the next sync.

The marker only makes other devices **stop and ask**; it never deletes their data. A flag
from a remote source should not have the authority to destroy local data.

## Limits, stated plainly

- Firefox for Android does not sync `storage.sync` at all
  ([bug 1625257](https://bugzil.la/1625257)). That includes syncing through bookmarks:
  the metadata stays in `storage.sync`.
- The sync cycle is roughly 10 minutes.
- The master password is never synced.
- **An extension cannot tell whether the user is signed in to a Firefox Account.** There is
  no API; writes succeed while signed out, they just never leave the machine. So the
  settings page does not pretend to display "sync is active" — it shows the cloud copy's
  last-updated time and lets you judge.
- The entire `VaultMeta` is stored **in the clear** in the synced data (salt, KDF
  parameters, both key wrappers — a new device needs them to derive the key). The cost is
  that someone with access to that Firefox Account could brute-force the password offline.
  This is stated in the settings page too. The wrappers themselves are ciphertext, so
  storing the metadata in the clear does not leak bookmark contents.
