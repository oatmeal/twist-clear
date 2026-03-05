# Future work

Deferred items with rationale. See the relevant source files for implementation notes.

---

## Live clips: merge into non-date_desc sort orders

Live clips are currently merged into the main grid only when `sortBy ===
'date_desc'` (see `render()` in `app.ts`). For the other three sort orders
(**Most Viewed**, **Least Viewed**, **Oldest First**) they fall back to the
separate collapsible panel.

True interleaving for view-count or date-ascending sorts requires ranking live
clips against archive clips in a single sorted sequence. Because live clips are
in memory and archive clips are in the DB, a correct merge would require one of:

- **Load all DB clips into memory** and sort the combined set client-side.
  Defeats the sql.js-httpvfs range-request optimisation for large archives.
- **Push live clips into a temporary in-memory SQLite table** via the worker,
  then join against archive clips in SQL. The sql.js-httpvfs worker API does
  not currently expose DDL/write commands on the HTTP-backed database, so this
  would require a patched or separate in-memory db instance.
- **Server-side merge** — only applicable if the site is ever served by a
  backend rather than GitHub Pages.

The pragmatic middle ground already shipped: merge when `sortBy ===
'date_desc'` (live clips are always newest so offset math is trivial), show
the panel otherwise.

If the number of live clips is small (typical between scraper runs), a
simpler approach for view-count sorts may be acceptable: fetch all live clips
client-side (already in memory), fetch all DB clips up to some cap (e.g. top
N by view count), merge and re-sort. This is correct only when live clips
cannot outrank DB clips beyond the cap — i.e. when the cap is large enough.

---

## Game filter: large data transfers due to non-covering index

When filtering by game, the main clips SELECT requires columns (`title`,
`creator_name`, `view_count`, `duration`, `thumbnail_url`, `url`) that are not
in the `clips_game_created` index `(game_id, created_at DESC)`. SQLite uses the
index to find matching rowids in sort order, then does one random table-page
lookup per row to fetch the remaining columns. With `LIMIT 24`, that is 24
separate table-page reads. Because clips for a game are inserted interleaved
with clips from other games, those rows are scattered across the table B-tree
even after VACUUM; each lookup likely misses the cache and triggers a new
exponential read-ahead cycle, totalling many MB.

The COUNT fast path (`game_clip_counts`) was added to eliminate the separate
count scan, but the main fetch is the dominant cost.

Potential fixes (in order of implementation effort):

- **Wider covering index** — add all selected columns to `clips_game_created`
  so the query never touches the table. This duplicates storage but makes
  game-filtered pages entirely index-resident.
- **Table clustering by `(game_id, created_at DESC)`** — in
  `prepare_web_db.py`, recreate the clips table with rows inserted in
  `(game_id, created_at DESC)` order so rowids reflect that order and table
  lookups are sequential. Requires rewriting the prepare script and a full
  VACUUM. Effective for date-desc game queries; less so for view-count sorts.
- **Precomputed per-game page table** — materialise the top-N clips per game
  into a separate table during `prepare_web_db.py`, keeping all needed columns
  contiguous on disk. Trades preparation complexity for near-zero runtime I/O.

---

## Live clips: calendar heat map integration

The calendar year/month views aggregate clip counts directly from SQLite. Live
clips exist only in memory and are not reflected in the heat map or day-count
queries.

Adding them would require either a separate in-memory aggregation pass (summing
live clips per day/month) and merging the result into the calendar cell rendering,
or injecting live counts into the calendar after the DB query returns.

Deferred as low priority — the "New clips since [date]" label in the live section
makes the archive cutoff visible, and the calendar is primarily useful for
navigating the historical archive.

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

## Content Security Policy: frame-ancestors

The CSP is set via a `<meta>` tag because GitHub Pages does not support custom
HTTP headers. The `frame-ancestors` directive (which prevents the site from being
embedded in iframes on other origins — clickjacking protection) is silently
ignored in meta-tag CSPs; it is only effective as an HTTP header.

If the site is ever deployed behind a proxy or server that can set custom headers
(Cloudflare, nginx, etc.), add `frame-ancestors 'self'` as an HTTP header to
enable this protection.

---

## i18n: translate new auth/live-clips UI to Japanese

The following strings added with the login feature are English-only and need
Japanese translations added to the `t()` locale map in `app.ts`:

- Login banner text ("This archive has clips through … Log in with Twitch to
  see newer clips.")
- Live section title ("N new clips since …")
- Live section toggle button labels ("Show" / "Collapse")
- Auth indicator / username display area
- Any error or loading states in the live clips section

---

## buildWhere: calDateTo null edge case

When `calDateFrom` is non-null but `calDateTo` is null, the non-null assertion
`opts.calDateTo!` in `buildWhere` silently binds `null`, producing
`created_at < NULL` which is always false and returns no results.

Low practical risk — the UI always sets both date fields together — but could
bite a future caller that sets only one. Fix: add an explicit guard in
`buildWhere` and/or remove the non-null assertion. Documented in
`query.test.ts`.

---

## LIKE search: unescaped wildcards

`buildWhere` passes the raw user search string into a `LIKE` pattern without
escaping `%` or `_`, so those characters act as SQL wildcards. Mostly harmless
for a personal viewer; to fix, escape them before interpolation and add an
`ESCAPE` clause. Documented in tests.

---

## FTS5 MATCH: raw user string

`buildWhere` passes the user's search string directly to `clips_fts MATCH`,
so FTS5 operators (`OR`, `AND`, `*`, `"phrase"`) are interpreted literally.
This is occasionally useful but can also produce confusing results or errors
for malformed queries. Fix: sanitize or quote the input before passing to
MATCH. Documented in tests.
