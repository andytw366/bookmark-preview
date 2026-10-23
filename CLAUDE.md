# CLAUDE.md

Bookmark Preview: a Firefox sidebar extension (React + Vite + TypeScript, Manifest V3
`sidebar_action`) that shows bookmarks as visual previews and keeps an AES-GCM encrypted
vault. Listed on AMO as `bookmark-preview@andytw366.github.io`.

## Work loop

- Done means `npm run verify` is green (typecheck, vitest, package, `web-ext lint`). A Stop
  hook runs `tsc --noEmit` when a turn changed TypeScript; the other three are on you.
- Behaviour in a real Firefox: the `firefox-e2e` skill (Xvfb + `scripts/ff.sh`, screenshots
  you can Read). Use it before calling a UI change done.
- User-visible text goes through `t()` / `tn()` and `public/_locales/*/messages.json`; the
  `i18n-batch` skill adds keys in both locales at once.
- Shipping a version (version bump in four files, AMO notes, source zip): the `release` skill.

## Before changing a subsystem, read its doc

| Changing… | Read |
|---|---|
| sync, merge, backup formats, anything in `src/shared/` that touches storage | `docs/architecture.md` (Invariants) and `docs/sync-and-backup.md` |
| the vault, its lock, keys or crypto | `docs/vault.md` |
| cover / thumbnail / site-icon selection | `docs/previews.md` |
| sidebar, full-page view, groups, keyboard | `docs/interface.md` |
| permissions or network requests | `docs/permissions.md`, then the AMO notes the `release` skill updates |
| build, locales, icons, headless testing | `docs/development.md` |

`NEXT.md` is the running log and to-do list: its top section is the current state, the rest is
history. Read the top; search the rest only when the user refers back to an earlier decision.

## Conventions

- Commits and PRs in English, prefixed like the log (`feat(sync): …`, `fix(vault): …`,
  `docs(next): …`, `chore: …`).
- Text an AMO reviewer reads (`amo/reviewer-notes.md`, `amo/permissions.md`) stays English;
  other docs keep whatever language the file is already in.
