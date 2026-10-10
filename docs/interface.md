# Interface

## Keyboard

The sidebar and the full-page view are both fully operable without a mouse.

| Key | Action |
|---|---|
| `Tab` / `Shift+Tab` | Move between the search box, the toolbar and the list |
| `↑` `↓` | Previous / next row (in the grid: the same **column**, one row up or down) |
| `←` `→` | Sidebar: go up a level / enter a folder. Grid: the adjacent card |
| `Backspace` | Go up a level (both views) |
| `Ctrl+Shift+←↑→↓` | Full-page view: move the focused card one cell (the others make room); on a group's tag, move the whole group |
| `Ctrl+Shift+↑↓` | Sidebar: move the focused row up / down one place; on a group's tag, move the whole group |
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

- **Row heights are measured, not assumed constant.** Previews sit in fixed plates, but
  folder rows, group title rows and long titles still make rows differ in height; assuming
  a fixed height makes the scrollbar length and the content position disagree. Unmeasured rows use an estimate,
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

## Look and shared components

The redesign (1.3.0, handoff and boards in `bookmark-preview-ui/`) aims for "a panel that
belongs to Firefox": system font, neutral cool greys, one blue accent. Every colour, size,
radius and shadow is a CSS variable in `src/ui/tokens.css` (light values, dark values under
`prefers-color-scheme`); components only reference variables. Shared pieces live in `src/ui/`:
`IconButton` / `Button`, `SegmentedControl`, `Menu` + items (radio, switch, header,
separator), the checkbox / radio / switch marks, `Toast` and the 16px `Icon` set.

Rules the design depends on:

- **The accent has four uses only**: current selection, at most one primary button per
  screen, the keyboard focus ring, text links. Segmented controls show the selected segment
  as a raised surface, not in blue.
- **Red is for irreversible actions** (delete, clear, regenerate the recovery key, delete
  the vault) and is always the last group in a menu; in settings they sit in *Danger zone*.
- **Text is single-line with an ellipsis** everywhere — English strings run 1.5–2× longer.
- **Every preview sits in the same plate**: 16:9 for sidebar cards, 4:3 in the full-page
  view, 40×40 in the row list. The plate fixes the size; the image only decides how it
  fits — covers `contain` (never cropped), screenshots `cover` from the top, site icons
  centred at about a third of the width with 20% corners, letter cards filled with one of
  eight colours picked from the domain (all ≥ 4.5:1 against white, tested).

## The bottom toolbar

One 40px row of 28px icon buttons, each with a tooltip: density (segmented: cards / rows /
text) | Select, Full page … `⋯`. Text buttons would overflow 240px in English.

- **Occasionally used things live in `⋯`**: preview source (radio), site icons for home
  pages (switch), fetch missing previews (with progress on the right while it runs),
  Settings…, and — only on the vault tab — *Delete the whole vault…* as the last, red group.
- **Backfill status no longer occupies a line.** While it runs, a 2px progress bar runs along
  the top edge of the toolbar; when it finishes a toast floats above the toolbar for three
  seconds (paused while hovered) with *Show missing*, which lists the bookmarks that still
  have no preview (`BackfillReport.missing`). Notices from menus use the same toast.
- **While selecting**, the row becomes: exit `✕` · "N selected" … `⋯` (secondary actions such
  as *Move into the vault* / *Move out to…*) · the primary action. *Select all (N)* is a
  tri-state checkbox at the top of the list; check boxes sit left of the thumbnail instead
  of covering it.

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
| Up a level | The **parent** folder | `Backspace`, the back-arrow button before the breadcrumb |

