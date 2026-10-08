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

SQLite's own plan for the FTS filter, `c.rowid IN (SELECT rowid FROM clips_fts
WHERE clips_fts MATCH :search)`, builds the match list and then looks up every
matching row in `clips` — to read `created_at` or `view_count`, or to sort.
For a common term that is most of the table: りりまる (≈3,100 of ≈28,500 clips)
touches ≈1,850 4 KB pages, and sql.js-httpvfs's read-ahead turns those into
≈13 MB of range requests — for the result count, the first page of clips, and
any aggregate alike. Walking an index in date or view order and probing the
match list instead reads the index plus the rows actually returned.

`lib/query.ts` picks a hint per query shape; `buildWhere()` reports whether the
search went through FTS (`fts`), and hints apply only then, and only when the DB
has all the indexes they name (`state.useIndexHints`, checked in
`sqlite_master` at startup — `INDEXED BY` a missing index is an error):

| Helper | Used by | Plan |
|---|---|---|
| `countSql()` | result count | search only: `COUNT(*)` from `clips_fts` alone (5–15 pages); with a date range: `clips_created_at`; with a game: SQLite's (`clips_game_created`) |
| `listHint()` | clip list + page-boundary probes | given the result count: > `MANY_MATCHES` (300) → walk the sort's index (`clips_created_at` / `clips_view_count`) and stop when the page is full; a date range → walk `clips_created_at` within it; few matches and no range → SQLite's (a few row lookups beat walking a whole index); a game filter → SQLite's, except a view sort over many matches |
| `byDayHint()` | timeline, calendar heat-map | no game filter → `clips_created_at` |
| `byGameHint()` | calendar preview strip | no game filter → `clips_created_at_game` (covering) |

Measured on the dev server: DB bytes fetched after the initial load (28,488
clips), summing the `content-length` of `clips.db` GET responses in a
`scripts/qa-browser.mjs` script (`page.on('response')`; skip the size-probe
HEAD). For a single query, `.stats on` in the sqlite3 CLI prints its "Page
cache misses" — 4 KB pages, before read-ahead.

| Search | Before | After |
|---|---|---|
| りりまる (3,143 matches), newest first | 13.4 MB | 112 KB |
| りりまる, most viewed | 13.4 MB | 172 KB |
| ダイヤ (751) | 13.4 MB | 156 KB |
| エメラルド (4) | 72 KB | 72 KB |
| りりまる + a quarter's date range | 13.9 MB | 208 KB |

LIKE fallbacks (terms under 3 characters) are untouched: they scan the whole
table (≈13 MB) once, and later queries hit the cache.

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
