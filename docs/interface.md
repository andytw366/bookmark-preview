# Interface

## Keyboard

The sidebar and the full-page view are both fully operable without a mouse.

| Key | Action |
|---|---|
| `Tab` / `Shift+Tab` | Move between the search box, the toolbar and the list |
| `↑` `↓` | Previous / next row (in the grid: the same **column**, one row up or down) |
| `←` `→` | Sidebar: go up a level / enter a folder. Grid: the adjacent card |
| `Backspace` | Go up a level (both views) |
| `Ctrl+Shift+←↑→↓` | Full-page view: move the focused card one cell (swapping with the card there); on a group's tag, move the whole group |
| `Home` / `End` | First / last item |
| `Enter` | Open the bookmark, or enter the folder |
| `Menu` key or `Shift+F10` | Open that row's or card's context menu |
| In a menu: `↑` `↓` `Home` `End` | Move between items (skipping disabled ones) |
| In a menu: `Tab` | Cycles within the menu; focus never escapes to the list behind it |
| `Escape` | Close the menu and return focus to the row that opened it |

The column count for arrow keys is **measured from the actual layout** (comparing each
item's `getBoundingClientRect().top`), not derived from the card-size setting — the grid's
column count changes with window width, and the configured width is only a `minmax` floor.
A single-column list naturally measures 1 column, which frees the left and right arrows for
entering and leaving folders.

Context menus are bound **only to the `contextmenu` event**; there is no separate keyboard
handler. The Menu key and `Shift+F10` already produce `contextmenu`, and that event is the
only place Firefox's native menu can be suppressed — calling `preventDefault()` on their
`keydown` was measured to have no effect, leaving our menu and the native one drawn on top
of each other. A keyboard-raised event carries no cursor position, so the element's own
bounds are used as the anchor instead.

For irreversible confirmations such as delete, **the default focus is "Cancel"**, not the
"Confirm" button that comes first visually. Otherwise pressing Enter on "Delete" in the
menu and then Enter again — two identical keystrokes — destroys something.

## Large collections

Lists and grids render **only the rows you can see**. For a folder of 3,000 bookmarks in
the full-page view, time from render to paint went from roughly 220 ms to 8 ms, and the
number of mounted thumbnail components from 3,000 to 32.

Measured before changing anything: the bottleneck really was rendering, not reading
thumbnails. 3,000 IndexedDB reads finish inside one second, while drawing 3,000 cards
costs 220 ms on its own — and that number is the same whether or not thumbnails exist,
because they arrive asynchronously afterwards.

Design decisions worth knowing:

- **Row heights are measured, not assumed constant.** In card mode covers use their own
  aspect ratio, so rows genuinely differ in height; assuming a fixed height makes the
  scrollbar length and the content position disagree. Unmeasured rows use an estimate,
  which only affects scrollbar length.
- **The unit of calculation is the row, not the item.** The sidebar has one item per row
  and the grid has N; once the column count is resolved by the caller, both views share
  one implementation (`src/sidebar/lib/virtual.ts`).
- **The grid's column count comes from the container width**, not from measuring rendered
  elements — it has to be known *before* deciding which rows to render, so the `auto-fill`
  rule is applied directly.
- **Spacing uses `padding`, not empty placeholder elements.** The list has a `gap`; two
  empty divs would add two extra gaps.
- **Thumbnails are cached** (`src/sidebar/lib/thumb-cache.ts`). Scrolling mounts and
  unmounts the same rows constantly; without a cache every row you scroll back to flashes
  its colour card before the image returns. The cache holds a use count so an item
  currently on screen is never evicted — revoking an object URL that is still displayed
  produces a broken image.

The search result cap was raised from 300 to 5,000 as a result. It was not removed
entirely, but its purpose changed: search walks the whole tree and a single character can
match every bookmark, so the cap now only keeps the result array from growing unbounded.

Keyboard navigation still covers the whole list after virtualisation: `End` jumps to the
genuinely last item, not the last rendered one — if the target has not been rendered yet,
it scrolls there first and then moves focus.

## The bottom toolbar

The toolbar originally mixed three different kinds of thing with no hierarchy: preferences
you set once (preview source, density), actions (backfill, full-page view, select), and up
to three lines of transient status text. Five controls plus wrapping text crammed into a
320px column produced something with no discernible focus.

It is now three layers:

- **Frequently used stays visible** — density (genuinely toggled while browsing; switched
  to icons because the three labels are nine CJK characters, nearly a third of the width
  on their own), plus "Full page" and "Select".
- **Occasionally used moves into an overflow menu (`⋯`)** — preview source and backfill.
  Set-once or press-rarely items do not deserve permanent width. The active source is
  ticked.
- **Status text occupies one line**, showing only the most important message by the
  priority "in progress → just finished → background diagnostic", and it sits **above** the
  control row. Below, every message appearing and disappearing would shove the controls up
  and shift the list with them.

The main toolbar deliberately **does not wrap** (wrapping makes its height jump with
content); only the multi-select row wraps, because the width of "N selected" changes with
the number.

## The full-page view

"Full page" at the bottom of the sidebar opens a standalone page in a new tab that lays
bookmarks out **side by side** across the whole window. No amount of adjustment gets the
sidebar past 320–420px, which fits exactly one column; taking in dozens of covers at a
glance needs the whole window.

Column count follows CSS `auto-fill` + `minmax` with the window width — no breakpoints —
and card size has three steps. The tree index, search and thumbnail loading are all reused
from the sidebar rather than rewritten; once search or thumbnail-fallback behaviour forks,
the two start drifting apart.

Clicking opens **a new tab** by default (loading in the current tab would replace the
browsing view itself); Ctrl+click opens in the background. The context menu is literally
the sidebar's (`RowMenu` is reused).

### Back and up

"Back" and "up a level" are two different things, and the full-page view has both:

| | Goes to | Triggered by |
|---|---|---|
| Back | The folder you were **just in** (after a breadcrumb jump that is not the parent) | The browser's Back, `Alt+←`, the mouse back button |
| Up a level | The **parent** folder | `Backspace`, the `↑` in front of the breadcrumb |

Every folder change you make (card, breadcrumb, `↑`, `Backspace`, switching between bookmarks
and the vault) is a `history.pushState`. Typing in the search box is not — one entry per
keystroke would make Back useless. When the folder you are in disappears (deleted elsewhere)
the view falls back to the top level with `replaceState`, so Back never returns to a folder
that no longer exists.

**Bookmarks** carry the folder in the address: `#folder=<guid>`. Reloading, or saving that
address and opening it later, lands in the same folder. A folder's context menu (sidebar and
full-page view) has "Open in full page", which opens a tab at that address.

