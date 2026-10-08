# Future work

Deferred items with rationale. See the relevant source files for implementation notes.

---

## Small issues
- strange mouse cursor issue: mousing over the rows in list view from different directions, the cursor sometimes stays default instead of becoming "pointer".
- remember list vs grid view? or change default to list view?
- template repo: fork + change settings to deploy an archive for a streamer
- featured clips
- custom `site_heading` HTML (e.g. clipmaru's animated icon) can overlap the header buttons at ≤390px; `overflow: hidden` was deliberately removed from the header, so a fix needs to keep decorations unclipped.
---

## Timeline & calendar follow-ups

The `timeline-overview` branch settled the review's navigation-vs-selection
issue (below): navigation never changes the date filter, selecting moves the
view only when the selection is off-screen, and a timeline overview in the
filter bar always shows — and edits — the filter. Design and code walkthrough:
`frontend/docs/calendar.md`. Open items, roughly by priority:

- **Evaluate the year/month flow.** The current experiment: an explicit
  Year | Month toggle, ‹ › that step the view, a "Filter to <period>" button
  for selecting the whole month / year on screen, clicking a year-view card to
  zoom in, and drag / Shift-click for ranges. Still being tried out — in
  particular whether "Filter to …" is the right way to pick a whole month
  (previously clicking the month itself did), and whether stepping a
  selected day by keyboard on the timeline band is enough of a replacement for
  the old day ‹ › arrows.
- **Touch selection handles: try them on a real phone.** The month view's
  knobs (see "Selection handles" in `frontend/docs/calendar.md`) were only
  tested with synthetic touch events in headless Chromium. Check the 14 px knob
  is findable, whether the year view's mini-days need them too (they're
  ≈ 20 px on a phone), and whether a range that ends in another month needs a
  hint that its other end is off-screen.
- **Heat-map scale under a search or game filter.** The absolute thresholds
  (1–5 clips = lightest) make most days one shade once a filter leaves a few
  clips a day; relative quantiles only kick in above an average of 15 a day
  (`computeHeatThresholds()` in `calendar.ts`). Consider relative shading
  whenever a filter is active, without overstating 1 vs 2 clips.
- **Fold the date inputs into the timeline**, e.g. editable start / end labels
  on the band, now that the band shows the filter at all times.

---

## Query cost: remaining hot spots

Measured as DB bytes fetched on the dev server (see "Query plans" in
`frontend/docs/search.md` for the FTS fixes and how to measure).

- **Game filter + "Most viewed", no search: ≈14 MB** for a big game (8,448
  clips). SQLite walks `clips_game_created` and looks up every row for
  `view_count` to sort. A covering index `(game_id, view_count DESC,
  created_at DESC)` in `prepare_web_db.py` would make it a short index walk.
- **Searches under 3 characters: ≈13 MB.** The LIKE fallback scans the whole
  table (once; later queries hit the cache). An index on `clips(title)` would
  let it scan titles only — they total ≈0.7 MB of the 11 MB table — at the
  cost of that much DB size.
- **Calendar open during a search: ≈1.1 MB**, almost all the preview strip's
  all-time game breakdown reading `clips_created_at_game`. The timeline and
  calendar read the slightly smaller `clips_created_at`; moving them onto
  `clips_created_at_game` (or dropping `clips_created_at`) would put every
  date aggregate on one index, cached after the first load.

---

## Calendar & filter UX review (October 2026)

A usability review of the calendar panel and filter bar, done on the
`ui-refresh` branch by driving the dev server with `scripts/qa-browser.mjs`
at 1400×900 (EN) and 390×844 touch (JA). Within each group, items are roughly
ordered by impact. Remove items (and eventually this section) as they're done.
The bugs it found (duplicated year strip, stale heat-map after a card's game
link, hardcoded selection tint, search-only empty-state copy, ungrouped
`clipCount`, duplicate `.view-btn` CSS) have been fixed. Its top issue —
navigation and selection controls looking identical, so the view and the
filter drifted apart — was addressed by the timeline-overview work above
(single `applyDateSelection()` path, separate view header, year/month strips
and breadcrumb removed), as were: range selection (mouse), zero-clip months
shifting slots in the year view, strips wrapping on phones, and unlabelled ‹ ›
buttons.

### Discoverability

- Week selection is only via an unlabelled gutter of ISO week numbers
  (Monday-based numbers on Sunday-start rows); the only hint is a tooltip.
  Highlight the whole row on gutter hover and add a "Wk" / "週" header, or
  replace the numbers with a select-row icon.
- Zero-clip days in the month view are still selectable on their own (fine as
  range ends, but a single click gives an empty result); consider dimming them.
- The calendar toggle is an unlabelled 35×29 icon with no visible link to the
  date fields (clicking the timeline now also opens it). Consider opening the
  panel when a date field is focused, and a text label on wide screens.
- Preview-strip game rows aren't clickable; clicking one should apply that
  game filter.
- Card game names are muted 12 px text with only a hover colour change — no
  affordance on touch. Consider a chip style or a filter icon.
- Search syntax (OR, `-`, quotes, groups) is only documented in the general
  help modal; `.search-help-btn` CSS still exists but there is no in-field
  button.
