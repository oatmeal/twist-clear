# CLAUDE.md — project guide for AI assistants

## What this repo is

Two components in one repository:

1. **Python scraper** (`scrape.py`, `lib/`) — fetches Twitch clip metadata via the Helix API using adaptive time-windowing and stores it in a local SQLite database.
2. **Browser viewer** (`frontend/`) — a TypeScript + Vite SPA that queries the database directly in the browser using [sql.js-httpvfs](https://github.com/phiresky/sql.js-httpvfs) (HTTP Range requests; the full DB is never downloaded).

## Repository layout

```
scrape.py               # CLI entry point (fetch / update subcommands)
lib/
  api.py                # Twitch Helix API client
  db.py                 # SQLite schema + upsert helpers
prepare_web_db.py       # Build a browser-ready copy of clips.db
tests/                  # pytest tests for the scraper
frontend/
  src/
    main.ts             # Entry point
    app.ts              # Render loop, event binding, URL hash state
    calendar.ts         # Calendar view (year → month → day/week)
    db.ts               # sql.js-httpvfs worker init; async q() helper
    state.ts            # All shared mutable state + typed setters
    lib/
      query.ts          # Pure buildWhere() — SQL WHERE clause builder
      hash.ts           # Pure serializeHash() / deserializeHash()
      format.ts         # escHtml, fmtDuration, fmtViews, fmtDateTime
      dateUtils.ts      # Local-timezone date arithmetic
    __tests__/          # Vitest unit tests (88 tests)
  index.html
  vite.config.ts
  tsconfig.json
  package.json
```

## Development commands

### Python scraper

```sh
uv run python scrape.py fetch    # full historical scrape
uv run python scrape.py update   # incremental update

uv run pytest                    # tests
uv run ruff check .              # lint
uv run ruff format .             # format
```

### Frontend

```sh
cd frontend
npm install
npm run dev          # Vite dev server → http://localhost:5173
npm test             # Vitest unit tests (88 tests, ~0.5 s)
npx tsc --noEmit     # type-check

# Build a browser-ready DB (DELETE journal mode + FTS5 index):
npm run prepare-db   # → writes frontend/public/clips.db

npm run build        # production Vite build → frontend/dist/
                     # requires frontend/public/clips.db to exist (run prepare-db first)
```

Dev servers are configured in `.claude/launch.json`.

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

### Circular dependency: calendar ↔ app

`calendar.ts` needs to trigger a re-render in `app.ts`, but `app.ts` imports
from `calendar.ts`. To break the cycle, `initCalendar(onRender)` accepts a
callback injected by `app.ts`. `calendar.ts` calls `void _onRender?.()` (fire
and forget; the AbortController in `render()` handles deduplication).

### buildWhere is a pure function

`buildWhere(opts)` in `src/lib/query.ts` takes all filter state as explicit
parameters — it does not read from the `state` module. This makes it fully
unit-testable without DOM or DB. Similarly, `serializeHash` / `deserializeHash`
are pure functions in `src/lib/hash.ts`.

### FTS5 trigram search

`prepare_web_db.py` adds a `clips_fts` virtual table with `tokenize='trigram'`
(requires SQLite ≥ 3.38). At startup `app.ts` queries `sqlite_master` to check
whether the table exists and sets `state.useFts`. When `useFts` is true,
`buildWhere` routes 3+-character title searches through
`clips_fts MATCH :search` instead of `LIKE`. With fewer than 3 characters it
always falls back to LIKE (trigram minimum).

### DB file requirements for sql.js-httpvfs

- Must be in **DELETE journal mode** (not WAL). `prepare_web_db.py` handles this.
- `frontend/public/clips.db` in dev is a symlink → `data/clips.db` (5 levels up).
  The prepared file for production/build is a real file written by `prepare-db`.
- The symlink is gitignored; the prepared DB is also gitignored (too large for git).

### Date arithmetic

All date utilities (`src/lib/dateUtils.ts`) use integer-argument `Date`
constructors (`new Date(y, m, d)`) and avoid string parsing to prevent UTC/local
timezone pitfalls. The `calDateTo` stored in state is always an *exclusive*
upper bound (e.g. "Feb 1" for a Jan 31 selection); `syncDateInputs()` converts
it to inclusive for display.

## TypeScript configuration notes

- `"moduleResolution": "bundler"` — required for Vite's import resolution.
- `"noUncheckedIndexedAccess": true` — array/object index access returns
  `T | undefined`. Use `arr[i]!` only when you are certain the index exists, and
  leave a comment explaining why.
- `"types": ["vite/client"]` — enables `?url` and `?worker` import suffixes.
- `skipLibCheck: true` — sql.js-httpvfs's bundled `.d.ts` files are not
  perfectly typed; fighting them wastes time.

## Known issues / technical debt

- `buildWhere`: when `calDateFrom` is non-null but `calDateTo` is null, the
  non-null assertion `opts.calDateTo!` silently binds `null`, causing
  `created_at < NULL` (always false). Documented in `query.test.ts`. Low
  practical risk: the UI always sets both fields together.
- LIKE search does not escape `%` or `_` in user input — they act as SQL
  wildcards. Documented in tests; acceptable behaviour for a personal viewer.
- FTS5 MATCH passes the raw user string; operators like `OR`, `AND`, `*` are
  interpreted by FTS5. This is mostly harmless and occasionally useful.

## Testing

```sh
cd frontend && npm test   # Vitest, 88 tests, all pure functions
cd ../ && uv run pytest   # pytest, scraper unit tests
```

Tests for the frontend cover `buildWhere` combinations (including edge cases),
`serializeHash`/`deserializeHash` round-trips, date utility functions, and
formatting helpers. The render pipeline and DOM interactions are not unit-tested
(they require a live DB and browser).
