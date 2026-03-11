# frontend/CLAUDE.md — SPA guide for AI assistants

## Keeping this file up to date

Update this file whenever you change the frontend in a way that affects its
accuracy — new modules with non-obvious roles, changed patterns, new design
decisions, fixed known issues. Do it in the same commit as the change.

---

## What this is

A TypeScript + Vite SPA that queries a SQLite database directly in the browser
using [sql.js-httpvfs](https://github.com/phiresky/sql.js-httpvfs). Only the
B-tree pages needed for each query are fetched via HTTP Range requests.

## Source layout

Non-obvious files worth knowing about:

```
src/
  app.ts        # Render loop, event binding, URL hash state, live clip fetch
  auth.ts       # Twitch OAuth 2.0 implicit grant (token storage, logout)
  calendar.ts   # Calendar view — year → month → day/week drill-down
  db.ts         # sql.js-httpvfs worker init; exports async q() query helper
  state.ts      # All shared mutable state + explicit typed setters
  twitch.ts     # Helix API client for live clips (auto-paginates, resolves game names)
  lib/
    dateUtils.ts  # Timezone-aware date arithmetic + UTC-offset helpers
    format.ts     # escHtml, fmtDuration, fmtViews, fmtDateTime
    hash.ts       # Pure serializeHash() / deserializeHash() — URL hash state
    i18n.ts       # English & Japanese translations; t(), detectLang(), setLang()
    liveFilter.ts # Pure filterLiveClips() — filters live clips against UI state
    pkce.ts         # OAuth crypto helpers (randomBase64url, sha256Base64url)
    query.ts        # Pure buildWhere() — builds SQL WHERE clause from filter state
    searchParser.ts # Pure parseSearchQuery() — translates boolean search syntax to FTS5
```

`main.ts` is the Vite entry point; it just calls `init()` from `app.ts`.
`index.html`, `vite.config.ts`, `tsconfig.json`, `package.json` are standard.

```
scripts/
  screenshot-og.ts  # Post-build: starts vite preview, screenshots at 1200×630,
                    #   writes frontend/dist/og-image.png for og:image
```

## Key design decisions

### sql.js-httpvfs — async query model

`db.ts` exports `async function q(sql, params?)`. All callers must `await` it.
Named params (`{':foo': value}`) and positional arrays (`[value]`) both work —
the worker implements `query = (...args) => toObjects(exec(...args))`, so it
passes straight through to sql.js `exec()` which accepts both forms.

**Never revert `optimizeDeps` in `vite.config.ts`**: sql.js-httpvfs ships as
CJS. The worker JS and WASM are imported with `?url` (bypassing the optimizer),
but the main package entry must be pre-bundled so Vite can expose its named
exports as ESM. The current exclude list is:
```
['sql.js-httpvfs/dist/sqlite.worker.js', 'sql.js-httpvfs/dist/sql-wasm.wasm']
```

**`dbRangePlugin` in `vite.config.ts`**: Vite's built-in static file server
(sirv) advertises `Accept-Ranges: bytes` but ignores `Range` request headers,
returning full 200 responses. sql.js-httpvfs requires genuine 206 Partial
Content responses or it downloads the entire DB. The plugin intercepts `.db`
requests in both `configureServer` (dev) and `configurePreviewServer` (preview)
and implements range request handling directly via Node's `fs.createReadStream`.
Do not remove it or sql.js-httpvfs will fall back to full-file downloads.

**GitHub Pages gzip workaround (`serverMode: 'chunked'`)**: GitHub Pages /
Fastly gzip-compresses `clips.db` for full GET and HEAD requests and reports
the *compressed* Content-Length (~8 MB for a ~22 MB DB). `serverMode: 'full'`
uses the HEAD Content-Length as the total file size, so the worker treats pages
beyond ~8 MB as out-of-range, breaking all B-tree lookups in the upper portion
of the file.

`db.ts` works around this by probing the true file size with a `Range: bytes=0-0`
request before calling `createDbWorker`. Per RFC 7233, partial-content (206)
responses must report the actual uncompressed size in `Content-Range`, so this
gives the real size even when the full/HEAD responses are gzip-compressed. The
worker is then initialised with `serverMode: 'chunked'` and
`databaseLengthBytes = <true size>`, which skips the HEAD request entirely.

The single-chunk URL scheme uses `urlPrefix: dbUrl + '?chunked='` /
`suffixLength: 1` — chunk 0 maps to `clips.db?chunked=0`. GitHub Pages ignores
query strings for static-file lookups; `dbRangePlugin` also strips the query
string before matching, so this works in dev and preview too.

### AbortController in render()

`render()` in `app.ts` keeps a module-level `_renderController`. Each call
aborts the previous one before starting. This prevents stale renders when the
user changes filters faster than queries complete. Pattern:

```ts
_renderController?.abort();
const ctrl = new AbortController();
_renderController = ctrl;
// ... after each await:
if (ctrl.signal.aborted) return;
```

### State module (ES module setter pattern)

`state.ts` exports `let` bindings and explicit setter functions (e.g.
`setSearchQuery`). Importing modules must use setters — ES module live bindings
are read-only from outside the declaring module.

`tzOffset` (UTC offset in signed integer minutes, east = positive) is included
in state. It defaults to `browserTzOffset()` (negation of
`Date.getTimezoneOffset()`). Initialization priority at startup: URL hash `tz`
param > `localStorage.getItem('tc_tz_offset')` > browser default. Changes are
saved to both localStorage and the URL hash. The settings gear icon in the
controls bar opens a panel with a `<select>` populated by `populateTzSelect()`
in `app.ts`.

Language preference is persisted to `localStorage` under `tc_lang` (`'en'` or
`'ja'`). Initialization priority: `localStorage.getItem('tc_lang')` >
`detectLang()` (browser locale). The lang toggle saves immediately on click.

### OG screenshot (`scripts/screenshot-og.ts`)

`npm run screenshot-og` (run after `npm run build`) generates `frontend/dist/og-image.png`
for the `<meta property="og:image">` tag. It uses `playwright-core` with
`channel: 'chrome'` — no browser download is needed because:

- **CI (ubuntu-24.04)**: Google Chrome is pre-installed on the runner image.
- **Local (macOS)**: Playwright locates Chrome at its standard install path.

The script spawns `vite preview` on port 4174 (rather than the default 4173, to
avoid colliding with a running dev server) and polls until it responds. It then
waits for `#loading` to be hidden (the signal app.ts fires after the DB
initialises), then for `networkidle` (thumbnail images are `loading="lazy"` and
arrive from Twitch's CDN after the cards render), before capturing a 1200×630
viewport screenshot.

`vite preview` is used (not a generic static server) because `dbRangePlugin`
patches `configurePreviewServer` to handle HTTP Range requests for the DB file.
Without it, sql.js-httpvfs would download the entire DB on every query.

The `og:image` URL in `index.html` is `%VITE_SITE_URL%og-image.png` — a fixed
path that requires no post-build HTML surgery. When `VITE_SITE_URL` is empty
(local dev without the env var set) the tag resolves to a relative path, which
crawlers won't follow, but that's fine since og:image only matters in production.

### Site description (`VITE_SITE_DESCRIPTION`)

An optional subtitle shown in the page header below the site title. Injected
at build time via the `site_description` workflow input — see
[`docs/deploying.md` → Branding / metadata](../docs/deploying.md#inputs-reference)
for the full inputs reference. Defaults to empty string; when empty the
`.site-desc` element is suppressed via CSS `:empty { display: none }` and the
toggle button is never shown.

On screens ≤600 px the description is hidden by default. When a description is
present, `init()` in `app.ts` adds `.has-desc` to `.header-title`, which makes
the chevron button (`#btn-site-desc`) visible. Clicking it toggles
`.desc-expanded` on `.header-title` and updates `aria-expanded`; CSS then shows
`.site-desc` and rotates the chevron.

### Colour theming (`VITE_COLOR_*`)

`applyColorOverrides()` in `app.ts` is called at the very top of `init()`. It
iterates over a map of `VITE_COLOR_*` env vars → CSS custom properties and
calls `document.documentElement.style.setProperty(prop, val)` for each
non-empty value. Inline styles on `<html>` win over `:root` stylesheet values
in the cascade, so this approach is safe and does not require modifying any CSS.

The full list of supported vars, their CSS properties, and defaults is
maintained in [`docs/deploying.md` → Colours](../docs/deploying.md#colours)
(canonical). The user-facing palette guide and example themes are in
[`docs/theming.md`](../docs/theming.md).

Derived colours (`--accent-h`, `--cal-0..4`, `--cal-text`/`--cal-text-muted`)
use `color-mix()` that cascades automatically when `--accent`/`--cal-accent`
are overridden. `--cal-accent` is intentionally separate from `--accent` so the
calendar heat-map reads as data-density rather than an interactive element.
Browser support: Chrome 111+, Firefox 113+, Safari 16.2+.

### Grid vs. list layout (`clipLayout`)

`clipLayout` (`'grid' | 'list'` in `state.ts`) controls whether clips are
rendered as thumbnail cards or a compact table. It is orthogonal to
`currentView` — the calendar panel can be open regardless of layout.

The `⊞` / `☰` buttons in the controls bar's `.view-switcher` toggle this
state. `updateLayoutButtons()` in `app.ts` syncs the `.active` class on both
buttons. `clipLayout` is serialised as `layout=list` in the URL hash (the
`grid` default is omitted to keep URLs short).

**Grid mode** (`#clips-grid`, `display: grid`): renders `.clip-card` elements
via `clipCardHtml()`. Clicking a card expands an inline Twitch embed
(`expandCard`/`collapseCard`), which uses `grid-column: 1/-1` to span all
columns.

**List mode** (`#clips-grid.is-list`, `display: block`): renders a
`<table class="clips-table">` inside `#clips-grid` via `clipListRowHtml()`.
Columns: **Title** (with a compact `.clip-list-thumb` thumbnail and duration
overlay) | Game | Creator | Date | Views — no separate rank or duration columns.
Clicking a row calls `expandRow()`, which inserts a `<tr class="clip-embed-row">`
immediately after the clicked row; the embed occupies a full-colspan `<td>`.
Below the iframe a `.clip-list-nav-row` holds ← / → buttons that call
`navigateRow()` to advance between rows while preserving scroll position (same
technique as grid's `navigateClip()`). `collapseRow()` removes the entire
embed row. The active row and its embed row are tracked by `_expandedRow` /
`_insertedEmbedRow`. The close-btn and Escape key handlers both dispatch to
either `collapseCard` (grid) or `collapseRow` (list). The prev/next button
handler routes to `navigateRow` when `_expandedRow` is set, else `navigateClip`.

The render loop builds a flat `ClipItem[]` array (resolving the
live/DB merge logic) and then passes it to either the card or table renderer,
so the complex merging math only runs once per layout.

### Calendar panel vs. date filter — decoupled

`currentView` (`'grid' | 'calendar'` in `state.ts`) controls only whether the
calendar panel is visible. It has **no coupling to the date filter**
(`calDateFrom` / `calDateTo`).

**Calendar toggle** (`btn-view-cal`): clicking it calls `switchView()` which
opens or closes the panel. On open, `deriveNavigationPosition()` computes a
sensible `calYear` / `calMonth` from the current filter (≤ 62-day filter →
month view; longer → year view for the midpoint year; no filter → most-recent
year). The filter itself is not modified.

**Clear button** (`btn-clear-dates`): calls `clearCalDateFilter()` which zeroes
`calDateFrom`, `calDateTo`, `calDay`, `calWeek`. The calendar panel stays open
if it was open.

**Navigation** (arrows, year/month selects): change `calYear` / `calMonth` only;
do **not** touch the date filter. The calendar re-renders to show the new
position; the clip grid is also re-rendered (same filter, same results — this
keeps the URL hash in sync with the new navigation position).

**Selection** (clicking a mini-month card, month pill, day, week; breadcrumb
clicks): change both the navigation position **and** the date filter, then
re-render both the calendar and the clip grid.

### Circular dependency: calendar ↔ app

`calendar.ts` needs to trigger a re-render in `app.ts`, but `app.ts` imports
from `calendar.ts`. To break the cycle, `initCalendar(onRender)` accepts a
callback injected by `app.ts`. `calendar.ts` calls `void _onRender?.()` (fire
and forget; the AbortController in `render()` handles deduplication).

### Pure functions for testability

`buildWhere(opts)` in `lib/query.ts`, `serializeHash`/`deserializeHash` in
`lib/hash.ts`, and `filterLiveClips(opts)` in `lib/liveFilter.ts` all take
their inputs as explicit parameters and do not read from `state`. This makes
them fully unit-testable without a DOM or DB.

### FTS5 trigram search

`prepare_web_db.py` adds a `clips_fts` virtual table with `tokenize='trigram'`
(requires SQLite ≥ 3.38). At startup `app.ts` queries `sqlite_master` to check
whether the table exists and sets `state.useFts`. When `useFts` is true,
`buildWhere` calls `parseSearchQuery()` (`lib/searchParser.ts`) to translate the
user's input into a safe FTS5 MATCH expression before passing it as `:search`.

`parseSearchQuery` returns null (triggering a fallback) when: the total query
is fewer than 3 characters; there are no positive terms (e.g. pure negation
`-boss`); or any individual term is shorter than 3 characters (below the FTS5
trigram minimum — common for single-kanji queries like `猫 OR 犬`).

When FTS5 is unavailable or `parseSearchQuery` returns null, `buildWhere` tries
`parseLikeSearchQuery()` (also in `lib/searchParser.ts`), which generates a
compound SQL LIKE expression that respects the same boolean structure (AND, OR,
NOT). This makes boolean searches work for short Japanese terms. Only if
`parseLikeSearchQuery` also returns null (pure negation with no positive terms)
does the code fall back to a plain `c.title LIKE '%query%'`.

Supported boolean syntax: space-separated terms are implicit AND; `OR` or `|`
for OR; `-word` or `-"phrase"` to exclude. Full-width space (`\u3000`) is
normalized to ASCII space globally. Full-width minus (`\uff0d`) is recognized
as a negation-prefix alias only at the start of a token — inside a bare word it
is preserved as-is, so searches for titles containing `－` work correctly.
Each bare term is wrapped in FTS5 double-quotes to neutralize any special
characters in the term text. A `?` / Help button in `#header-controls` opens
a general "How to use" modal (`#search-help-modal`, `id="btn-help"`) covering
browsing, layout, sort, game filter, search syntax (translated EN/JA), date
filtering, login, and URL sharing.

**Keeping the help modal up to date**: The modal has one `<section
class="help-section">` per major feature, in the order: browsing → layout →
sort → game → search → date → login → share. When a feature is added,
removed, or its behaviour changes in a user-visible way:

1. Update (or add/remove) the relevant `<section>` in `index.html`.
2. Update the corresponding i18n keys in `src/lib/i18n.ts` — heading key
   `help<Feature>`, description key `help<Feature>Desc` — for both `en`
   and `ja`.
3. Wire the new elements in the "Help modal" block of `applyTranslations()`
   in `app.ts`.
4. Default text in `index.html` must be Japanese (house rule: no English in
   static HTML).

### Precomputed metadata (`useMeta`)

sql.js-httpvfs uses an exponential read-ahead strategy: each sequential page
miss doubles the next fetch size (4 KiB → 8 → 16 → … → 4 MiB). Aggregate
queries that touch many rows (MIN/MAX, GROUP BY game, COUNT(*)) each trigger one
of these chains and can transfer several MB from a cold cache.

`prepare_web_db.py` precomputes several things to replace the most expensive
startup aggregates with cheap single-page lookups:

- `clips_meta` — one row: `min_date`, `max_date`, `min_timestamp`,
  `max_timestamp`, `total_clips`. The raw `min/max_timestamp` columns store full
  UTC ISO timestamps so `initCalendar` can compute local calendar boundaries for
  any timezone via `utcTimestampToLocalDate`.
- `game_clip_counts` — one row per game: `id`, `name`, `name_ja`, `cnt` (no date filter)
- `clips_created_at` — index on `clips(created_at)` for date-range COUNT(*)
- `clips_created_at_game` — covering index `(created_at, game_id)` for
  date-filtered game GROUP BY (index-only, no table access)
- `clips_game_created` — index `(game_id, created_at DESC)` for
  early-termination game-filtered sorts
- VACUUM — contiguous page layout for better range-request cache locality

At startup `app.ts` checks `sqlite_master` for `clips_meta` and sets
`state.useMeta`. When true:

- `initCalendar` reads `min_date`/`max_date` from `clips_meta` instead of a
  `MIN/MAX(created_at)` full scan
- `updateGameFilter` reads from `game_clip_counts` when no date filter is active
- `render()` reads `total_clips` from `clips_meta` when no filters are active

Falls back to live aggregate queries when `useMeta` is false (raw dev-symlink
DB, or a DB prepared before this feature was added).

### DB file requirements for sql.js-httpvfs

- Must be in **DELETE journal mode** (not WAL). `prepare_web_db.py` handles this.
- In the main repo, `frontend/public/clips.db` is a symlink to `../../data/clips.db`
  (the raw scraper output). In git worktrees, symlink it to the main repo's
  `frontend/public/clips.db`. The prepared file for production is a real file
  written by `prepare-db`.
- The symlink is gitignored; the prepared DB is also gitignored (too large for git).

### Date arithmetic and timezone

All date utilities (`lib/dateUtils.ts`) use integer-argument `Date` constructors
(`new Date(y, m, d)`) and avoid string parsing to prevent UTC/local timezone
pitfalls. The `calDateTo` stored in state is always an *exclusive* upper bound
(e.g. "Feb 1" for a Jan 31 selection); `syncDateInputs()` converts it to
inclusive for display.

`calDateFrom` and `calDateTo` are stored as `YYYY-MM-DD` local date strings.
All SQL queries and live-clip filters convert them to UTC ISO bounds via
`localDateToUtcBound(dateStr, state.tzOffset)` before comparison with
`created_at` (which is always stored as UTC ISO). Calendar SQL uses
`tzToSqlModifier(state.tzOffset)` as a strftime modifier so clips group by
local date. Display timestamps are shifted by `state.tzOffset` minutes and
rendered with `timeZone: 'UTC'` to produce the equivalent local time.

Caveat: a fixed offset is used per query. Clips within ~1 hour of midnight on
DST-transition nights may bucket to the wrong calendar day (see
`docs/future-work.md`). localStorage key for persisting user preference:
`tc_tz_offset`.

### Twitch OAuth login (`auth.ts`, `lib/pkce.ts`)

Uses the **implicit grant** flow (`response_type=token`) rather than PKCE,
because Twitch public clients do not support PKCE for the clips endpoint.
`auth.ts` handles initiation, the OAuth callback, token storage (localStorage
with expiration), and logout. `lib/pkce.ts` contains reusable crypto helpers
(`randomBase64url`, `sha256Base64url`) built on the Web Crypto API.

The Twitch client ID is injected at build time via `VITE_TWITCH_CLIENT_ID`.
As a local-dev fallback, `vite.config.ts` reads `web_client_id` from
`config.toml` if the env var is unset. The app degrades gracefully with no
client ID — the login button is hidden and live-clip features are disabled.

### Live clips (`twitch.ts`, `lib/liveFilter.ts`)

`twitch.ts` fetches clips from the Helix API newer than the DB's most recent
clip (`_dbCutoffDate` in `app.ts`). It auto-paginates (100 clips per page) and
resolves game names in a second batch request.

Live clips are stored in `state.liveClips` and filtered client-side by
`filterLiveClips(opts)` from `lib/liveFilter.ts` — a pure function that takes
`LiveFilterOpts` (clips array, cutoff date, date range, game filter, search query).

When `sortBy === 'date_desc'`, `render()` merges live clips directly into the
main grid rather than showing the separate collapsible panel. Live clips are
always newer than any archived clip, so they fill the first page(s); the
pagination math computes `liveOnPage`/`dbOnPage`/`dbOffset` for each page.
For other sort orders the separate `renderLiveSection()` panel is shown instead,
because true interleaving would require loading all DB clips into memory.

After `fetchLiveClips()` completes, `updateLiveClipBounds()` in `calendar.ts`
is called to extend `calMaxDate` (and the year-select options) if live clips are
newer than the DB cutoff. The calendar heat-map counts also include live clips:
`liveDayCountsForYear/Month` aggregate `state.liveClips` in-memory and merge
into the DB query results in `renderYearView`, `renderYearStrip`, and
`renderMonthGrid`.

### Internationalization (`lib/i18n.ts`)

Supports **English** (`en`) and **Japanese** (`ja`). Key exports:
`t(key)`, `lang`, `setLang(lang)`, `detectLang()`. `app.ts` calls
`applyTranslations()` on init and language change to sync strings into the DOM.
To add a language, extend the translation map in `i18n.ts` and add a UI control.

**Rule: no English in `index.html`.** The page defaults to Japanese (`lang="ja"`
on `<html>`). Every user-visible string in `index.html` — including `title`,
`placeholder`, `aria-label`, and text content — must use the Japanese translation
as its static initial value. Strings that `applyTranslations()` already
overwrites must still default to Japanese in the HTML so there is no flash of
English before the script runs. When adding any new user-visible element:

1. Add the translation key to the `Translations` interface in `i18n.ts`.
2. Add both `en` and `ja` values in the two dictionaries.
3. Wire the element in `applyTranslations()` so the string updates on language
   toggle.
4. Set the Japanese string as the initial value in `index.html`.

**Japanese game names**: The scraper stores a `name_ja` column in the `games`
table (populated via `lib/igdb.py` — IGDB for real games, Twitch's own web
directory pages as a fallback for non-game categories like "Just Chatting").
`prepare_web_db.py` carries `name_ja` into `game_clip_counts`. At render time:

- `updateGameFilter()` labels each option with `name_ja` when `lang === 'ja'`
  and a Japanese name exists, falling back to the English `name`.
- `clipCardHtml()` receives `game_name_ja` (from a `COALESCE(g.name_ja, '')`
  join) and uses it in place of `game_name` when `lang === 'ja'`.
- Live clips (from `twitch.ts`) do not carry `game_name_ja` from the API.
  `app.ts` maintains a module-level `_gameNameJa: Map<string, string>` (populated
  by `updateGameFilter()` on every render) and uses it to supply `game_name_ja`
  when building live-clip items, so they show the correct language alongside DB
  clips.
- `render()` is called on language toggle, so game names switch language
  immediately without a page reload.

## TypeScript configuration notes

- `"moduleResolution": "bundler"` — required for Vite's import resolution.
- `"noUncheckedIndexedAccess": true` — array/object index access returns
  `T | undefined`. Use `arr[i]!` only when you are certain the index exists,
  and leave a comment explaining why.
- `"types": ["vite/client"]` — enables `?url` and `?worker` import suffixes.
- `skipLibCheck: true` — sql.js-httpvfs's bundled `.d.ts` files have type gaps;
  fighting them wastes time.

## Known issues / future work

See [`docs/future-work.md`](../docs/future-work.md) for deferred items,
known quirks, and their rationale.

## Testing

```sh
npm test             # Vitest, all pure functions, fast (~0.5 s)
npm run test:watch   # re-run on change
```

Tests cover: `buildWhere` combinations, `serializeHash`/`deserializeHash`
round-trips, date utilities, format helpers, live clip filtering, and OAuth
crypto helpers. The render pipeline and DOM interactions are not unit-tested
(they require a live DB and browser environment).
