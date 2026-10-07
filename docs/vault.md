# The vault

An encrypted bookmark space behind a master password. Bookmarks moved into it are
**removed from Firefox's bookmark manager, toolbar and menu**; they exist only as
ciphertext until you unlock. Their preview images are encrypted too.

## Getting in

**Type a trigger string into the search box** (default `###`) and a separate password
screen appears.

The first design typed the master password straight into the search box. But the search
box renders in plain text, so anyone next to you could read it — which is far worse than
someone learning the vault exists, because a leaked password cannot be undone. With a
trigger string, only the trigger enters the search state; the password goes into a real
`type="password"` field.

If no vault exists yet the same trigger opens the **create** screen (password, confirm,
and an acknowledgement that loss is unrecoverable); otherwise it opens the **unlock**
screen. Both reuse `VaultGate` rather than being written twice — the irreversibility
warning must not be weakened by a second implementation drifting from the first.

**The trigger string is configurable, and changing it is recommended.** This is not just
convenience, it is part of the security: the default is public, so anyone who knows it can
type it once and tell from the resulting screen whether this machine has a vault ("unlock"
versus "create"). With a string only you know, that inference has nowhere to start.
Setting it empty disables this entrance.

Matching is **exact**, not prefix — otherwise any ordinary search beginning with the
trigger would pop the screen open mid-typing. It is also case-sensitive, since the trigger
may well be an ordinary word.

**The entrance is hidden by default.** A visible "Vault" tab by itself reveals that you
have something to hide, which defeats the purpose. In the default state the sidebar shows
no trace of it — no tab, no button. Creating the vault and switching the entrance mode
live in the settings page, not in the sidebar.

A wrong password **does show an error**. The earlier silent failure was camouflage (it
looked like a search returning nothing), but once the user has deliberately opened a
password screen there is nothing left to hide, and silence just leaves them unsure whether
it worked.

> Implementation trap: a `type="password"` input **must not sit inside a `<form>`**.
> Submitting the form triggers Firefox's "Save password?" prompt, which both displays on
> screen and files the master password in the password manager. The search box therefore
> no longer uses a form; Enter is handled in `onKeyDown`.

## Getting locked back out

Three triggers, whichever comes first (`src/background/vault-lock.ts`):

| Trigger | What it measures |
|---|---|
| **Time since you last used the vault** | The setting "lock after N minutes idle". The primary one. |
| **You left the machine** | `browser.idle` — no keyboard or mouse input anywhere on the computer for the same N minutes. |
| **The last extension page closed** | The keepalive port count reaching zero. The full-page view and the settings page count as open. |

The first of those is the one that carries the weight, and it was **missing until
2026-08-07** — auto-lock was wired only to `browser.idle`. That sounds equivalent but is
not: `browser.idle` asks whether *the computer* is idle, not whether the vault is. Keep
using your machine — read another tab, watch something, type in another app — and it never
fires, so an unlocked vault stayed unlocked indefinitely. A full-page tab left open in the
background made it worse, because its heartbeat deliberately stops the event page from
being reclaimed, removing even the accidental protection of losing the key to a reclaim.

What counts as "using the vault" is deliberately narrow, because getting it wrong in either
direction is invisible:

- **The 15-second heartbeat does not count.** It fires whether or not anyone is there; if it
  reset the deadline, the deadline would never arrive.
- **Reads do not count.** When `vault-sync` picks up a remote change it broadcasts
  `vault/changed`, and every open page re-reads `vault/list` and `vault/folders` in
  response. Counting those would let another device's sync hold this one unlocked forever.
- **Pointer and key events count only while the vault view is in front** — browsing ordinary
  bookmarks in the sidebar is not using the vault.

`tests/vault-autolock.test.ts` pins all three of those as static checks, since none of this
module can be unit-tested (it needs `browser.*`) and every one of these mistakes is silent.

## The keyring

The original design had the password-derived key encrypt the data **directly**, which made
two things impossible: recovering from a forgotten password (the backup file used the same
password, so having a backup did not help), and changing the master password without
re-encrypting everything. There is now a data key in between (`src/crypto/keyring.ts`):

