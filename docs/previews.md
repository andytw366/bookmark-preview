# How preview images are chosen

Previews prefer the page's **own cover art** — comic and book covers, video thumbnails —
and fall back to a screenshot only when there isn't one. For a content page a cover
represents the bookmark far better than a screenshot, which usually just shows a
navigation bar. Covers keep their original aspect ratio; screenshots are cropped to 16:9.
The preference is switchable in the sidebar's overflow menu.

Cover art is read from the **rendered DOM of an open tab**, which is why it also works on
client-rendered sites and sites behind Cloudflare — re-fetching the URL from the
background page fails on both.

## The ranking, in order of trust

Entry URLs (a site rather than a page in it) go through the site-icon path first — see
[Entry URLs show the site icon](#entry-urls-show-the-site-icon). Everything below applies
when that is off, does not apply, or finds no usable icon.

The heuristics **never look at the domain**. There is no site list and no per-site
selector, so no site needs individual handling.

1. A cover parameter inside an embedded player's `src` (`?poster=` and friends)
2. The site's declared `og:image` / `twitter:image`
3. JSON-LD (schema.org)
4. `<video poster>`
5. Whatever on the page looks most like a cover

**A player's poster parameter outranks `og:image`** because it is more trustworthy: an
`og:image` is often one share image reused across the whole site, whereas a poster handed
to a player is necessarily the cover for *this video on this page* — nobody passes a site
logo as a video poster. This is still a general rule; it only looks at the parameter name
and the shape of its value.

## The last resort: scoring

`<img>` elements and CSS `background-image`s **compete in the same pool**, scored by
displayed area × portrait bonus × near-the-top bonus × full-width penalty, excluding
icons, banners and images deep in the footer. Background images are discounted 30% —
their true pixel dimensions are unavailable and they may just be texture.

The two cannot each get their own flat score. That would let "the obvious cover image at
the very top of the page, drawn as a background" lose to "a small thumbnail in a
recommendations list a thousand pixels down".

Three rules keep this layer from picking things that are technically images but represent
nothing:

- **Nothing wider than about 2.2:1.** A content cover is portrait or roughly 16:9; wider
  than that and it is a banner, a carousel slide, or a panel background. A forum's
  550×200 panel gradient used to win outright — big, near the top, and unremarkable in
  every other respect.
- **A repeated size means a feed, not a cover.** Three or more images sharing a displayed
  size are a listing — each one represents a *different* page. This is why "the first
  image on screen" used to win on home pages and forum indexes. The rule ignores clusters
  wider than 40% of the viewport, so a comic reader's column of page images is untouched.
- **It has to look like a picture.** After the bytes arrive they are sampled and scored on
  how much they change from pixel to pixel; solid colours, smooth gradients and
  lazy-loading placeholders score essentially zero and are skipped. The bar is set low
  (0.5%) on purpose: a logo that is mostly whitespace with a small wordmark measures around
  1.5%, and a logo is exactly what should win when a page has no cover of its own.

## When a page genuinely has no cover

App-like pages — a home feed, a chat interface, a login wall — have no cover to find, and
the honest answer is the site's own identity rather than an arbitrary image scraped off the
screen. Because a site-wide `og:image` is demoted rather than discarded, that is what
happens automatically once the rules above remove the junk: the logo the site declares for
every page sits below any trustworthy content image and above nothing at all. Failing that,
a screenshot.

This is the same mechanism that keeps a logo *out* of the way on a video page, read from
the other end: there the player's poster parameter and the page's own `og:image` outrank it.
Nothing is site-specific; the ordering does the work.

## Choosing the image is only half of it: getting the bytes

Picking the right image and downloading it are separate problems, and the second one has
its own ladder — tried in order, first success wins:

1. **Fetch from the background page.** One request, no page involved.
2. **Fetch from inside the page.** Injected into the tab the candidate came from, so the
   request carries the correct `Referer` and the site's cookies.
3. **Crop it out of a screenshot.** The image is already on screen, so this needs no
   network request at all and nothing can refuse it.

Stage 2 exists because an extension cannot set a cross-origin `Referer` itself — `fetch`'s
`referrer` option is dropped — so a CDN that checks it answers 403 no matter what the
background page does. Stage 3 is for the rest: images bound to a session, or a CDN behind
a challenge page.

**The automatic path uses stages 1 and 2; the manual override uses all three.** Stage 3
has to scroll the image into view first, and automatic capture runs merely because you
visited a page you had bookmarked — the page should not jump on its own. Nothing is lost:
when every cover candidate fails, the pipeline falls back to a screenshot of the page.

A candidate is accepted when it **decodes as an image**, not when its `content-type` says
so; plenty of CDNs serve images as `application/octet-stream`.

## Site-wide `og:image` is demoted automatically

Many sites use one `og:image` — usually a logo — for every page. As a preview that is
worse than a screenshot: a whole column of bookmarks showing the same logo.

Detection needs neither a domain check nor a maintained list: **if the same image has
appeared on two or more distinct pages of the same domain, it is treated as site-wide and
demoted below content images.** This learns as you browse, so the first bookmark from a
site may still get the logo; it corrects itself once another page from that site has been
captured, and you can always override it by hand.

**The unit of counting is "how many distinct page URLs on this domain have declared this
image", not "how many times it was fetched."** Re-capturing the same page repeatedly does
not advance the count, because that page URL is already recorded.

All three capture paths (tab capture, backfill, and refresh-when-no-tab-is-open) record
and apply the demotion. The server-side path originally took the first `og:image`
unconditionally, so a bulk backfill could produce a column of identical logos while
learning nothing; it now extracts **every** preview image the page declares and sorts
site-wide ones last (not removed — some pages genuinely have nothing else). That also
closed a smaller gap: on some sites the `og:image` is a shared logo while `twitter:image`
is the real content image, and looking only at the first one never reached it.

## Entry URLs show the site icon

When a bookmark points to **a site or app rather than a piece of content** — Google Maps,
Drive, YouTube's home page, Twitch — its preview is the site's icon on a plain panel, like
Zen's pinned tiles. A screenshot of a login wall or a static map declared as `og:image`
represents "this app" worse than its icon does.

**The rule looks only at the shape of the bookmark's own URL**: at most one path segment
and no query (`isEntryUrl` in `shared/url.ts`). `google.com/maps`, `drive.google.com` and
`twitch.tv/` qualify; `youtube.com/watch?v=…` and `github.com/u/repo` do not. A one-level
profile page (`x.com/someone`) is a known, accepted false positive; a deep app URL such as
`mail.google.com/mail/u/0/` is a known miss. It is the **bookmark's** URL, never the tab's:
Drive redirects to `/drive/my-drive`, which is two levels. The switch is "Site icons for
home pages" in the overflow menu, on by default; turning it off does not replace existing
icons until they expire or are refreshed.

Where the icon comes from (`background/site-icon.ts`):

- **Tab open**: `<link rel="icon">` / `apple-touch-icon` from the top frame, the Web App
  manifest's `icons[]` (fetched from the background, or from inside the page when it needs
  the page's credentials), and `tab.favIconUrl`.
- **No tab** (backfill, refresh without a tab): the same declarations parsed from the
  fetched HTML, then `/favicon.ico` as a last resort.
- Largest first, square preferred; `mask-icon` and `monochrome` icons are skipped. The
  first that decodes with a shortest side of at least 16px wins. SVGs are rasterized
  through an `<img>` after their root is given explicit dimensions (Firefox draws a
  dimensionless SVG at 0×0). Stored at most 256px, transparency kept (WebP, else PNG).

Choices made deliberately:

- **Not "has a Web App manifest"** as the signal. YouTube's and Twitch's home pages have
  none, while MDN and GitHub content pages do.
- **No third-party icon service** (Google `s2/favicons`, DuckDuckGo). Those would send the
  domain of every bookmark to a third party. Every request here goes to the bookmark's own
  site, the same as fetching its `og:image`.
- **No edge threshold** (`MIN_COVER_EDGES`). A monochrome logo can fail it, and it is still
  the right answer. Icons also skip the site-wide learning.

An existing non-icon thumbnail of an entry URL is not "fresh": the next visit replaces it
instead of waiting `thumbMaxAgeDays`. The cost is that an entry URL whose icon cannot be
fetched reruns the pipeline on every visit.

## The manual override

Automatic detection cannot be right everywhere, so there is a direct escape hatch:
**right-click any image on any page → "Use as this bookmark's preview"**. This works for
vault bookmarks too (the thumbnail is encrypted with the master password).

## Capture triggers

**A newly created bookmark is captured immediately**, without waiting for the next visit.
`tabs.onUpdated` alone is not enough: bookmarking *the page you are looking at* produces
no tab event at all, since the page finished loading long ago, so new bookmarks would sit
on a colour card forever. `bookmarks.onCreated` covers that.

This path **only acts when a tab for that URL is currently open**, and it skips the whole
batch when more than 5 bookmarks are created within 2 seconds — importing a bookmark file
or a Firefox Sync run creates hundreds at once, and that is not the moment to fire off
hundreds of requests. That is what the "Fetch missing previews" button is for. Moving a
bookmark *out* of the vault also fires `onCreated`, but that path has already restored the
decrypted thumbnail, so an existing thumbnail suppresses a re-fetch.

## Test fixtures

`tests/fixtures/site/` has a page for each situation the heuristics must get right.
Serve them with `./scripts/serve-fixture.sh`; all have been verified against a real
browser.

| Page | What it proves |
|---|---|
| `/` | No metadata at all; a portrait cover must beat a banner ad and small icons |
| `/video` | A landscape `video poster` must beat a physically larger full-width hero |
| `/background` | The cover is a CSS `background-image` (invisible to `document.images`) |
| `/lazy` | The cover's `src` is assigned after load (SPA / lazy loading) |
| `/declared` | A declared `og:image` must beat a larger unrelated image |
| `/shared-a`, `/shared-b` | Two pages share one `og:image`; after the second is visited it must be demoted as site-wide |
| `/embed` | The cover exists only in an iframe's `?poster=` parameter and must beat a site-wide `og:image` logo |
| `/deep-thumbs` | A CSS background cover at the top must beat recommendation thumbnails further down |
| `/hotlink` | The cover's CDN answers 403 without a same-site `Referer`, so the bytes can only be had from inside the page |
| `/carousel` | The slides that are not showing — parked off-screen, or `visibility: hidden` — are larger and portrait, and must still lose to the one on screen |