**The vault leaves nothing in the address or in `history.state`.** Firefox's session restore
writes every tab's history entries — URL and state — to disk, so a folder id or even a "vault"
flag there would undo `vaultEntry: 'hidden'`. A vault entry stores only a random token
(`{ n: '<uuid>' }`) with no hash; the token → folder table lives in memory and is cleared on
lock. Going back to a token the page does not recognise (locked since, or the page was
reloaded) lands on the top level of the bookmarks — never on the unlock prompt, which would
admit the vault exists. Vault folders have no "Open in full page" for the same reason.
Logic and tests: `src/sidebar/lib/gallery-history.ts`.

The sidebar has no history to go back through. It listens for the mouse back button
(`mouseup` with `button === 3`) as "up a level" in both spaces, but **on Linux Firefox never
delivers that button to page content** — GTK turns buttons 8/9 into a browser Back command,
which navigates the active tab instead. Whether other platforms deliver it is unverified.

### Layout

Cards are always packed left to right, top to bottom — **no gaps**. Dropping a card makes
the following cards move up one place; taking one away closes the gap. The column count
follows the window width (*Auto (N columns)* in the toolbar) until you press `−` / `+`;
then it is pinned for that folder, cards keep their size (small / medium / large) and the
grid scrolls sideways when the window is too narrow. *Automatic layout* unpins it again,
also when the folder has groups. While dragging, an extra empty slot after the last card
is the "put it at the end" target. Search results and Firefox's top-level folders have no
groups and cannot be dragged.

`src/shared/grid.ts` (order, insertion, outline edges, arrow keys) and
`src/shared/board.ts` (groups and every operation) are pure functions with tests; both
spaces run the same `applyOp` in the background page, the page only sends *what* to do.

### Drag and drop

| Drop on | Result |
|---|---|
| The left or right ~30% of a card | Insert before / after it; the rest move along |
| The middle of a folder card | Move into that folder |
| The middle of a bookmark card, held ~400 ms (dashed frame) | A small menu: *Create group* (default, Enter) / *Create folder*; Esc cancels. On a group member it joins that group directly |
| The empty slot after the last card | Move to the end |
| A breadcrumb segment | Move up to that level |

While the pointer is in the gap between cells the last hint stays and a drop does what it
showed. Dragging a checked card while selecting moves the whole selection, in order. Data
updates arriving mid-drag are held until you let go. Dragging close to the top or bottom
edge scrolls.

Keyboard: arrow keys move between cards. `Ctrl+Shift+arrow` moves the focused card one cell
(swapping with the card there); the context menu has *Move left / right*. Focus follows
the card.