```
master password ──PBKDF2(600k)──→ KEK(password) ──wraps──→ ┐
                                                           ├─→ DEK ──encrypts──→ bookmarks + thumbnails
recovery key ────HKDF───────────→ KEK(recovery) ──wraps──→ ┘
```

Both keys wrap the same DEK; either one opens it. **The verifier field was removed as a
result** — "this 32-byte wrapper does not open" *is* the answer to "was the password
wrong", and it is cheaper than decrypting the whole bookmark set. One less field is one
less thing that can fall out of sync with the actual key.

## The recovery key

160 random bits, Crockford base32, formatted as 8 groups of 4. The alphabet
**deliberately excludes I, L, O and U**: the first three are confusable with 1 and 0, and
this string exists to be written on paper and typed back months later. Input is forgiving
about case and separators, and maps `I`/`L` to `1` and `O` to `0`.

HKDF rather than PBKDF2: a high iteration count exists to protect **low-entropy**
human-chosen passwords and is meaningless for a 160-bit random value.

It is **generated and shown once, mandatorily**, at vault creation, and you must tick "I
wrote it down" to continue. Made optional, almost nobody would set one — and the people
who forget master passwords are exactly the people who would not have opted in. The code
is also stored encrypted under the DEK so it can be shown again later; this weakens
nothing, since reading it requires the DEK, and anyone holding the DEK can already see
everything.

**Metadata-only changes must still be pushed to the cloud.** Changing the master password
and regenerating the recovery key only re-wrap keys and never touch a single bookmark, so
the content fingerprint is unchanged. Comparing fingerprints alone would mean those two
operations never sync — other devices would keep accepting the old password, and a revoked
recovery key would keep working.

## When both keys are gone

"Locked and the master password forgotten" used to be a dead end: deleting required
unlocking, so you could neither get in nor clear it out. There is now **"Give up the vault
on this device"**, which does not require unlocking.

The door it removed was meant to stop someone wiping your data while you are away — but
anyone with access to the machine can already delete the extension's storage directory.
In practice it only ever blocked accidents, while locking out the people who genuinely
needed a way out. It leaves the synced copy alone: this device being unable to open it
does not mean another one can't.

## Folders

The vault has its own folders: create at the current level, navigate with breadcrumbs,
move bookmarks in via the context menu.

**Deleting a folder moves its contents up one level instead of deleting them.** This
deliberately differs from native bookmarks, because the vault has no undo — one mis-click
would need a backup file to recover from. A few people will press delete one extra time;
nobody will lose data.

Folders can be moved (context menu or multi-select). Moving one into itself or into its
own descendant is blocked — that produces a cyclic `parentId`, after which navigation and
breadcrumbs can never get back out. The UI blocks it first (the picker omits your own
subtree) and the background page's `isWithin` check is the second line.

## Order

