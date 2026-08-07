# Development

```bash
npm install
npm run build
```

Load it in Firefox: open `about:debugging#/runtime/this-firefox` → "Load Temporary
Add-on" → pick `dist/manifest.json`.

After changing code, run the full check — all four steps must pass:

```bash
npm run verify        # typecheck + tests + package + web-ext lint
```

Watch mode rebuilds on save; press "Reload" in `about:debugging` to pick up the change:

```bash
npm run watch
```

If Firefox is installed locally, web-ext can launch a clean test profile for you:

```bash
npm run start:firefox
```

Other scripts: `npm run typecheck`, `npm run lint:ext`, `npm run package`.

The sidebar opens automatically on install (`open_at_install`); after that use
`Ctrl+Shift+Period`, the switcher in the sidebar header, or `View → Sidebar`.

## Icons

`assets/icon.svg` is the single source. Regenerate the PNGs after changing it:

```bash
./scripts/icons.sh    # needs librsvg2-bin
```

The SVG deliberately lives outside `public/` so it does not end up in `dist/` as a file
nothing references.

## Why there is no toolbar button

The first approach declared an `action` and called `sidebarAction.toggle()` from
`action.onClicked`. Measured on Firefox 153 (confirmed with multiprocess console
logging): **clicking that row in the extensions panel does not dispatch
`action.onClicked`** — no log, no error, the handler is simply never called.

It now uses Firefox's built-in `commands._execute_sidebar_action`, handled by Firefox
itself. That needs no background code and is not subject to the "`toggle()` must be called
synchronously inside a user-gesture handler" restriction. A piece of unverifiable code was
deleted in favour of a built-in mechanism that demonstrably works.

The `Ctrl+Shift+Period` shortcut is also a measured result, arrived at in two steps. The
original `Alt+Shift+B` collided with GTK menu-bar mnemonics on Linux — `Alt+B` opens
Firefox's Bookmarks menu and the sidebar never appears. Its replacement, `Ctrl+Shift+L`,
works, but it is the default autofill shortcut for several password managers; when two
extensions want the same combo Firefox gives it to whichever registered first and tells
nobody, so for some users the shortcut simply did nothing. `Ctrl+Shift+Period` is not
claimed by Firefox itself and is far less contested. Users can rebind it under
`about:addons` → gear → "Manage Extension Shortcuts".

**A changed `suggested_key` does not reach existing installations.** Firefox records the
binding in the profile when the extension is first installed; editing the manifest
afterwards leaves that profile on the old key. So this change only affects fresh installs,
and testing it requires a fresh profile — on a kept profile the *old* shortcut keeps
working and the new one appears dead, which looks exactly like the bug being fixed.

## Testing on Windows

The project runs inside a Docker container whose `/workspaces` is a Docker volume, not a
bind mount from Windows or WSL, so the files have no Windows path and the package has to be
copied out.

```bash
npm run package       # → web-ext-artifacts/bookmark-preview-vault-1.0.0.zip
```

Then either right-click the `.zip` in VS Code's explorer → "Download…", or from PowerShell:

```powershell
docker cp <container-id>:/workspaces/firefox_plugin/web-ext-artifacts/bookmark-preview-vault-1.0.0.zip $HOME\Downloads\
```

Load it in Windows Firefox at `about:debugging#/runtime/this-firefox` → "Load Temporary
Add-on" → select the `.zip` directly (both `.zip` and `.xpi` are accepted; no need to
unpack).

Temporary add-ons disappear when Firefox closes and must be reloaded each time. That is
Firefox's rule for unsigned extensions, not a misconfiguration. To keep one installed, either
get it signed through AMO, or use Firefox Developer Edition / Nightly with
`xpinstall.signatures.required` set to `false`.

If you iterate on Windows often, developing there directly is less tedious: install
Node.js, keep the source on the Windows filesystem, and point at `dist/manifest.json`
after `npm run build`.

## Headless testing inside the container

The container has no display, but Firefox can run for real under Xvfb and be screenshotted.
Everything goes through `scripts/ff.sh`:

```bash
./scripts/ff.sh start
```

That starts Xvfb (`:99`) and a Firefox loading `dist/` in the background, waiting until the
window actually appears. Underneath is `scripts/test-headless.sh`, which creates a clean
profile seeded with bookmarks (nested folders, CJK names, and a `place:` smart bookmark
that should be filtered out). The system packages and Firefox tarball needed the first time
are documented in that script's header.

- `KEEP_PROFILE=1` keeps the existing profile. Note that the seed bookmarks are re-imported
  on every start, and the import **replaces** rather than appends.
- `SEED_BULK=3000` adds a folder of 3,000 bookmarks, for measuring list performance.

Subcommands chain, and screenshots land in `.test-shots/`:

```bash
./scripts/ff.sh click 120 220 type '###' wait 2 sidebar gate
```

Available: `start stop alive click rclick move scroll type key wait shot sidebar crop zoom
trigger unlock`. Full usage is in the script's header comment; a coordinate cheat-sheet and
the accumulated traps are in `.claude/skills/firefox-e2e/SKILL.md`.

`scripts/store-shot.sh` crops a full-window screenshot to the 1280×800 the AMO listing
wants, removing the container-only "sandbox disabled" notification bar.

### Traps worth knowing

- **Use `./scripts/ff.sh stop` to clean up.** Not `pkill -f firefox` (the script's own path
  contains "firefox", so it kills itself) and not `pkill -x firefox` (**the process is
  named `firefox-bin`**).
- **Use the official Firefox tarball.** Ubuntu 24.04's apt package is a snap shim that will
  not start in a container. The container also cannot create user namespaces, so
  `MOZ_DISABLE_CONTENT_SANDBOX=1` is required.
- **Granting `<all_urls>` does not require the permission doorhanger** (a XUL popup that
  synthetic clicks cannot reach): `about:addons` → Extensions → this add-on → "Permissions
  and data" → flip the toggle.
