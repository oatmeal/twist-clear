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
