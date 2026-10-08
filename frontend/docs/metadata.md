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
- `clips_created_at_game` — covering index `(created_at, game_id)` for every
  date aggregate: the timeline's per-day counts (a full scan at startup), the
  calendar heat-map, date-range COUNT(*), and date-filtered game GROUP BY — all
  index-only, and after the startup scan, all cached. Count it with
  `COUNT(*)`, not `COUNT(c.id)`: reading `id` forces a row lookup per clip
  (selecting a year in the calendar fetched 4.1 MB instead of 176 KB). It
  replaced a plain `clips_created_at` index, which the timeline scanned while
  the calendar's per-game counts read this one.
- `clips_view_count` — `(view_count DESC, created_at DESC)` for "most viewed"
- `clips_game` `(game_id)`, `clips_game_created` `(game_id, created_at DESC)`,
  `clips_game_views` `(game_id, view_count DESC, created_at DESC)` — a game
  filter walks one game's clips in sort order and stops after a page; a title
  search within a game seeks each match in `clips_game`, whose key is
  `(game_id, rowid)`
- `clips_title` — `(title, created_at, game_id)` for LIKE searches (under 3
  characters): a scan of it is a quarter of the table's and covers every
  aggregate. Built after VACUUM, at the end of the file (see "Query plans" in
  `docs/search.md`)
- VACUUM — contiguous page layout for better range-request cache locality

The scraper's `clips_broadcaster_created` index is dropped (one streamer per
archive). Searches force some of these indexes with `INDEXED BY` — see "Query
plans" in `docs/search.md`, which also has measurements.

## Usage in app.ts

At startup `app.ts` checks `sqlite_master` for `clips_meta` and sets
`state.useMeta`. When true:

- `initCalendar` reads `min_date`/`max_date` from `clips_meta` instead of a
  `MIN/MAX(created_at)` full scan
- `updateGameFilter` reads from `game_clip_counts` when no date filter is active
- `render()` reads `total_clips` from `clips_meta` when no filters are active

Falls back to live aggregate queries when `useMeta` is false (raw dev-symlink
DB, or a DB prepared before this feature was added).
