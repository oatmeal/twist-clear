# Future work

Deferred items with rationale. See the relevant source files for implementation notes.

---

## Small issues

Fixes:
- date inputs require both to be set? Maybe make a little more obvious with an explicit "set" button or more feedback?
- Browse clears time filter; but it's not that obvious yet


Other stuff required before release:
- About page with more description linking to GitHub, etc. (generate with deploy.yml?)

Later:
- template repo: fork + change settings to deploy an archive for a streamer

---

## Combine language / timezone in settings?

Maybe there's a neater UI for this?

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

## FTS5 MATCH: raw user string

`buildWhere` passes the user's search string directly to `clips_fts MATCH`,
so FTS5 operators (`OR`, `AND`, `*`, `"phrase"`) are interpreted literally.
This is occasionally useful but can also produce confusing results or errors
for malformed queries. Fix: sanitize or quote the input before passing to
MATCH. Documented in tests.

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
