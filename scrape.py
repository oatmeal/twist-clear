#!/usr/bin/env python3
"""Twitch clip metadata scraper.

Usage:
    python scrape.py fetch    # full historical scrape for all configured streamers
    python scrape.py update   # incremental update (new clips only)
"""

import argparse
import sys
from datetime import UTC, datetime, timedelta

try:
    import tomllib
except ImportError:
    try:
        import tomli as tomllib  # type: ignore[no-redef]
    except ImportError:
        sys.exit("tomli is required for Python < 3.11: pip install tomli")

from lib.api import TwitchAPI
from lib.db import (
    get_all_games,
    get_known_game_ids,
    get_streamer,
    get_streamers,
    get_unenriched_games,
    init_db,
    mark_full_history_fetched,
    reset_fetch_state,
    save_fetch_progress,
    update_game_ja_names,
    update_watermark,
    upsert_clips,
    upsert_games,
    upsert_streamer,
)
from lib.igdb import IGDBClient

# Twitch's public launch date — used as the fallback start when a streamer's
# account_created_at is unavailable.
_TWITCH_EPOCH = datetime(2011, 6, 1, tzinfo=UTC)

# Adaptive window bounds for fetch_history.
_MIN_WINDOW = timedelta(seconds=1)
_INITIAL_WINDOW = timedelta(days=1)
_MAX_WINDOW = timedelta(days=30)


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


def resolve_new_games(api: TwitchAPI, igdb: IGDBClient, conn, clips: list[dict]) -> None:
    """Fetch and store metadata for any game_ids not yet in the DB.

    Twitch provides English names; IGDB is queried for Japanese localisations.
    IGDB errors are non-fatal — the scrape continues with English names only.
    """
    known = get_known_game_ids(conn)
    new_ids = list({c["game_id"] for c in clips if c.get("game_id") and c["game_id"] not in known})
    if not new_ids:
        return
    games = api.get_games(new_ids)
    id_to_name = {g["id"]: g["name"] for g in games}

    # Enrich with Japanese names: IGDB first, Twitch web fallback for the rest.
    ja_names: dict[str, str] = {}
    try:
        ja_names = igdb.get_ja_names(id_to_name)
    except Exception as exc:
        print(f"  Warning: Japanese name lookup failed ({exc}); skipped.", flush=True)

    upsert_games(
        conn,
        [
            {
                "id": g["id"],
                "name": g["name"],
                "box_art_url": g.get("box_art_url", ""),
                "name_ja": ja_names.get(g["id"]),
            }
            for g in games
        ],
    )


def _fmt_window(window: timedelta) -> str:
    """Format a timedelta as a compact human-readable string (e.g. '1d', '6h', '30m', '45s')."""
    seconds = int(window.total_seconds())
    if seconds >= 86400:
        return f"{seconds // 86400}d"
    if seconds >= 3600:
        return f"{seconds // 3600}h"
    if seconds >= 60:
        return f"{seconds // 60}m"
    return f"{seconds}s"


# ---------------------------------------------------------------------------
# Core fetch logic
# ---------------------------------------------------------------------------


def fetch_history(
    api: TwitchAPI,
    igdb: IGDBClient,
    conn,
    broadcaster_id: str,
    from_dt: datetime,
    to_dt: datetime,
) -> tuple[int, str | None]:
    """Fetch all clips in [from_dt, to_dt] using adaptive time windows.

    Each window is a single API request (started_at + ended_at, first=100).
    If the response includes a cursor — meaning the window holds more than 100
    clips — the window is halved and the same start is retried. No cursors are
    stored; the cursor is used only as an overflow signal.

    Once a window completes successfully, fetch_progress_at is written to the
    DB so an interrupted run can resume from the right place.

    Returns (total_clips_stored, max_created_at).
    """
    if from_dt >= to_dt:
        return 0, None

    window = _INITIAL_WINDOW
    current = from_dt
    total = 0
    max_created_at: str | None = None

    while current < to_dt:
        window_end = min(current + window, to_dt)
        effective = window_end - current

        clips_raw, has_more = api.get_clips_window(
            broadcaster_id,
            started_at=current.isoformat(timespec="seconds"),
            ended_at=window_end.isoformat(timespec="seconds"),
        )

        if has_more and effective > _MIN_WINDOW:
            # Too many clips in this window — halve it based on the actual
            # (possibly clamped) effective size, not the stored window.
            window = max(effective / 2, _MIN_WINDOW)
            continue

        # Window is complete: either it fits in ≤100 clips, or we're already
        # at the minimum window size and just take what we get.
        if clips_raw:
            clips = [normalize_clip(c) for c in clips_raw]
            resolve_new_games(api, igdb, conn, clips)
            upsert_clips(conn, clips)
            total += len(clips)

            page_max = max(c["created_at"] for c in clips)
            if max_created_at is None or page_max > max_created_at:
                max_created_at = page_max

        save_fetch_progress(conn, broadcaster_id, window_end.isoformat(timespec="seconds"))
        current = window_end
        window = min(window * 2, _MAX_WINDOW)

        print(
            f"  {current.date()}  window={_fmt_window(window)}  {total} clips",
            end="\r",
            flush=True,
        )

    print(f"  {total} clips total.                    ")
    return total, max_created_at


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def cmd_fetch(api: TwitchAPI, igdb: IGDBClient, conn, config: dict, force: bool = False) -> None:
    """Full historical scrape for all streamers listed in config."""
    if force:
        print("--force: resetting fetch state for all streamers (view counts will refresh)...")
        reset_fetch_state(conn)
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
        upsert_streamer(
            conn,
            {
                "id": user["id"],
                "login": user["login"],
                "display_name": user["display_name"],
                "account_created_at": user.get("created_at"),
            },
        )

        row = get_streamer(conn, user["id"])

        if row["full_history_fetched"]:
            print(f"\n{user['display_name']} — already complete, skipping.")
            continue

        if row["fetch_progress_at"]:
            from_dt = datetime.fromisoformat(row["fetch_progress_at"])
            print(f"\n{user['display_name']} — resuming from {row['fetch_progress_at'][:10]}")
        elif row["account_created_at"]:
            from_dt = datetime.fromisoformat(row["account_created_at"])
            print(
                f"\n{user['display_name']} — starting from account creation "
                f"({row['account_created_at'][:10]})"
            )
        else:
            from_dt = _TWITCH_EPOCH
            print(
                f"\n{user['display_name']} — no account date found, starting from "
                f"{_TWITCH_EPOCH.date()}"
            )

        to_dt = datetime.now(UTC)
        total, max_created_at = fetch_history(api, igdb, conn, user["id"], from_dt, to_dt)

        if max_created_at:
            mark_full_history_fetched(conn, user["id"], max_created_at, now_iso())
        elif total == 0:
            mark_full_history_fetched(conn, user["id"], "", now_iso())


