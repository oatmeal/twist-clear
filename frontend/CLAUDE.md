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
  embed.ts      # Clip embed expand/collapse, prev/next navigation (grid + list)
  state.ts      # All shared mutable state + explicit typed setters
  twitch.ts     # Helix API client for live clips (auto-paginates, resolves game names)
  lib/
    clipHtml.ts   # ClipItem type + clipCardHtml/clipListRowHtml/attachImgErrorHandlers
                  #   Pure HTML template functions; tzOffset is an explicit param (no state import)
    dateUtils.ts  # Timezone-aware date arithmetic + UTC-offset helpers
    format.ts     # escHtml, fmtDuration, fmtViews, fmtDateTime
    hash.ts       # Pure serializeHash() / deserializeHash() — URL hash state
    i18n.ts       # English & Japanese translations; t(), detectLang(), setLang()
    liveCoverage.ts # Pure bisectCoverage() / fetchWithCoverage() — 0-clip coverage via bisection
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

## Feature docs

Detailed write-ups for specific features live in `frontend/docs/`:

- [`docs/search.md`](docs/search.md) — FTS5 trigram search, boolean syntax, help modal
- [`docs/live-clips.md`](docs/live-clips.md) — twitch.ts, liveFilter, calendar/game-filter integration
- [`docs/i18n.md`](docs/i18n.md) — translations, Japanese game names, no-English-in-HTML rule
- [`docs/layout.md`](docs/layout.md) — grid vs. list layout, embed rows, render loop
- [`docs/calendar.md`](docs/calendar.md) — calendar/date-filter decoupling, controls
- [`docs/metadata.md`](docs/metadata.md) — precomputed `clips_meta`, `game_clip_counts`, indexes

Colour theming is documented in [`docs/theming.md`](../docs/theming.md) (root-level).

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
saved to both localStorage and the URL hash.

### Circular dependency: calendar ↔ app, embed ↔ app

Both `calendar.ts` and `embed.ts` need to trigger a re-render in `app.ts`,
but `app.ts` imports from both modules. The same callback-injection pattern
breaks both cycles:

- `initCalendar(onRender)` — `calendar.ts` calls `void _onRender?.()` (fire
  and forget; the AbortController in `render()` handles deduplication).
- `initEmbed(render)` — `embed.ts` stores the callback in `_render` and calls
  `await _render?.()` when navigating across page boundaries.

### Pure functions for testability

`buildWhere(opts)` in `lib/query.ts`, `serializeHash`/`deserializeHash` in
`lib/hash.ts`, `filterLiveClips(opts)` in `lib/liveFilter.ts`, and the clip
HTML template functions in `lib/clipHtml.ts` all take their inputs as explicit
parameters and do not read from `state`. This makes them fully unit-testable
without a DOM or DB. In particular, `clipCardHtml` and `clipListRowHtml` accept
`tzOffset` as an explicit parameter rather than reading `state.tzOffset`
directly.

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

### DB file requirements for sql.js-httpvfs

- Must be in **DELETE journal mode** (not WAL). `prepare_web_db.py` handles this.
- In the main repo, `frontend/public/clips.db` is a symlink to `../../data/clips.db`
  (the raw scraper output). In git worktrees, symlink it to the main repo's
  `frontend/public/clips.db`. The prepared file for production is a real file
  written by `prepare-db`.
- The symlink is gitignored; the prepared DB is also gitignored (too large for git).

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
round-trips, date utilities, format helpers, live clip filtering, live coverage
bisection (suppression discovery, deduplication), OAuth crypto helpers,
`extractClipSlug` URL parsing, and `clipCardHtml`/`clipListRowHtml` HTML
structure, XSS escaping, game name language switching, and live-clip class.
The render pipeline and DOM interactions are not unit-tested (they require a
live DB and browser environment).