- No active-filter summary or "Clear all" at the top (the filter tab only
  summarises once the bar has scrolled away), and the game filter has no ✕
  (you must re-pick "All games"). A chip row under the controls —
  `[Apex ✕] [Jun 2024 ✕] · 317 clips · Clear all` — would cover both.
- The game filter is a native `<select>` of ~90 options; consider a searchable
  combobox.

### Layout & visual

- Calendar height: the year view is ~550–850 px tall at 1400 px wide (42 px
  mini-day squares), pushing the clips below the fold; on a 390×844 phone the
  grid starts far down the page and after tapping a day the only visible
  change is the result count. The timeline now covers whole-archive density,
  so options include 6-column mini-months on wide screens and, on phones, a
  "Show N clips ↓" affordance (or auto-collapse) after a selection.
- The in-range tint muddies the heat-map: selecting a whole month or year tints
  every cell, turning teal blue-grey and empty pinks lavender — exactly when the
  user wants to read that period's density. The perimeter border already shows
  the selection; drop the fill, or dim out-of-range cells instead (as the
  timeline does).
- The selected day is only a 2 px outline over a tinted cell and reads like
  hover. Use a stronger marker (e.g. a filled accent day-number badge).
- The preview strip is `position: sticky; bottom: 0` and covers ~20 % of a
  phone viewport; on `(hover: none)` devices it only duplicates the game
  dropdown. Make it non-sticky or one line there. (See also "Calendar preview
  strip: jumpy height, flashing, placement" below.)
- The clear-dates ✕ is 22×19 px (below the 24 px minimum target) and is shown
  even when no dates are set.

### Accessibility

- Days, week numbers and mini-month cards are `div`s handled by pointer events;
  only the header controls, the mini-month title buttons and the timeline's
  band / handles are focusable. Use `<button>`s (or a roving-tabindex grid with
  arrow keys) and `aria-pressed` / `aria-current` for the selection.
- Hover previews should also appear on keyboard focus.

---

## Calendar preview strip: jumpy height, flashing, placement

Hovering around the calendar is distracting:

- **Height changes constantly.** The strip shows 0–5 game rows plus a "+N
  more" line, so its height follows whatever is hovered; because it is
  `position: sticky; bottom: 0`, the jump happens right under the cursor's
  line of sight. Reserving the full height (5 rows + the "more" line) would
  stop it.
- **It flashes on cell borders.** Each cell has its own `mouseenter` /
  `mouseleave`; crossing the 1 px border between cells (or the 2 px gap
  between mini-days) fires `mouseleave` → `revertToDefault()`, which swaps in
  the selection's breakdown for a frame before the next cell's hover preview
  (an async query) replaces it. A delegated `pointermove` on the grid that
  finds the cell under the pointer, plus a short delay before reverting,
  would remove the flash.
- **Placement.** It may work better as a tooltip anchored to the hovered
  cell (less eye travel), but a tooltip covers the heat-map being read, and
  on touch devices there is no hover — the strip is then the only place the
  selection's game breakdown appears (it duplicates the game dropdown). The
  timeline's hover tooltip could also carry a top-games line. Decide this
  together with the "preview strip is sticky and covers ~20 % of a phone
  viewport" item in the review above.

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

## Live clips: surgical DOM insertion to avoid full re-renders

Currently, each time new clips are discovered during bisection, `onProgress`
calls `render()` which replaces the entire clip grid via `innerHTML`. A guard
was added so the render is skipped when a card or row is expanded, but page
content can still shift for users on page > 1 as live clips are prepended.

A surgical approach would instead prepend new clip card/row elements directly
to the DOM, skipping the full re-render entirely. Benefits:

- No content shift for users on page > 1 (new clips land above the fold)
- Scroll position preserved naturally via browser scroll anchoring
- Safe even when an embed is open, since existing DOM nodes are untouched

Scope: only straightforward for **date-desc** sort (all new live clips land at
the top). Date-asc would append at the bottom. View-count sort interleaves clips
throughout the grid and would need a different strategy (e.g. notify-and-defer).

Deferred: the current guard (skip render when expanded) addresses the most
disruptive case. Surgical insertion requires constructing DOM nodes rather than
HTML strings and careful handling of the embed row and pagination boundary logic.

---

## Live clips: video_id-based stream session detection

The current "live" cutoff is either a build-time `VITE_LIVE_AFTER` timestamp or
one computed at login time from the Twitch streams/videos API. A more robust
approach would use `video_id` — the VOD ID stored on each clip — to group clips
by stream session regardless of timing.

Key complications:

- `video_id` is nullable: Twitch deletes it from the clip record when the
  corresponding VOD is removed. Streamers who do not archive VODs, or who delete
  them after a retention period, will have many clips with `video_id = NULL`.
- Grouping by `video_id` requires storing it at scrape time (scraper change) and
  adding it to the DB schema / `prepare_web_db.py` output.
- Detecting "which session is most recent" requires comparing `video_id` values
  across clips, which adds logic to both the frontend query and the render path.

Deferred: the timestamp-based approach (stream API + VOD end time) covers the
common case reliably without schema changes.

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
