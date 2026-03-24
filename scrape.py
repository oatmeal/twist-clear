#!/usr/bin/env python3
"""Twitch clip metadata scraper.

Usage:
    python scrape.py fetch      # full historical scrape for all configured streamers
    python scrape.py update     # incremental update (new clips only)
    python scrape.py backfill   # 0-clip coverage via bisection (finds suppressed clips)
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
    get_clip_ids_for_refresh,
    get_known_game_ids,
    get_streamer,
    get_streamers,
    get_unenriched_games,
    init_db,
    mark_backfill_complete,
    mark_full_history_fetched,
    reset_backfill_state,
    reset_fetch_state,
    save_backfill_progress,
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

# Backfill defaults.
_BACKFILL_INITIAL_WINDOW = timedelta(days=30)
_BACKFILL_DEFAULT_MIN_WINDOW = timedelta(minutes=10)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def load_config(path: str) -> dict:
    with open(path, "rb") as f:
        return tomllib.load(f)


def normalize_clip(clip: dict) -> dict:
    is_featured = clip.get("is_featured")
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
        "video_id": clip.get("video_id") or None,
        "is_featured": int(is_featured) if is_featured is not None else None,
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
# Backfill — 0-clip coverage via bisection
# ---------------------------------------------------------------------------


def _align_10min(dt: datetime) -> datetime:
    """Round down to the nearest 10-minute boundary."""
    return dt.replace(minute=dt.minute // 10 * 10, second=0, microsecond=0)


class _BackfillStats:
    """Mutable counters shared across the recursive bisection tree."""

    def __init__(self, max_calls: int | None = None) -> None:
        self.clips_found = 0
        self.api_calls = 0
        self.zero_windows = 0
        self.max_calls = max_calls

    @property
    def budget_exhausted(self) -> bool:
        return self.max_calls is not None and self.api_calls >= self.max_calls


def _bisect_coverage(
    api: TwitchAPI,
    igdb: IGDBClient,
    conn,
    broadcaster_id: str,
    from_dt: datetime,
    to_dt: datetime,
    min_window: timedelta,
    stats: _BackfillStats,
) -> None:
    """Recursively bisect [from_dt, to_dt) to achieve 0-clip coverage.

    At each level we query the API.  If the response is empty (0 clips),
    the range is proven clear and we stop.  Otherwise we store any clips
    found and — if the window is wider than *min_window* — bisect into two
    halves and recurse.

    Note: even when the API returns fewer than 100 clips with no pagination
    cursor, some clips may be "suppressed" (hidden by others with the same
    view count).  The only reliable proof that a range is fully covered is
    querying a small-enough window and getting 0 results back.
    """
    if from_dt >= to_dt:
        return

    if stats.budget_exhausted:
        return

    clips_raw, has_more = api.get_clips_window(
        broadcaster_id,
        started_at=from_dt.isoformat(timespec="seconds"),
        ended_at=to_dt.isoformat(timespec="seconds"),
    )
    stats.api_calls += 1

    if not clips_raw and not has_more:
        stats.zero_windows += 1
        return

    # Store clips from this query (upsert handles dedup).
    if clips_raw:
        clips = [normalize_clip(c) for c in clips_raw]
        resolve_new_games(api, igdb, conn, clips)
        upsert_clips(conn, clips)
        stats.clips_found += len(clips)

    # At minimum window — can't bisect further.
    window = to_dt - from_dt
    if window <= min_window:
        return

    # Bisect — split at an aligned 10-minute boundary.
    mid = _align_10min(from_dt + window / 2)
    # Guard against degenerate splits.
    if mid <= from_dt:
        mid = from_dt + min_window
    if mid >= to_dt:
        return

    _bisect_coverage(api, igdb, conn, broadcaster_id, from_dt, mid, min_window, stats)
    _bisect_coverage(api, igdb, conn, broadcaster_id, mid, to_dt, min_window, stats)


def backfill_range(
    api: TwitchAPI,
    igdb: IGDBClient,
    conn,
    broadcaster_id: str,
    from_dt: datetime,
    to_dt: datetime,
    min_window: timedelta,
    max_calls: int | None = None,
) -> _BackfillStats:
    """Sweep [from_dt, to_dt) in large windows, bisecting each as needed.

    Progress is saved after each top-level window completes so the job can
    be resumed if interrupted.  If *max_calls* is set, the sweep stops early
    once the budget is exhausted (progress is still saved, so the next run
    resumes from where this one left off).
    """
    stats = _BackfillStats(max_calls=max_calls)
    current = from_dt
    step = _BACKFILL_INITIAL_WINDOW

    while current < to_dt:
        window_end = min(current + step, to_dt)

        _bisect_coverage(api, igdb, conn, broadcaster_id, current, window_end, min_window, stats)

        # Only save progress for fully completed windows — if the budget ran
        # out mid-bisection, this window will be re-done from scratch next run.
        if stats.budget_exhausted:
            break

        save_backfill_progress(conn, broadcaster_id, window_end.isoformat(timespec="seconds"))
        current = window_end

        print(
            f"  {current.date()}  calls={stats.api_calls}  clips={stats.clips_found}"
            f"  zero={stats.zero_windows}",
            end="\r",
            flush=True,
        )

    if stats.budget_exhausted:
        print(
            f"\n  Stopped — API call budget ({max_calls}) reached after"
            f" {stats.clips_found} clips, {stats.zero_windows} zero-windows."
            f"  Resume with another run.          "
        )
    else:
        print(
            f"  Done — {stats.api_calls} API calls, {stats.clips_found} clips,"
            f" {stats.zero_windows} zero-windows.          "
        )
    return stats


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

        if row["full_history_fetched_at"]:
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


def cmd_backfill(
    api: TwitchAPI,
    igdb: IGDBClient,
    conn,
    config: dict,
    *,
    force: bool = False,
    min_window_minutes: int = 10,
    max_calls: int | None = None,
) -> None:
    """0-clip coverage backfill for all configured streamers.

    Bisects the full timeline to ensure every time range is covered by at
    least one API query that returned 0 clips (proving no suppressed clips
    are hiding there).  Any clips found along the way are upserted.

    Works both on a fresh database (as a thorough alternative to ``fetch``)
    and on an existing one (to find suppressed clips missed by wide-window
    fetching).
    """
    if force:
        print("--force: resetting backfill state for all streamers...")
        reset_backfill_state(conn)

    min_window = timedelta(minutes=min_window_minutes)
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

        # Determine start point.
        if row["backfill_complete_at"]:
            if (
                row["backfill_progress_at"]
                and row["backfill_progress_at"] > row["backfill_complete_at"]
            ):
                # An incremental run was interrupted mid-way — resume it.
                from_dt = datetime.fromisoformat(row["backfill_progress_at"])
                print(
                    f"\n{user['display_name']} — resuming incremental backfill"
                    f" from {from_dt.date()}"
                )
            else:
                # Previous run completed; sweep only the new time range.
                from_dt = datetime.fromisoformat(row["backfill_complete_at"])
                print(
                    f"\n{user['display_name']} — incremental backfill from {from_dt.date()}"
                )
        elif row["backfill_progress_at"]:
            from_dt = datetime.fromisoformat(row["backfill_progress_at"])
            print(f"\n{user['display_name']} — resuming backfill from {from_dt.date()}")
        elif row["account_created_at"]:
            from_dt = datetime.fromisoformat(row["account_created_at"])
            print(
                f"\n{user['display_name']} — starting backfill from account creation "
                f"({from_dt.date()})"
            )
        else:
            from_dt = _TWITCH_EPOCH
            print(
                f"\n{user['display_name']} — no account date, starting backfill from "
                f"{_TWITCH_EPOCH.date()}"
            )

        to_dt = datetime.now(UTC)
        print(f"  min window: {_fmt_window(min_window)}")

        result = backfill_range(api, igdb, conn, user["id"], from_dt, to_dt, min_window, max_calls)
        if not result.budget_exhausted:
            mark_backfill_complete(conn, user["id"], to_dt.isoformat(timespec="seconds"))


def cmd_refresh_views(api: TwitchAPI, conn, *, days: int = 0) -> None:
    """Refresh view counts for clips already in the database.

    Fetches clips by ID in batches of 100 using the Helix clips endpoint, which
    updates view_count (and title) for every matched clip via upsert.

    Pass ``--days N`` to limit the refresh to clips created within the last N
    days — useful for keeping counts current without re-fetching the entire
    archive on every run.  The default (0) refreshes all clips.
    """
    streamers = get_streamers(conn)
    if not streamers:
        sys.exit("No streamers in database. Run 'fetch' first.")

    cutoff: str | None = None
    if days > 0:
        cutoff = (datetime.now(UTC) - timedelta(days=days)).isoformat(timespec="seconds")

    for streamer in streamers:
        clip_ids = get_clip_ids_for_refresh(conn, streamer["id"], since=cutoff)
        if not clip_ids:
            label = f"last {days} days" if days > 0 else "all time"
            print(f"\n{streamer['display_name']} — no clips ({label}).")
            continue

        label = f"last {days} days" if days > 0 else "all time"
        print(f"\n{streamer['display_name']} — {len(clip_ids)} clip(s) ({label})")

        total = 0
        for i in range(0, len(clip_ids), 100):
            batch = clip_ids[i : i + 100]
            clips_raw = api.get_clips_by_ids(batch)
            if clips_raw:
                clips = [normalize_clip(c) for c in clips_raw]
                upsert_clips(conn, clips)
                total += len(clips)
            print(f"  {total}/{len(clip_ids)} refreshed...", end="\r", flush=True)

        print(f"  {total} clip(s) refreshed.           ")


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
    backfill_sub = sub.add_parser(
        "backfill",
        help="0-clip coverage backfill — bisect timeline to find suppressed clips",
    )
    backfill_sub.add_argument(
        "--force",
        action="store_true",
        help="Reset backfill state first, restarting from the beginning",
    )
    backfill_sub.add_argument(
        "--min-window",
        type=int,
        default=10,
        metavar="MINUTES",
        help="Minimum bisection window in minutes (default: 10)",
    )
    backfill_sub.add_argument(
        "--max-calls",
        type=int,
        default=None,
        metavar="N",
        help="Stop after N API calls (progress is saved; resume with another run)",
    )
    refresh_sub = sub.add_parser(
        "refresh-views",
        help="Refresh view counts for clips already in the database",
    )
    refresh_sub.add_argument(
        "--days",
        type=int,
        default=0,
        metavar="N",
        help="Only refresh clips created in the last N days (default: 0 = all clips)",
    )
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
    elif args.cmd == "backfill":
        cmd_backfill(
            api,
            igdb,
            conn,
            config,
            force=getattr(args, "force", False),
            min_window_minutes=getattr(args, "min_window", 10),
            max_calls=getattr(args, "max_calls", None),
        )
    elif args.cmd == "refresh-views":
        cmd_refresh_views(api, conn, days=getattr(args, "days", 0))
    elif args.cmd == "enrich-names":
        cmd_enrich_names(igdb, conn, force=getattr(args, "force", False))


if __name__ == "__main__":
    main()
