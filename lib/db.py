import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS streamers (
    id                   TEXT PRIMARY KEY,
    login                TEXT NOT NULL UNIQUE,
    display_name         TEXT NOT NULL,
    first_scraped_at     TEXT,
    last_scraped_at      TEXT,
    newest_clip_at       TEXT,
    full_history_fetched INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS games (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    box_art_url TEXT
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
CREATE INDEX IF NOT EXISTS clips_view_count          ON clips(view_count DESC);
CREATE INDEX IF NOT EXISTS clips_game                ON clips(game_id);
"""


def init_db(path: str) -> sqlite3.Connection:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA)
    return conn


def upsert_streamer(conn: sqlite3.Connection, streamer: dict) -> None:
    conn.execute(
        """
        INSERT INTO streamers (id, login, display_name)
        VALUES (:id, :login, :display_name)
        ON CONFLICT(id) DO UPDATE SET
            login        = excluded.login,
            display_name = excluded.display_name
        """,
        streamer,
    )
    conn.commit()


def upsert_games(conn: sqlite3.Connection, games: list[dict]) -> None:
    conn.executemany(
        """
        INSERT INTO games (id, name, box_art_url)
        VALUES (:id, :name, :box_art_url)
        ON CONFLICT(id) DO UPDATE SET
            name        = excluded.name,
            box_art_url = excluded.box_art_url
        """,
        games,
    )
    conn.commit()


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


def get_streamers(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute("SELECT * FROM streamers").fetchall()


def get_known_game_ids(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute("SELECT id FROM games").fetchall()
    return {row["id"] for row in rows}
