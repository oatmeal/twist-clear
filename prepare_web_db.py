#!/usr/bin/env python3
"""prepare_web_db.py — build a browser-ready copy of clips.db.

Usage:
    python prepare_web_db.py <source_db> <output_db>

What this script does
---------------------
1. Copies the source database using SQLite's backup API (gives a clean,
   WAL-safe snapshot regardless of the source journal mode).
2. Switches the output to DELETE journal mode — required by sql.js-httpvfs,
   which cannot read WAL-mode databases.
3. Normalises clips with no Twitch game category: inserts a synthetic
   games row ('__none__', 'No Category') and coerces NULL game_id clips
   to '__none__' so they appear as a filterable option in the browser.
4. Creates and populates a FTS5 trigram virtual table (`clips_fts`) for fast
   substring title search in the browser.  The trigram tokenizer requires
   SQLite >= 3.38 and enables substring matching without a leading wildcard.
5. Optimises the FTS index (merges all segments into one) so fewer HTTP Range
   requests are needed when searching.
6. Builds precomputed metadata tables (clips_meta, game_clip_counts) and
   the indexes the browser's query plans name, so it avoids full-table-scan
   aggregates; drops indexes it doesn't use.
7. VACUUMs the output file to remove any slack space and produce a compact,
   contiguous layout that is friendlier to range-request caching.
8. Builds the title index for short searches last, at the end of the file.

The output file is intended to be placed in `frontend/public/` and served
statically.  In development the `npm run prepare-db` script in `frontend/`
runs this script automatically.
"""

from __future__ import annotations

import os
import sqlite3
import sys

MIN_SQLITE = (3, 38, 0)  # trigram tokenizer requires 3.38+


def _check_sqlite_version() -> None:
    current = tuple(int(x) for x in sqlite3.sqlite_version.split("."))
    if current < MIN_SQLITE:
        min_str = ".".join(str(x) for x in MIN_SQLITE)
        print(
            f"Error: SQLite {sqlite3.sqlite_version} is too old; "
            f"the FTS5 trigram tokenizer requires {min_str}+.",
            file=sys.stderr,
        )
        sys.exit(1)


