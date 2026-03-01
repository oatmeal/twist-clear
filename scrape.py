#!/usr/bin/env python3
"""Twitch clip metadata scraper.

Usage:
    python scrape.py fetch    # full historical scrape for all configured streamers
    python scrape.py update   # incremental update (new clips only)
"""

import argparse
import sys
from datetime import UTC, datetime

try:
    import tomllib
except ImportError:
    try:
        import tomli as tomllib  # type: ignore[no-redef]
    except ImportError:
        sys.exit("tomli is required for Python < 3.11: pip install tomli")

from lib.api import TwitchAPI
from lib.db import (
    get_known_game_ids,
    get_streamers,
    init_db,
    mark_full_history_fetched,
    update_watermark,
    upsert_clips,
    upsert_games,
    upsert_streamer,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def load_config(path: str) -> dict:
    with open(path, "rb") as f:
        return tomllib.load(f)


def normalize_clip(clip: dict) -> dict:
    return {
        "id": clip["id"],
        "broadcaster_id": clip["broadcaster_id"],
        "creator_id": clip.get("creator_id"),
        "creator_name": clip.get("creator_name"),
        "title": clip["title"],
        "game_id": clip.get("game_id") or None,
        "view_count": clip.get("view_count", 0),
        "created_at": clip["created_at"],
        "duration": clip.get("duration"),
        "thumbnail_url": clip.get("thumbnail_url"),
        "url": clip.get("url"),
        "language": clip.get("language"),
        "vod_offset": clip.get("vod_offset"),
    }


def resolve_new_games(api: TwitchAPI, conn, clips: list[dict]) -> None:
    """Fetch and store names for any game_ids not yet in the DB."""
    known = get_known_game_ids(conn)
    new_ids = [
        c["game_id"]
        for c in clips
        if c.get("game_id") and c["game_id"] not in known
    ]
    if not new_ids:
        return
    games = api.get_games(list(set(new_ids)))
    upsert_games(
        conn,
        [{"id": g["id"], "name": g["name"], "box_art_url": g.get("box_art_url", "")}
         for g in games],
    )


def scrape_streamer(
    api: TwitchAPI,
    conn,
    broadcaster_id: str,
    display_name: str,
    started_at: str | None = None,
) -> tuple[int, str | None]:
    """Page through all clips for a broadcaster, storing each page as we go.

    Returns (total_clips_stored, max_created_at).
    max_created_at is the most recent created_at across all fetched clips,
    suitable for use as the next watermark.
    """
    total = 0
    max_created_at: str | None = None

    for page in api.get_clips(broadcaster_id, started_at=started_at):
        clips = [normalize_clip(c) for c in page]
        resolve_new_games(api, conn, clips)
        upsert_clips(conn, clips)
        total += len(clips)

        page_max = max(c["created_at"] for c in clips)
        if max_created_at is None or page_max > max_created_at:
            max_created_at = page_max

        print(f"  {total} clips fetched...", end="\r", flush=True)

    # Clear the progress line
    print(f"  {total} clips.           ")
    return total, max_created_at


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def cmd_fetch(api: TwitchAPI, conn, config: dict) -> None:
    """Full historical scrape for all streamers listed in config."""
    logins = [s["login"] for s in config.get("streamers", [])]
    if not logins:
        sys.exit("No streamers configured. Add [[streamers]] entries to config.toml.")

    print(f"Resolving {len(logins)} streamer(s)...")
    users = api.get_users(logins)

    found_logins = {u["login"].lower() for u in users}
    for login in logins:
        if login.lower() not in found_logins:
            print(f"  Warning: streamer '{login}' not found on Twitch.", file=sys.stderr)

    for user in users:
        upsert_streamer(conn, {
            "id": user["id"],
            "login": user["login"],
            "display_name": user["display_name"],
        })
        print(f"\n{user['display_name']} ({user['login']})")
        total, max_created_at = scrape_streamer(api, conn, user["id"], user["display_name"])
        if max_created_at:
            mark_full_history_fetched(conn, user["id"], max_created_at, now_iso())
        elif total == 0:
            # No clips found; still mark as fully fetched so update works later.
            mark_full_history_fetched(conn, user["id"], "", now_iso())


def cmd_update(api: TwitchAPI, conn) -> None:
    """Incremental update: fetch only clips newer than each streamer's watermark."""
    streamers = get_streamers(conn)
    if not streamers:
        sys.exit("No streamers in database. Run 'fetch' first.")

    for streamer in streamers:
        if not streamer["full_history_fetched"]:
            print(
                f"Skipping {streamer['login']} — full history not yet fetched (run 'fetch' first).",
                file=sys.stderr,
            )
            continue

        watermark = streamer["newest_clip_at"]
        since = watermark or "beginning"
        print(f"\n{streamer['display_name']} ({streamer['login']}) — since {since}")
        total, max_created_at = scrape_streamer(
            api, conn, streamer["id"], streamer["display_name"], started_at=watermark or None
        )
        # Always advance last_scraped_at; advance watermark only if we found newer clips.
        new_watermark = (
            max_created_at if max_created_at and max_created_at > (watermark or "") else watermark
        )
        update_watermark(conn, streamer["id"], new_watermark or "", now_iso())

        if total == 0:
            print("  No new clips.")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Scrape Twitch clip metadata into a local SQLite database."
    )
    parser.add_argument("--config", default="config.toml", metavar="PATH",
                        help="Path to config file (default: config.toml)")
    parser.add_argument("--db", default=None, metavar="PATH",
                        help="Override the database path from config")

    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("fetch", help="Full historical scrape for all configured streamers")
    sub.add_parser("update", help="Incremental update — fetch only new clips")

    args = parser.parse_args()

    config = load_config(args.config)
    db_path = args.db or config.get("scraper", {}).get("db_path", "data/clips.db")

    api = TwitchAPI(
        client_id=config["twitch"]["client_id"],
        client_secret=config["twitch"]["client_secret"],
    )
    conn = init_db(db_path)

    if args.cmd == "fetch":
        cmd_fetch(api, conn, config)
    elif args.cmd == "update":
        cmd_update(api, conn)


if __name__ == "__main__":
    main()
