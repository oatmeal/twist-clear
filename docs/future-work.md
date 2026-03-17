# Future work

Deferred items with rationale. See the relevant source files for implementation notes.

---

## Small issues
- remember list vs grid view? or change default to list view?
- template repo: fork + change settings to deploy an archive for a streamer
- featured clips
---

## DOM/integration testing (jsdom or Playwright)

Unit tests currently cover only pure functions (query builder, hash
serialisation, format helpers, etc.). The render pipeline, embed expand/collapse,
and event wiring in `app.ts` are exercised only by manual browser testing.

Adding [jsdom](https://github.com/jsdom/jsdom) via Vitest's `environment: 'jsdom'`
would let us unit-test DOM-touching code (e.g. `expandCard`, `expandRow`, clip
HTML rendering) without a real browser. The main blocker is that sql.js-httpvfs
uses `SharedArrayBuffer` and a Web Worker, neither of which jsdom emulates — so
DB-dependent code paths would still need to be mocked or tested with a full
browser tool like Playwright.

Deferred: the benefit is real but the setup cost (worker mocks, WASM stubs) is
non-trivial. Worth revisiting once the pure-function test suite is mature.

---

## history API

I implemented by hand some basic replaceState handling so back and forwards work.
Some basic testing shows it works mostly except there may be some glitches around login / logout.
The logic around typing and the search filter is especially tricky and is worth some
careful review.

---

## Skip over clips with the default title

This seems to be difficult. We don't have any way to know if the title of the stream has been edited.

---

## Calendar preview strip: show other games de-emphasised when a game filter is active

When a game filter is active, the hover preview strip currently shows only the
filtered game's bar. It would be useful to also show the other games played
during the hovered period — rendered with a de-emphasised (e.g. lower opacity
or greyed-out) style — so the user can see the relative context without the
filter obscuring the full picture.

Possible approach: `showPreviewFor` in `calendar.ts` already fetches the full
unfiltered `PeriodGames` from the cache. Instead of slicing to just the matching
game, pass the full list to `displayPreview` with an additional `highlightId`
parameter; the renderer would draw the active game's bar at full intensity and
all others at reduced opacity.

Deferred: the current behaviour (filtered strip consistent with the heat-map) is
already an improvement. The visual treatment of de-emphasised bars requires CSS
design work.

---

## Calendar: navigation-only level changes without updating the filter

Clicking a year/month/day/week in the calendar always applies the corresponding
date filter ("click = select" semantics). It would be nice to also be able to
navigate *into* or *out of* a level without changing the active filter — e.g.
drilling into a month's heat-map to explore clip density before committing to a
new selection.

Possible approaches: a modifier key (e.g. Shift+click) that navigates without
selecting; or a dedicated "expand" affordance within the calendar panel.
Breadcrumb clicks already update the filter when navigating back up; they could
also have a navigation-only mode.

Deferred because click = select is simple and covers most use cases.

---

## Daily timeline with clips as dots

When filtering to a specific day (or week, even?) show clips as dots on a timeline. Bigger dots mean more views?

---

## LIKE search: unescaped wildcards

`buildWhere` passes the raw user search string into a `LIKE` pattern without
escaping `%` or `_`, so those characters act as SQL wildcards. Mostly harmless
for a personal viewer; to fix, escape them before interpolation and add an
`ESCAPE` clause. Documented in tests.

---

## Title search

Parentheses grouping (`(A OR B) C`) is implemented. NOT syntax i18n strings
are accurate. No further work identified.

---

## Timezone: DST transition edge case

Calendar grouping and date filtering use a fixed UTC offset per query
(the user's selected offset from the settings gear). On days when Daylight
Saving Time changes, local midnight shifts by ±1 hour, so a small number of
clips created within ~1 hour of midnight on DST-transition nights may be
bucketed to the wrong calendar day.

Fully DST-correct bucketing would require knowing the exact DST rules for the
chosen region (not just a UTC offset) and applying per-clip offset lookups —
significantly more complex and not worth it for a clip viewer. The fixed-offset
approach is correct for all other nights and is an accepted trade-off.

---

## Live clips: write-back to the local database

A "save to archive" button could persist in-memory live clips back to the local
SQLite DB, keeping the archive up to date without waiting for the next scheduled
scrape. This is only practical for local setups (not the static-site GitHub
Pages model) since the DB lives in the browser via HTTP Range requests and cannot
be written to from the browser.

For local use, the scraper's existing upsert path (`lib/db.py`) handles
duplicates safely, so the write-back logic would be straightforward.

---

## Live clips: multi-streamer support

`fetchLiveClips()` in `app.ts` uses the first row of the `streamers` table as
the broadcaster. Archives tracking multiple streamers would need to fetch and
merge live clips for each broadcaster, then display them in the live section
(possibly grouped by streamer, or interleaved by date).

Deferred as low priority since most archives track a single streamer.

---

## DB versioning for zero-downtime deployments

`clips.db` is served as a static file. sql.js-httpvfs caches SQLite pages in the
Web Worker's memory for the lifetime of the session, but any pages not yet
fetched are requested lazily. If a deployment swaps `clips.db` while a user is
mid-session, a query could mix pages from the old and new DB versions, causing
sql.js to report corruption. A page refresh always fixes it.

The proper fix is to include a content hash in the DB URL
(e.g. `clips.db?v=<hash>`) so in-flight sessions keep fetching the old file and
new sessions automatically get the new one. This requires:

1. `prepare_web_db.py` (or the build step) to compute a hash of `clips.db` and
   write it as a Vite env var (e.g. `VITE_DB_HASH`).
2. `db.ts` to append `?v=${import.meta.env.VITE_DB_HASH}` to `DB_URL`.
3. GitHub Pages to serve old files for at least one session's lifetime after a
   new deployment. GitHub Pages evicts the old deployment immediately, so step 3
   is not guaranteed — a CDN or proxy in front of GitHub Pages would be needed
   for a fully watertight solution.

The risk is low in practice (requires unlucky timing), and a refresh recovers
the user instantly, so this is deferred.

---

## Content Security Policy: frame-ancestors

The CSP is set via a `<meta>` tag because GitHub Pages does not support custom
HTTP headers. The `frame-ancestors` directive (which prevents the site from being
embedded in iframes on other origins — clickjacking protection) is silently
ignored in meta-tag CSPs; it is only effective as an HTTP header.

If the site is ever deployed behind a proxy or server that can set custom headers
(Cloudflare, nginx, etc.), add `frame-ancestors 'self'` as an HTTP header to
enable this protection.
