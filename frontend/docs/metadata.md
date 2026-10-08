# Precomputed metadata (`useMeta`)

sql.js-httpvfs uses an exponential read-ahead strategy: each sequential page
miss doubles the next fetch size (4 KiB → 8 → 16 → … → 4 MiB). Aggregate
queries that touch many rows (MIN/MAX, GROUP BY game, COUNT(*)) each trigger one
of these chains and can transfer several MB from a cold cache.

## What's precomputed

`prepare_web_db.py` precomputes several things to replace the most expensive
startup aggregates with cheap single-page lookups:

- `clips_meta` — one row: `min_date`, `max_date`, `min_timestamp`,
  `max_timestamp`, `total_clips`. The raw `min/max_timestamp` columns store full
  UTC ISO timestamps so `initCalendar` can compute local calendar boundaries for
  any timezone via `utcTimestampToLocalDate`.
- `game_clip_counts` — one row per game: `id`, `name`, `name_ja`, `cnt` (no date filter)
- `clips_created_at` — index on `clips(created_at)` for date-range COUNT(*)
  and per-day GROUP BY (timeline, calendar)
- `clips_created_at_game` — covering index `(created_at, game_id)` for
  date-filtered game GROUP BY (index-only, no table access). Count it with
  `COUNT(*)`, not `COUNT(c.id)`: reading `id` forces a row lookup per clip
  (selecting a year in the calendar fetched 4.1 MB instead of 176 KB)

FTS searches force some of these with `INDEXED BY` — see "Query plans" in
`docs/search.md`.
- `clips_game_created` — index `(game_id, created_at DESC)` for
  early-termination game-filtered sorts
- VACUUM — contiguous page layout for better range-request cache locality

## Usage in app.ts

At startup `app.ts` checks `sqlite_master` for `clips_meta` and sets
`state.useMeta`. When true:

- `initCalendar` reads `min_date`/`max_date` from `clips_meta` instead of a
  `MIN/MAX(created_at)` full scan
- `updateGameFilter` reads from `game_clip_counts` when no date filter is active
- `render()` reads `total_clips` from `clips_meta` when no filters are active

Falls back to live aggregate queries when `useMeta` is false (raw dev-symlink
DB, or a DB prepared before this feature was added).
