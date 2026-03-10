import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS streamers (
    id                   TEXT PRIMARY KEY,
    login                TEXT NOT NULL UNIQUE,
    display_name         TEXT NOT NULL,
    account_created_at   TEXT,
    first_scraped_at     TEXT,
    last_scraped_at      TEXT,
    newest_clip_at       TEXT,
    fetch_progress_at    TEXT,
    full_history_fetched INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS games (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    box_art_url TEXT,
    name_ja     TEXT
);

CREATE TABLE IF NOT EXISTS clips (
    id             TEXT PRIMARY KEY,
    broadcaster_id TEXT NOT NULL REFERENCES streamers(id),
    creator_id     TEXT,
    creator_name   TEXT,
    title          TEXT NOT NULL,
    game_id        TEXT REFERENCES games(id),
    view_count     INTEGER,
    created_at     TEXT NOT NULL,
    duration       REAL,
    thumbnail_url  TEXT,
    url            TEXT,
    language       TEXT,
    vod_offset     INTEGER
);

CREATE INDEX IF NOT EXISTS clips_broadcaster_created ON clips(broadcaster_id, created_at DESC);
CREATE INDEX IF NOT EXISTS clips_view_count          ON clips(view_count DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS clips_game                ON clips(game_id);
CREATE INDEX IF NOT EXISTS clips_game_created        ON clips(game_id, created_at DESC);
"""

# Migration: columns added after the initial schema release.
# Each entry is (column_name, ALTER TABLE statement).  Executed in order;
# the OperationalError raised when a column already exists is swallowed.
_MIGRATIONS = [
    ("name_ja", "ALTER TABLE games ADD COLUMN name_ja TEXT"),
]


def init_db(path: str) -> sqlite3.Connection:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA)
    _run_migrations(conn)
    return conn


def _run_migrations(conn: sqlite3.Connection) -> None:
    """Apply any schema migrations that are not yet present."""
    for _col, stmt in _MIGRATIONS:
        try:
            conn.execute(stmt)
            conn.commit()
        except sqlite3.OperationalError:
            # Column already exists — safe to ignore.
            pass


def upsert_streamer(conn: sqlite3.Connection, streamer: dict) -> None:
    conn.execute(
        """
        INSERT INTO streamers (id, login, display_name, account_created_at)
        VALUES (:id, :login, :display_name, :account_created_at)
        ON CONFLICT(id) DO UPDATE SET
            login              = excluded.login,
            display_name       = excluded.display_name,
            account_created_at = COALESCE(streamers.account_created_at, excluded.account_created_at)
        """,
        streamer,
    )
    conn.commit()


def upsert_games(conn: sqlite3.Connection, games: list[dict]) -> None:
    """Insert or update games rows.

    Each dict must contain ``id``, ``name``, and ``box_art_url``.
    The optional ``name_ja`` key, when present, is stored; when absent or
    ``None`` the existing value in the DB is preserved via COALESCE so that a
    subsequent Twitch-only upsert never clears a previously enriched Japanese
    name.
    """
    conn.executemany(
        """
        INSERT INTO games (id, name, box_art_url, name_ja)
        VALUES (:id, :name, :box_art_url, :name_ja)
        ON CONFLICT(id) DO UPDATE SET
            name        = excluded.name,
            box_art_url = excluded.box_art_url,
            name_ja     = COALESCE(excluded.name_ja, games.name_ja)
        """,
        [
            {
                "id": g["id"],
                "name": g["name"],
                "box_art_url": g.get("box_art_url", ""),
                "name_ja": g.get("name_ja"),
            }
            for g in games
        ],
    )
    conn.commit()


def update_game_ja_names(conn: sqlite3.Connection, names: dict[str, str]) -> None:
    """Bulk-update the ``name_ja`` column for the given Twitch game IDs.

    ``names`` is a mapping of ``{twitch_game_id: japanese_name}``.
    Only existing rows are updated; unknown IDs are silently skipped.
    """
    conn.executemany(
        "UPDATE games SET name_ja = ? WHERE id = ?",
        [(ja_name, twitch_id) for twitch_id, ja_name in names.items()],
    )
    conn.commit()


def get_all_games(conn: sqlite3.Connection) -> dict[str, str]:
    """Return all games currently stored in the DB as {twitch_id: english_name}."""
    rows = conn.execute("SELECT id, name FROM games").fetchall()
    return {row["id"]: row["name"] for row in rows}


def upsert_clips(conn: sqlite3.Connection, clips: list[dict]) -> int:
    result = conn.executemany(
        """
        INSERT INTO clips (
            id, broadcaster_id, creator_id, creator_name, title,
            game_id, view_count, created_at, duration,
            thumbnail_url, url, language, vod_offset
        )
        VALUES (
            :id, :broadcaster_id, :creator_id, :creator_name, :title,
            :game_id, :view_count, :created_at, :duration,
            :thumbnail_url, :url, :language, :vod_offset
        )
        ON CONFLICT(id) DO UPDATE SET
            view_count = excluded.view_count,
            title      = excluded.title
        """,
        clips,
    )
    conn.commit()
    return result.rowcount


def save_fetch_progress(conn: sqlite3.Connection, broadcaster_id: str, progress_at: str) -> None:
    conn.execute(
        "UPDATE streamers SET fetch_progress_at = ? WHERE id = ?",
        (progress_at, broadcaster_id),
    )
    conn.commit()


def mark_full_history_fetched(
    conn: sqlite3.Connection,
    broadcaster_id: str,
    newest_clip_at: str,
    now: str,
) -> None:
    conn.execute(
        """
        UPDATE streamers SET
            full_history_fetched = 1,
            newest_clip_at       = ?,
            first_scraped_at     = COALESCE(first_scraped_at, ?),
            last_scraped_at      = ?
        WHERE id = ?
        """,
        (newest_clip_at, now, now, broadcaster_id),
    )
    conn.commit()


def update_watermark(
    conn: sqlite3.Connection,
    broadcaster_id: str,
    newest_clip_at: str,
    now: str,
) -> None:
    conn.execute(
        """
        UPDATE streamers SET
            newest_clip_at  = MAX(COALESCE(newest_clip_at, ''), ?),
            last_scraped_at = ?
        WHERE id = ?
        """,
        (newest_clip_at, now, broadcaster_id),
    )
    conn.commit()


def get_streamer(conn: sqlite3.Connection, broadcaster_id: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM streamers WHERE id = ?", (broadcaster_id,)).fetchone()


def get_streamers(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute("SELECT * FROM streamers").fetchall()


def get_known_game_ids(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute("SELECT id FROM games").fetchall()
    return {row["id"] for row in rows}


def reset_fetch_state(conn: sqlite3.Connection) -> None:
    """Reset all streamers so fetch re-scans the full history from scratch.

    Clears full_history_fetched and fetch_progress_at on every streamer row.
    Existing clip data is preserved; clips will be upserted on the next fetch
    run, updating their view counts.
    """
    conn.execute("UPDATE streamers SET full_history_fetched = 0, fetch_progress_at = NULL")
    conn.commit()