**Bookmarks**: the order *is* Firefox's own order (`bookmarks.move`, only the bookmarks
whose relative order changed — longest increasing subsequence), so the bookmarks menu and
library match, and the order syncs with the bookmarks. A bookmark card dragged onto the tab
strip opens it. Firefox's `index` for `move` is the **final** position after removal;
`src/background/bookmark-order.ts` computes for that and re-checks.

**Vault cards carry no URL in the drag data at all** — dropping one on the tab strip would
open it in a normal window and write it to history. Only an internal type is set.

### Groups (tags)

A group is a **consecutive run** of bookmarks in one folder (in reading order), drawn as a
coloured outline — a staircase shape where it wraps — with a small tag on the first member:
the name, or just a colour chip for an untitled group. **A named group is a tag**: names are
unique per folder (trimmed, case-insensitive). A bookmark belongs to at most one group;
folders never do.

| Action | How |
|---|---|
| Create | Drop one bookmark on another, hold → *Create group* (the dragged card goes right after the target); select bookmarks → *Frame as group* (gathered at the first one's place) |
| Join | Drop **inside the outline** — on a member's edge or middle; *Set tag…* (appended to the group) |
| Leave | Drop anywhere outside the outline (next to it does not count); *Remove from group* (a member from the middle is moved out after the group) |
| Move the group | Drag the tag onto a card edge, the end slot, a folder card or a breadcrumb — the other cards make room; `Ctrl+Shift+arrow` on the tag (jumps over a whole neighbouring group), or *Move left/right* in its menu |
| Tag menu (click, Enter, right-click) | Rename, colour, move, *Turn into folder* (a subfolder in the first member's place), *Dissolve* |
| Folder context menu | *Flatten into a group*: its bookmarks take the folder's place as a group with its name (refused if it contains folders) |

Nothing that is not a member can be inserted into the middle of a group: the drop point is
pushed to the group's start or end, whichever is nearer, so a group always stays one run.
Each cell draws its own part of the outline (`outlineEdges`: a side is drawn when the
neighbour is not in the same group), extending 8px into the gap so neighbours join.

**Bookmarks** keep one document per folder under `grid:<folder guid>` in `storage.local`
(`{ v, columns, groups: [{ id, name, color, members }], updatedAt, deviceId }`, `columns: 0`
= automatic) and **sync it by default** through `storage.sync` under the same key (see
[sync-and-backup.md](sync-and-backup.md)). Members this device does not have yet are kept.
Deleting or moving bookmarks elsewhere is cleaned up via `bookmarks.onRemoved/onMoved`,
through the same serial queue as the operations. The sidebar does not show groups yet.

**Vault** columns and groups live in the encrypted layout document (see
[vault.md](vault.md#groups)).

### The top toolbar

Both modes (bookmarks / vault) share one set of rows in fixed positions:

1. Title / search / card size / more options (`⋯`)
2. Scope switch / select / mode-specific actions ("New folder" and "Lock now" only in the
   vault)
3. Multi-select row (only while selecting): count / select all / actions / cancel

"Select" used to be on row 1 in bookmark mode and row 2 in the vault, so the two modes
looked different. The current mode's selection state and actions are now collapsed into one
set of values in code, so that row never has to branch on the mode — writing the ternary
once per button was exactly how the two sides drifted.

**Feature parity with the sidebar is structural, not remembered.** Preview source and
backfill live in `⋯` using **the same component** (`PreviewOptionsMenu`) and the same state
hook (`useBackfill`, including progress and the capture diagnostic line). Sharing is not
just about saving code: it makes "neither side may be missing a feature" a property of the
structure rather than something to remember on every change — the full-page view was
originally missing the whole group. Which side backfill targets is decided by the current
mode.

Multi-select check marks overlay the corner of the thumbnail rather than taking their own
line, so card heights stay uniform and the grid stays aligned.

**The vault is reachable here too**, by the same entrance: type the trigger string into the
search box and the same password screen appears. The bookmarks/vault switch only appears
after unlocking; before that, in hidden mode, this page shows no trace of it either.

`useVault` maintains a keepalive connection to the background page while unlocked. It
sends a heartbeat every 15 seconds, which is what actually keeps the MV3 event page alive —
an idle port alone does not (measured on Firefox 153: the event page was still reclaimed
after 30–50 seconds, and the key went with it). When the tab closes the port drops, and if
no sidebar is open either, the vault locks.

The same port carries a second, distinct message: `activity`, sent when the user actually
does something (pointer down, key down) **while the vault view is in front**. That is what
drives the "lock after N minutes idle" deadline. The heartbeat deliberately does not count —
see [vault.md](vault.md#getting-locked-back-out) for why keeping those two separate matters.

Worth remembering that this is a **window-sized** view of your private bookmarks. Where
others can see the screen, use "Lock now" or just close the tab.
