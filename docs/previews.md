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
