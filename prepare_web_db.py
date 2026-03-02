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
3. Creates and populates a FTS5 trigram virtual table (`clips_fts`) for fast
   substring title search in the browser.  The trigram tokenizer requires
   SQLite >= 3.38 and enables substring matching without a leading wildcard.
4. Optimises the FTS index (merges all segments into one) so fewer HTTP Range
   requests are needed when searching.
5. VACUUMs the output file to remove any slack space and produce a compact,
   contiguous layout that is friendlier to range-request caching.

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

    # ── 3. Create FTS5 trigram table ──────────────────────────────────────
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

    # ── 4. Populate and optimise the FTS index ────────────────────────────
    print("Rebuilding FTS index (this may take a moment) …")
    dst_conn.execute("INSERT INTO clips_fts(clips_fts) VALUES('rebuild')")
    print("  done.")

    print("Optimising FTS index (merging segments) …")
    dst_conn.execute("INSERT INTO clips_fts(clips_fts) VALUES('optimize')")
    print("  done.")

    # ── 5. VACUUM ─────────────────────────────────────────────────────────
    print("Vacuuming …")
    dst_conn.execute("VACUUM")
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
