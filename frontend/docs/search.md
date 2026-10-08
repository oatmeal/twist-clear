# Search — FTS5 trigram + boolean syntax

## Overview

`prepare_web_db.py` adds a `clips_fts` virtual table with `tokenize='trigram'`
(requires SQLite ≥ 3.38). At startup `app.ts` queries `sqlite_master` to check
whether the table exists and sets `state.useFts`. When `useFts` is true,
`buildWhere` calls `parseSearchQuery()` (`lib/searchParser.ts`) to translate the
user's input into a safe FTS5 MATCH expression before passing it as `:search`.

## Fallback chain

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

## Query plans (`INDEXED BY`)

Every page SQLite reads is an HTTP range request, and sql.js-httpvfs's
read-ahead doubles on sequential reads, so a plan that touches the clips table
row by row costs megabytes. SQLite's own plans for a search do exactly that:

- **FTS** (`c.rowid IN (SELECT rowid FROM clips_fts WHERE clips_fts MATCH
  :search)`): builds the match list, then looks up every matching row in
  `clips` — to read `created_at` or `view_count`, or to sort. For a common term
  that is most of the table: りりまる (≈3,100 of ≈28,500 clips) touched ≈1,850
  4 KB pages, ≈13 MB of range requests, for the result count, the first page
  of clips and any aggregate alike.
- **LIKE** (terms under 3 characters, see above): scans every title in the
  table, ≈13 MB.

`lib/query.ts` picks an `INDEXED BY` hint per query shape instead, using the
indexes `prepare_web_db.py` builds (listed in `docs/metadata.md`). Hints apply
only when the DB has all of them (`HINT_INDEXES`, checked in `sqlite_master` at
startup into `state.useIndexHints` — `INDEXED BY` a missing index is an error).
`buildWhere()` reports how the search matched (`search: 'fts' | 'like' | null`).

| Helper | Used by | Plan |
|---|---|---|
| `aggregateHint()` | timeline, calendar heat-map (per day), preview strip (per game), result count | LIKE → `clips_title` (title, created_at, game_id): one 2.8 MB scan covers every aggregate; a game filter → SQLite's (an FTS count seeks each match in `clips_game` (game_id, rowid)); else `clips_created_at_game`, also without a search, so the timeline's scan at startup leaves it cached for everything date-based |
| `countSql()` | result count | FTS search only: `COUNT(*)` from `clips_fts` alone (5–15 pages); otherwise `aggregateHint()` |
| `listHint()` | clip list + page-boundary probes | given the result count: > `MANY_MATCHES` (300), or a game with no other filter → walk the sort's index (`clips_created_at_game` / `clips_view_count`, or the game's `clips_game_created` / `clips_game_views`) and stop when the page is full; few matches → collect them and sort: LIKE from `clips_title`, FTS + game by seeking `clips_game`, a date range from that range, FTS alone with SQLite's plan (a few row lookups) |

The startup timeline needs the hint too: without one SQLite scans the smallest
index holding `created_at`, which is `clips_view_count`, and the calendar's
queries would then read a second index.

Measured on the dev server (28,488 clips): DB bytes fetched for a filter
change after the initial load, summing the `content-length` of `clips.db` GET
responses in a `scripts/qa-browser.mjs` script (`page.on('requestfinished')`;
open the app, wait for the requests to stop, set `location.hash`, wait again).
The initial load itself is ≈1.1 MB either way. For a single query, `.stats on`
in the sqlite3 CLI prints its "Page cache misses" (4 KB pages, before
read-ahead) — use Homebrew's `sqlite3`: Apple's `/usr/bin/sqlite3` gives
different counts from run to run. The browser runs SQLite 3.35, whose planner
can differ from the CLI's, so check plans in the browser.

| Filter | Before | After |
|---|---|---|
| Overwatch (8,448 clips), most viewed | 14.3 MB | 616 KB |
| Minecraft (876), most viewed | 13.4 MB | 172 KB |
| Overwatch + 2024, most viewed | 2.2 MB | 648 KB |
| 2024, most viewed | 4.3 MB | 84 KB |
| Calendar open on 2024, hovering three months | 64 KB | 0 KB |
| りりまる (3,143), newest / most viewed | 112 / 172 KB | 112 / 180 KB |
| りりまる + 2024, newest | 276 KB | 148 KB |
| りりまる + Overwatch, most viewed | 1.5 MB | 824 KB |
| りりまる, calendar open on 2024, hovering three months | 1.1 MB | 112 KB |
| 神回 (13 matches, LIKE), newest | 13.3 MB | 2.8 MB |
| 猫 (270, LIKE), most viewed | 18.4 MB | 3.6 MB |
| OW (1,981, LIKE), newest | 13.3 MB | 4.9 MB |
| w (3,055, LIKE), most viewed | 18.4 MB | 3.3 MB |

(Before: the FTS-only hints of the previous version, on a DB without
`clips_game_views` / `clips_title`.) A LIKE search's 2.8 MB is the
`clips_title` scan, paid once per session; with many matches the list then
walks the sort index looking up rows for their titles (≈2 MB for OW).
`clips_title` is built after the VACUUM so it sits at the end of the file:
in the middle, a scan's last read-ahead doubling fetched 4 MB of the indexes
after it.

## Boolean syntax

Supported boolean syntax: space-separated terms are implicit AND; `OR` or `|`
for OR; `-word`, `-"phrase"`, or `-(A OR B)` to exclude. The `-` operator is
strictly binary (matching FTS5's own NOT semantics): it binds tightly to exactly
one atom on its right, so `mario -(zelda OR link)` emits
`"mario" NOT ("zelda" OR "link")` for FTS5 and expands via De Morgan for the
LIKE fallback (`NOT (A OR B)` → `NOT A AND NOT B`). Full-width space (`\u3000`)
is normalized to ASCII space globally. Full-width minus (`\uff0d`) is recognized
as a NOT-operator alias only at the start of a token — inside a bare word it is
preserved as-is, so searches for titles containing `－` work correctly. Each
bare term is wrapped in FTS5 double-quotes to neutralize any special characters
in the term text.

## Help modal

A `?` / Help button in `#header-controls` opens a general "How to use" modal
(`#search-help-modal`, `id="btn-help"`) covering browsing, timezone, layout,
sort, game filter, search syntax (translated EN/JA), date filtering, login, and
URL sharing.

**Keeping the help modal up to date**: The modal has one `<section
class="help-section">` per major feature, in the order: browsing → timezone →
layout → sort → game → search → date → login → share. When a feature is added,
removed, or its behaviour changes in a user-visible way:

1. Update (or add/remove) the relevant `<section>` in `index.html`.
2. Update the corresponding i18n keys in `src/lib/i18n.ts` — heading key
   `help<Feature>`, description key `help<Feature>Desc` — for both `en`
   and `ja`.
3. Wire the new elements in the "Help modal" block of `applyTranslations()`
   in `app.ts`.
4. Default text in `index.html` must be Japanese (house rule: no English in
   static HTML).
