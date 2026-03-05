# Future work

Deferred items with rationale. See the relevant source files for implementation notes.

---

~~Live clips: merge into view-count sort orders~~ — **Implemented.**

Live clips are now merged into the main grid for all four sort orders. For
`view_count_desc`/`view_count_asc`, `rankLiveClips()` in `lib/liveRank.ts`
runs one `COUNT(*)` per unique `(view_count, created_at)` pair to find each
live clip's rank in the DB sequence. The composite
`clips_view_count(view_count DESC, created_at DESC)` index makes each COUNT
an O(log N) range scan. Multiple live clips sharing the same sort key
(same view count and timestamp) share a single query.

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