Vault folders can be rearranged in the full-page view (drag, or *Move left / right*; see also [Groups](#groups)).
The order lives in a separate encrypted **layout** document (`src/shared/vault-layout.ts`),
not on the bookmark records: an older version rebuilding records field by field would drop
an unknown `order` field during sync, and the two devices would then disagree forever about
the content fingerprint.

The layout is a set of sections of `id → entry`, each entry carrying its own `updatedAt`;
the `order` section has one entry per folder holding the complete list of that folder's
children. Items not in the list (never arranged, added by an older version, moved in from
elsewhere) follow it in the default order — folders by name, then bookmarks newest first —
so a folder nobody has rearranged looks exactly as before. The UI and the background page
compute the order with the same function (`vaultChildren`), because a drop is sent as
"before this card" and both sides must agree which card that is.

Stored locally as `vaultLayout` (+ its fingerprint), encrypted with the data key; removed
together with the vault. Decryption failure on unlock yields an empty layout rather than a
failed unlock — the order is not worth locking anyone out over.

## Groups

Vault layout and groups are three sections of the encrypted layout document:

- `grid` — `{ folderKey: { columns, updatedAt } }`, the column count pinned with `−` / `+`
  (see [interface.md](interface.md#layout)); `columns: 0` is the tombstone for "back to
  automatic". There are no gaps, so the order is just the `order` section, which keeps being
  written in display order (a phase-2 device sees the same order).
- `groups` — `{ id: { folderId, name, color, pinned?, updatedAt, deleted? } }` (`pinned` = colour picked by the user) (older entries may
  still carry `collapsed`; it is ignored). Groups that lose their last member get a
  tombstone rather than being removed, so an older copy elsewhere cannot bring them back.
- `groupOf` — `{ recordId: { groupId | null, updatedAt } }`. Membership only counts when
  the group's folder is the record's current folder, so moving a bookmark out of a folder
  needs no write here.

All merge with the generic per-entry rule, travel with sync and backups, and are never
stored in plaintext — group names are as private as the bookmarks. Only entries that
actually changed are rewritten, so an unchanged entry does not win a merge against another
device's edit.

## Whole folders move in and out, structure intact

Pressing the lock icon on a bookmark folder (or "Move the whole folder into the vault")
moves the entire subtree; in the other direction, "Move the whole folder out" rebuilds the
subtree in native bookmarks. The confirmation shows the **real counts** ("2 folders, 6
bookmarks") — the action is irreversible, so that number is what you judge by.

The two directions are mirror images, and this is the most important part of the feature:
moving in **persists the encrypted data first and calls `removeTree` last**; moving out
**creates the native bookmarks first and writes the tombstone last**. The invariant is
that at every instant the data exists intact on at least one side.

The transformation rules themselves (preserve hierarchy, recreate empty folders, skip
`place:` smart bookmarks) are pure functions in `shared/vault-subtree.ts`, pinned by
tests. Getting them wrong makes an entire subtree of bookmarks disappear, which is not
something to establish by reading the code.

**Firefox's built-in root folders** (Bookmarks Menu / Bookmarks Toolbar / Other Bookmarks)
cannot be moved in: they are permanent and `removeTree` fails on them. The root level
therefore shows no lock icon and no "move in" menu entry — better to withhold the entrance
than to let someone press it and read an error.

## Multi-select

The toolbar's "Select" enters multi-select. Checked items can be moved to another folder,
or moved into the vault (the latter needs an unlocked vault). **Selection survives folder
navigation**, so you can pick a few items from several folders and handle them in one go.

**Folders are selectable too, and clicking the row selects rather than navigates** (same
as bookmarks). The check mark overlays the corner of the thumbnail instead of taking its
own column — putting it in the row's flex flow widened every row, and added a whole extra
line in card mode.

Navigation for a selected folder moves to a `›` button (right of the row in the sidebar,
top-right of the card in the full-page view). Cross-folder selection is the point of the
feature, so folders must stay enterable; but "clicking a folder only ever enters it, with
no way to select it" is equally unintuitive, so the two actions get their own targets.
That button must be a **sibling** of the row, not a child — nested `<button>` is invalid
HTML.

A checked folder moves in **with everything inside it**; the button is only disabled when
the selection contains no bookmarks at all. Switching tabs (bookmarks ↔ vault) exits
multi-select first, since a selection from one side leaves a row of inapplicable actions
on the other.

Batches run **item by item**, not "write everything then save once" — each item keeps the
"encrypt first, remove the native bookmark second" order, or a mid-batch failure would
lose bookmarks outright. One failure does not abort the rest.

"Select" is always available: moving bookmarks between folders needs no key, so it is no
longer a vault-only feature and its presence reveals nothing.

## The confirmation appears next to what you clicked

Not at the top of the list. It used to be an inline banner above the list, so clicking the
lock icon on a row far down a long list put the confirm button off-screen — you had to
scroll back to the top to press "Move in". Single items anchor to that row's lock icon;
batches anchor to the toolbar button, which is pinned to the bottom and cannot scroll away.