def cmd_update(api: TwitchAPI, igdb: IGDBClient, conn) -> None:
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

        watermark = streamer["newest_clip_at"] or None
        since = watermark or "beginning"
        print(f"\n{streamer['display_name']} ({streamer['login']}) — since {since}")

        total = 0
        max_created_at: str | None = None

        for page in api.get_clips(streamer["id"], started_at=watermark):
            clips = [normalize_clip(c) for c in page]
            resolve_new_games(api, igdb, conn, clips)
            upsert_clips(conn, clips)
            total += len(clips)

            page_max = max(c["created_at"] for c in clips)
            if max_created_at is None or page_max > max_created_at:
                max_created_at = page_max

            print(f"  {total} clips fetched...", end="\r", flush=True)

        print(f"  {total} clips.           ")

        new_watermark = (
            max_created_at if max_created_at and max_created_at > (watermark or "") else watermark
        )
        update_watermark(conn, streamer["id"], new_watermark or "", now_iso())

        if total == 0:
            print("  No new clips.")


def cmd_enrich_names(igdb: IGDBClient, conn, *, force: bool = False) -> None:
    """Backfill Japanese names for games currently in the database.

    By default only games with no Japanese name yet are processed, so
    subsequent runs (e.g. in ``update`` mode) are fast — only newly-added
    games need enriching.  Pass ``--force`` to re-fetch names for every game,
    which is useful when IGDB or Twitch localisations have been updated.
    """
    id_to_name = get_all_games(conn) if force else get_unenriched_games(conn)
    if not id_to_name:
        print("No games in database.")
        return

    print(f"Looking up Japanese names for {len(id_to_name)} game(s) via IGDB + Twitch web…")
    try:
        ja_names = igdb.get_ja_names(id_to_name)
    except Exception as exc:
        sys.exit(f"Japanese name lookup failed: {exc}")

    if not ja_names:
        print("  No Japanese localisations found.")
        return

    update_game_ja_names(conn, ja_names)
    print(f"  Updated {len(ja_names)} game(s) with Japanese names.")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Scrape Twitch clip metadata into a local SQLite database."
    )
    parser.add_argument(
        "--config",
        default="config.toml",
        metavar="PATH",
        help="Path to config file (default: config.toml)",
    )
    parser.add_argument(
        "--db", default=None, metavar="PATH", help="Override the database path from config"
    )

    sub = parser.add_subparsers(dest="cmd", required=True)
    fetch_sub = sub.add_parser("fetch", help="Full historical scrape for all configured streamers")
    fetch_sub.add_argument(
        "--force",
        action="store_true",
        help="Reset all fetch state first, re-scanning full history and refreshing view counts",
    )
    sub.add_parser("update", help="Incremental update — fetch only new clips")
    enrich_sub = sub.add_parser(
        "enrich-names",
        help="Backfill Japanese game names for games in the database",
    )
    enrich_sub.add_argument(
        "--force",
        action="store_true",
        help="Re-fetch Japanese names for all games, not just unenriched ones",
    )

    args = parser.parse_args()

    config = load_config(args.config)
    db_path = args.db or config.get("scraper", {}).get("db_path", "data/clips.db")

    api = TwitchAPI(
        client_id=config["twitch"]["client_id"],
        client_secret=config["twitch"]["client_secret"],
    )
    igdb = IGDBClient(
        client_id=config["twitch"]["client_id"],
        client_secret=config["twitch"]["client_secret"],
    )
    conn = init_db(db_path)

    if args.cmd == "fetch":
        cmd_fetch(api, igdb, conn, config, force=getattr(args, "force", False))
    elif args.cmd == "update":
        cmd_update(api, igdb, conn)
    elif args.cmd == "enrich-names":
        cmd_enrich_names(igdb, conn, force=getattr(args, "force", False))


if __name__ == "__main__":
    main()
