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

## Calendar & filter UX review (October 2026)

A usability review of the calendar panel and filter bar, done on the
`ui-refresh` branch by driving the dev server with `scripts/qa-browser.mjs`
at 1400×900 (EN) and 390×844 touch (JA). Within each group, items are roughly
ordered by impact. Remove items (and eventually this section) as they're done.

### Bugs

- **Card game link doesn't refresh the calendar.** The `.clip-game-link`
  click handler in `app.ts` sets the game filter and calls `render()` but not
  `renderCalendar()` (the `#game-filter` change handler does both). With the
  calendar open, the heat-map keeps all-games counts while the preview strip
  shows the new game.
- **Range tint hardcodes Twitch purple.** `inRangeBoxShadow()` and the
  full-month tint in `renderYearView()` use `rgba(145, 71, 255, …)` instead of
  `--accent`, so custom palettes don't match.
- **Empty-state copy assumes a search.** `#empty` always says "No clips match
  your search.", including for date- or game-only filters (e.g. selecting a
  zero-clip day), and offers no way out.
- **`clipCount` has no thousands separator** (`i18n.ts`): the preview label
  reads "28488 clips" while everything else says "28,488".
- **Duplicate `.view-btn` rules** in `style.css` and `calendar.css` with
  conflicting `.active` styles; `calendar.css` wins by load order, so the
  `style.css` block is dead.

### Navigation vs. selection semantics (highest-impact UX issue)

Calendar controls fall into two modes that look identical:

- *Select* (changes the date filter): strip pills, mini-month cards, days,
  week numbers, breadcrumb crumbs, and the **day** ‹ › arrows.
- *Navigate only*: the **year/month** ‹ › arrows and the year/month `<select>`s.

Observed: select June 2024, press the month › → the breadcrumb reads
"2024 › July" while the grid still shows June's 317 clips. Choosing February
from the month select while a July day is selected shows February with July's
results. Also:

- `.active` (navigation position) and `.in-range` (filter) pills are styled
  identically (accent border), so the viewed and the selected month are both
  outlined.
- The breadcrumb reads like a filter summary but reflects navigation; the
  current-level crumb is a hidden "select this period" action.
- Typing a range in the date inputs doesn't move the calendar (it stays on
  2026 after typing May 2021): `deriveNavigationPosition()` only runs when the
  panel opens.

Recommendation: a single ‹ › pair that steps the *selection* at its current
granularity (day/week/month/year), replacing the three nav groups (which wrap
to two rows on phones); show the selection as a separate chip
("June 2024 · 317 clips ✕"); style viewed vs. selected differently; re-derive
the navigation position when the date inputs change. "Calendar:
navigation-only level changes" below asks for the opposite (navigating without
selecting) — reconcile the two when doing this.

Refactor alongside: `setCal…() → syncDateInputs() → renderCalendar() →
setCurrentPage(1) → callRender()` is repeated ~12 times in `calendar.ts`; one
`applyDateSelection(…)` helper would keep the semantics in one place.

### Discoverability

- Mini-month day squares look clickable, but clicking anywhere on the card
  selects the month. Make a day select that day (and drill into the month
  view); keep the card title for selecting the month.
- Week selection is only via an unlabelled gutter of ISO week numbers
  (Monday-based numbers on Sunday-start rows); the only hint is a tooltip.
  Highlight the whole row on gutter hover and add a "Wk" / "週" header, or
  replace the numbers with a select-row icon.
- No arbitrary range selection in the calendar — only one day/week/month/year;
  custom ranges need the native date inputs. Add click-start /
  shift-click-end range selection in the month view.
- Zero-clip days and months are clickable and lead to an empty result. The year
  view *hides* zero-clip months, so the rest shift slots (2019 shows OCT in the
  January position). Render empty months as dimmed, inert placeholders instead.
- The calendar toggle is an unlabelled 35×29 icon with no visible link to the
  date fields. Consider opening the panel when a date field is focused, and a
  text label on wide screens (the date row has room).
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
  mini-day squares), pushing the clips below the fold. On a 390×844 phone the
  panel is ~806 px tall and the grid starts at y≈1220; after tapping a day the
  only visible change is the result count. Options: a GitHub-style
  contribution strip for the year (~120 px), 6-column mini-months on wide
  screens, and on phones a "Show N clips ↓" affordance (or auto-collapse to a
  one-line summary) after a selection.
- The in-range tint muddies the heat-map: selecting a whole month or year tints
  every cell, turning teal blue-grey and empty pinks lavender — exactly when the
  user wants to read that period's density. The perimeter border already shows
  the selection; drop the fill, or dim out-of-range cells instead.
- The selected day is only a 2 px outline over a tinted cell and reads like
  hover. Use a stronger marker (e.g. a filled accent day-number badge).
- The preview strip is `position: sticky; bottom: 0` and covers ~20 % of a
  phone viewport; on `(hover: none)` devices it only duplicates the game
  dropdown. Make it non-sticky or one line there.
- On phones the month strip wraps 8+4 and the year strip 6+2 (with stretched
  pills); use a fixed grid (e.g. 6 columns) or a horizontal scroller.
- The clear-dates ✕ is 22×19 px (below the 24 px minimum target) and is shown
  even when no dates are set.

### Accessibility

- In the calendar only the nav buttons and selects are focusable; days, week
  numbers, mini-month cards, strip pills and breadcrumb crumbs are `div`/`span`
  elements with click handlers. Use `<button>`s (or a roving-tabindex grid with
  arrow keys) and `aria-pressed` / `aria-current` for the selection.
- The ‹ › nav buttons have no `aria-label`.
- Hover previews should also appear on keyboard focus.

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

(The year/month arrows and selects already navigate without selecting, and the
October 2026 review above found that mix confusing — see "Navigation vs.
selection semantics" there before adding more navigation-only paths.)

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
