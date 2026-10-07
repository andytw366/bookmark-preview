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
so the 100 KB quota limits **how much can sync**, not how much can be stored.

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

### The layout syncs separately

The order of items in vault folders is a second encrypted document with its own keys
(`vaultLayoutMeta` + `vaultLayoutC0…`), synced right after the bookmark copy with the same
four rules: nothing while in transit, merge only while unlocked, content fingerprint
decides uploads. It carries the salt to prove it belongs to the same vault.

It is **not** inside the bookmark copy, and its keys deliberately do not start with
`vaultSyncC`: an older version's stale-chunk cleanup deletes every key with that prefix,
and an older version rebuilding records field by field would strip anything it does not
know — after which the two devices' fingerprints never agree and they overwrite each other
every two seconds. Old versions simply never touch the layout keys.

Both documents share the 100 KB quota, so each upload checks that it fits **together with
what the other one currently occupies**, and stops with the usual over-quota warning if not.
An older version does not know the layout exists and checks only its own size; near the
limit it can fail its upload with a quota error. "Remove the cloud copy", deleting the
vault and "overwrite the cloud" all clear the layout keys too.

Merging is per entry, newer `updatedAt` wins, regardless of what the entry contains — so
sections a version does not understand (groups, from phase 3 on) are kept and merged
rather than dropped.

### Deletion

Deleting the whole vault leaves a **deletion marker** in `storage.sync`. Merely clearing
the cloud copy is not enough: another device seeing "no copy in the cloud" would push its
own up, and the device that deleted would pull the entire vault back on the next sync.

The marker only makes other devices **stop and ask**; it never deletes their data. A flag
from a remote source should not have the authority to destroy local data.

## Limits, stated plainly

- Firefox for Android does not sync `storage.sync` at all
  ([bug 1625257](https://bugzil.la/1625257)).
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