Every folder change you make (card, breadcrumb, the up button, `Backspace`, switching between bookmarks
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
follows the window width (*N columns · auto* in the toolbar) until you press `−` / `+`;
then it is pinned for that folder, cards keep their size (small / medium / large) and the
grid scrolls sideways when the window is too narrow. *Auto* next to the count unpins it again,
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
(the others make room); the context menu has *Move left / right*. Focus follows the card.

**The sidebar** does the same with one column: the edges are the top and bottom ~30% of a
row (`dropIntent(…, 'vertical')`), the drop hint is a line between rows, and there is no end
slot (drop on the last row's lower edge). `Ctrl+Shift+↑↓` and *Move up / down* in the context
menu move a row one place, joining a group when it lands next to a member and leaving it when
it steps past the last one (`listNudge`). Search results and Firefox's top level cannot be
rearranged, the same as in the grid. It is the same hook (`useGridDrag` with `axis` and
`scroller`) and the same messages, so the rules cannot drift apart.

**Bookmarks**: the order *is* Firefox's own order (`bookmarks.move`, only the bookmarks
whose relative order changed — longest increasing subsequence), so the bookmarks menu and
library match, and the order syncs with the bookmarks. A bookmark card dragged onto the tab
strip opens it. Firefox's `index` for `move` is the **final** position after removal;
`src/background/bookmark-order.ts` computes for that and re-checks.

**Vault cards carry no URL in the drag data at all** — dropping one on the tab strip would
open it in a normal window and write it to history. Only an internal type is set.

### Groups (tags)

A group is a **consecutive run** of bookmarks in one folder's order, drawn as **one
connected block** with a coloured outline (1.5px, the group colour at 8% as fill) and a
title row on its top edge: the tag (the name, or just a colour chip for an untitled group),
the member count, and a `⋯` that appears on hover or focus. The tag carries no `▾` so it is
not mistaken for a tag picker. **A named group is a tag**: names are
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

**Placement on screen** (`layoutGrid` in `board.ts`) is computed from the order and the
column count every time: cards go into the next free cell; a group fills what is left of
its row and the remaining members continue on the next row **directly underneath**
(starting in the same column where possible, extending left otherwise, always overlapping
the part above), so the group never splits at a row end. Later cards flow into the free
cells around it. Order and screen position therefore differ; drops are converted back
(`orderIndexAt`), and arrow keys / `Ctrl+Shift+arrow` follow what is on screen.
**Outline**: each group is drawn as **one SVG path** in a layer under the cards
(`GroupOutlines`). It measures the rendered member cells, grows each by 6px, bridges the
gaps between neighbouring members (and the cross-shaped gap inside a 2×2 block), takes the
union and traces its boundary, then rounds every corner (16px, `src/shared/outline.ts`). Two
touching groups therefore keep a 4px space between their frames, and inner corners of
L-shapes and staircases are as clean as outer ones. An earlier version let every cell draw
its own piece of the frame; corners then had to be patched case by case and some never
lined up. Only rendered rows are measured — the part of a group outside the virtual
window is off screen anyway. A `ResizeObserver` re-measures when card heights change.

**Colours**: groups that touch never show the same colour (`displayColors`). A group whose
colour you picked in its menu keeps it (`pinned`); the others are shown in a colour their
neighbours do not use. Only the display changes — the stored colour comes back once the
neighbour moves away.

**Bookmarks** keep one document per folder under `grid:<folder guid>` in `storage.local`
(`{ v, columns, groups: [{ id, name, color, members }], updatedAt, deviceId }`, `columns: 0`
= automatic) and **sync it by default** through `storage.sync` under the same key (see
[sync-and-backup.md](sync-and-backup.md)). Members this device does not have yet are kept.
Deleting or moving bookmarks elsewhere is cleaned up via `bookmarks.onRemoved/onMoved`,
through the same serial queue as the operations.

**In the sidebar** a group is its consecutive rows drawn as one framed block (each row
draws its side borders, the first and last add the top and bottom), with the same title
row above the first member. The tag is the same component as in the grid — click for the menu, drag to move
the group. Everything in the table above works there too (`useListBoard`).

**Vault** columns and groups live in the encrypted layout document (see
[vault.md](vault.md#groups)).

### Search

Both views and both spaces search the same way:

- **Plain text** matches folder names and bookmark titles and URLs across the whole tree.
  Matching folders are listed first; clicking one opens it.
- **`#name`** lists every bookmark in a group whose name starts with `name` (trimmed,
  case-insensitive), across all folders — groups with the same name in different folders
  count as the same tag. Untitled groups are not tags and never match.

Bookmark groups live in the background page, so `#name` asks it (`groups/find`) and keeps
only members still in that group's folder. The vault is searched entirely in the page
from the already-decrypted data (`searchVault`); the query is never sent anywhere and is
cleared on lock and when switching between bookmarks and the vault. Results cannot be
rearranged. `#name` results still show their groups (bar or outline plus tag, each group kept
together, `searchBoard`); since they span folders, clicking a tag opens that group's folder
instead of the group menu. Plain-text results show no groups.

### The top toolbar and page header

1. **Toolbar** (sticky): name, the bookmarks / private switch (only when the vault is
   shown), search **centred** (`/` focuses it), then card size, column stepper, *Lock* (vault
   only) and `⋯`. It is a three-column grid with equal side columns so the search box sits in
   the true centre; when the page is too narrow (container query on the page width) the
   search moves to its own row.
2. **Page header**: small breadcrumbs with an up button, the folder name as a 24px heading,
   "N folders · M bookmarks" (in the vault: count and auto-lock minutes), and on the right
   *New folder* / *Select*.
3. **While selecting** the header is replaced by one selection bar: exit `✕` · "N selected
   in "Folder"" · *Select all N* … *Frame as group* and other actions · the primary *Move to…*.
   There is no second "Cancel" button any more.

Cards show a `⋯` in their corner on hover — the same menu as right-click. Folder cards show
the first four bookmarks inside as a 2×2 mosaic; *Preview folder contents* (in `⋯` and in
settings, `Settings.folderPreviews`) switches that back to a plain folder icon.

**Feature parity with the sidebar is structural, not remembered.** Preview source and
backfill live in `⋯` using **the same component** (`PreviewOptionsMenu`) and the same state
hook (`useBackfill`, including progress and the capture diagnostic line). Sharing is not
just about saving code: it makes "neither side may be missing a feature" a property of the
structure rather than something to remember on every change — the full-page view was
originally missing the whole group. Which side backfill targets is decided by the current
mode.

Multi-select check marks overlay the corner of the card rather than taking their own
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
others can see the screen, use *Lock* or just close the tab.