def prepare(src_path: str, dst_path: str) -> None:
    _check_sqlite_version()

    # ── 1. Copy via backup API ────────────────────────────────────────────
    # Remove any existing file or symlink at the destination.
    if os.path.lexists(dst_path):
        os.unlink(dst_path)
    os.makedirs(os.path.dirname(os.path.abspath(dst_path)), exist_ok=True)

    print(f"Copying {src_path} → {dst_path} …")
    src_conn = sqlite3.connect(src_path)
    dst_conn = sqlite3.connect(dst_path)
    src_conn.backup(dst_conn)  # atomic, WAL-safe snapshot
    src_conn.close()
    print("  done.")

    # Work entirely in autocommit mode so PRAGMAs and VACUUM have no
    # surrounding transaction to worry about.
    dst_conn.isolation_level = None

    # ── 2. Switch to DELETE journal mode ─────────────────────────────────
    print("Setting journal_mode=DELETE …")
    row = dst_conn.execute("PRAGMA journal_mode=DELETE").fetchone()
    print(f"  journal_mode is now: {row[0]}")

    # ── 3. Normalise NULL game_id clips ───────────────────────────────────
    # Twitch returns game_id="" for clips from streams with no category set
    # (unregistered games, pure IRL streams, etc.).  The scraper stores these
    # as NULL.  Coerce them to the sentinel '__none__' and add a matching
    # games row so they appear as a filterable "No Category" option in the
    # browser's game dropdown instead of being silently grouped into "All Games".
    print("Normalising NULL game_id clips …")
    dst_conn.execute(
        "INSERT OR IGNORE INTO games (id, name, name_ja)"
        " VALUES ('__none__', 'No Category', 'カテゴリなし')"
    )
    dst_conn.execute("UPDATE clips SET game_id = '__none__' WHERE game_id IS NULL")
    print("  done.")

    # ── 5. Create FTS5 trigram table ──────────────────────────────────────
    # content=clips makes this a content table — the text is not stored
    # twice; FTS5 reads it from `clips.title` via the rowid when needed.
    # tokenize='trigram' indexes all 3-character substrings so MATCH can
    # find substrings without a leading wildcard (and works for CJK/Japanese).
    print("Creating FTS5 trigram table …")
    dst_conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS clips_fts
        USING fts5(
            title,
            content = clips,
            tokenize = 'trigram'
        )
    """)
    print("  done.")

    # ── 6. Populate and optimise the FTS index ────────────────────────────
    print("Rebuilding FTS index (this may take a moment) …")
    dst_conn.execute("INSERT INTO clips_fts(clips_fts) VALUES('rebuild')")
    print("  done.")

    print("Optimising FTS index (merging segments) …")
    dst_conn.execute("INSERT INTO clips_fts(clips_fts) VALUES('optimize')")
    print("  done.")

    # ── 7. Precomputed metadata tables ────────────────────────────────────
    # These tiny tables let the browser avoid full-table-scan aggregates on
    # every page load.  Each is a cheap single-page read instead of an
    # O(n) scan that triggers sql.js-httpvfs's exponential read-ahead.

    # clips_meta: min/max clip dates + total clip count
    # min_timestamp / max_timestamp store the full ISO-8601 UTC strings so the
    # browser can compute the correct local calendar boundary for any timezone.
    print("Creating clips_meta table …")
    dst_conn.execute("DROP TABLE IF EXISTS clips_meta")
    dst_conn.execute("""
        CREATE TABLE clips_meta AS
        SELECT
            substr(MIN(created_at), 1, 10) AS min_date,
            substr(MAX(created_at), 1, 10) AS max_date,
            MIN(created_at) AS min_timestamp,
            MAX(created_at) AS max_timestamp,
            COUNT(*) AS total_clips
        FROM clips
    """)
    print("  done.")

    # game_clip_counts: per-game clip counts (no date filter).
    # The browser uses this for the game dropdown on initial load; live
    # aggregate queries are still run when a date filter is active.
    print("Creating game_clip_counts table …")
    dst_conn.execute("DROP TABLE IF EXISTS game_clip_counts")
    dst_conn.execute("""
        CREATE TABLE game_clip_counts AS
        SELECT g.id, g.name, g.name_ja, COUNT(c.id) AS cnt
        FROM games g
        JOIN clips c ON c.game_id = g.id
        GROUP BY g.id
        ORDER BY cnt DESC
    """)
    print("  done.")

    # ── Indexes ───────────────────────────────────────────────────────────
    # The browser's query plans (frontend/src/lib/query.ts, which names these
    # in INDEXED BY — see "Query plans" in frontend/docs/search.md) need
    # exactly this set. Every full scan or row lookup costs HTTP range
    # requests, so each index is chosen to let a query read only index pages,
    # or stop after one page of clips.

    # The scraper's indexes the browser never uses (clips_broadcaster_created:
    # one streamer per archive), and clips_created_at, superseded by
    # clips_created_at_game below.
    print("Dropping indexes the browser doesn't use …")
    for name in ("clips_broadcaster_created", "clips_created_at"):
        dst_conn.execute(f"DROP INDEX IF EXISTS {name}")
    print("  done.")

    # Replace the single-column view_count index (if carried over from an older
    # source DB) with the composite (view_count, created_at) index that makes
    # the secondary tiebreak sort index-accelerated.  DROP IF EXISTS is safe to
    # run repeatedly; CREATE IF NOT EXISTS is a no-op when already present.
    print("Replacing clips_view_count index …")
    dst_conn.execute("DROP INDEX IF EXISTS clips_view_count")
    dst_conn.execute(
        "CREATE INDEX IF NOT EXISTS clips_view_count ON clips(view_count DESC, created_at DESC)"
    )
    print("  done.")

    # (created_at, game_id) — every date aggregate reads this one index: the
    # timeline's per-day counts (a full scan at startup), the calendar
    # heat-map, date-range counts, and per-game counts for a date range:
    #   SELECT game_id, COUNT(*) FROM clips
    #   WHERE created_at >= ? AND created_at < ?
    #   GROUP BY game_id
    # Both columns are in the index, so none of these touch the table, and
    # after the timeline's scan the rest are served from cache.
    print("Creating clips_created_at_game covering index …")
    dst_conn.execute(
        "CREATE INDEX IF NOT EXISTS clips_created_at_game ON clips(created_at, game_id)"
    )
    print("  done.")

    # Game-filtered queries.  The scraper's schema already has the first two;
    # IF NOT EXISTS covers source DBs that don't.
    #   clips_game         (game_id) — its key is (game_id, rowid), so a title
    #                      search within a game seeks each FTS match directly.
    #   clips_game_created — "newest first" walks one game's clips in order and
    #                      stops after a page.
    #   clips_game_views   — the same for "most viewed"; without it SQLite
    #                      sorts every clip of the game (≈14 MB for the
    #                      biggest one).
    print("Creating game indexes …")
    dst_conn.execute("CREATE INDEX IF NOT EXISTS clips_game ON clips(game_id)")
    dst_conn.execute(
        "CREATE INDEX IF NOT EXISTS clips_game_created ON clips(game_id, created_at DESC)"
    )
    dst_conn.execute(
        "CREATE INDEX IF NOT EXISTS clips_game_views"
        " ON clips(game_id, view_count DESC, created_at DESC)"
    )
    print("  done.")

    # ── 8. VACUUM ─────────────────────────────────────────────────────────
    print("Vacuuming …")
    dst_conn.execute("VACUUM")
    print("  done.")

    # ── 9. Title index, at the end of the file ────────────────────────────
    # Searches under 3 characters can't use the trigram index, so they match
    # titles with LIKE — a scan of every title.  Scanning this index instead of
    # the table reads about a quarter as much, and it covers every aggregate
    # (count, per day, per game) for such a search.
    #
    # Built after VACUUM so its pages are appended at the end of the file.
    # sql.js-httpvfs doubles its read-ahead on sequential reads, so a scan ends
    # with a request as large as the index; if another index followed, the
    # next read there would fetch twice that (≈4 MB).  At the end, the
    # read-ahead stops at the end of the file.
    print("Creating clips_title index …")
    dst_conn.execute("CREATE INDEX IF NOT EXISTS clips_title ON clips(title, created_at, game_id)")
    print("  done.")

    dst_conn.close()

    size_mb = os.path.getsize(dst_path) / 1_048_576
    print(f"\nOutput: {dst_path}  ({size_mb:.1f} MB)")
    print("The database is ready for deployment.")


def main() -> None:
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <source_db> <output_db>", file=sys.stderr)
        sys.exit(1)
    prepare(sys.argv[1], sys.argv[2])


if __name__ == "__main__":
    main()
