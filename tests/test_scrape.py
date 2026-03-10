from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock

import pytest

from scrape import _fmt_window, fetch_history, normalize_clip


def make_api_clip(
    clip_id="clip1",
    broadcaster_id="123",
    created_at="2024-01-01T12:00:00Z",
    view_count=100,
):
    return {
        "id": clip_id,
        "broadcaster_id": broadcaster_id,
        "creator_id": "creator1",
        "creator_name": "Creator1",
        "title": f"Clip {clip_id}",
        "game_id": None,
        "view_count": view_count,
        "created_at": created_at,
        "duration": 30.0,
        "thumbnail_url": "https://example.com/thumb.jpg",
        "url": f"https://clips.twitch.tv/{clip_id}",
        "language": "en",
        "vod_offset": None,
    }


@pytest.fixture
def mock_api():
    api = MagicMock()
    api.get_games.return_value = []
    return api


@pytest.fixture
def mock_igdb():
    igdb = MagicMock()
    igdb.get_ja_names.return_value = {}
    return igdb


class TestNormalizeClip:
    def test_maps_all_fields(self):
        raw = make_api_clip()
        n = normalize_clip(raw)
        assert n["id"] == "clip1"
        assert n["broadcaster_id"] == "123"
        assert n["creator_name"] == "Creator1"
        assert n["view_count"] == 100

    def test_empty_game_id_becomes_none(self):
        raw = {**make_api_clip(), "game_id": ""}
        assert normalize_clip(raw)["game_id"] is None

    def test_missing_optional_fields_become_none(self):
        raw = {"id": "c1", "broadcaster_id": "123", "title": "T",
               "created_at": "2024-01-01T00:00:00Z"}
        n = normalize_clip(raw)
        assert n["creator_id"] is None
        assert n["duration"] is None
        assert n["vod_offset"] is None


class TestFmtWindow:
    def test_days(self):
        assert _fmt_window(timedelta(days=1)) == "1d"

    def test_hours(self):
        assert _fmt_window(timedelta(hours=6)) == "6h"

    def test_minutes(self):
        assert _fmt_window(timedelta(minutes=30)) == "30m"

    def test_seconds(self):
        assert _fmt_window(timedelta(seconds=45)) == "45s"


class TestFetchHistory:
    def test_empty_date_range_makes_no_api_calls(self, conn, mock_api, mock_igdb):
        dt = datetime(2024, 1, 1, tzinfo=UTC)
        total, max_created_at = fetch_history(mock_api, mock_igdb, conn, "123", dt, dt)
        assert total == 0
        assert max_created_at is None
        mock_api.get_clips_window.assert_not_called()

    def test_single_empty_window_saves_progress(self, conn, mock_api, mock_igdb):
        mock_api.get_clips_window.return_value = ([], False)
        from_dt = datetime(2024, 1, 1, tzinfo=UTC)
        to_dt = datetime(2024, 1, 2, tzinfo=UTC)

        fetch_history(mock_api, mock_igdb, conn, "123", from_dt, to_dt)

        mock_api.get_clips_window.assert_called_once()
        row = conn.execute(
            "SELECT fetch_progress_at FROM streamers WHERE id = '123'"
        ).fetchone()
        assert row["fetch_progress_at"] is not None

    def test_clips_are_stored_in_db(self, conn, mock_api, mock_igdb):
        mock_api.get_clips_window.return_value = ([make_api_clip()], False)
        from_dt = datetime(2024, 1, 1, tzinfo=UTC)
        to_dt = datetime(2024, 1, 2, tzinfo=UTC)

        total, _ = fetch_history(mock_api, mock_igdb, conn, "123", from_dt, to_dt)

        assert total == 1
        assert conn.execute("SELECT id FROM clips WHERE id = 'clip1'").fetchone() is not None

    def test_returns_max_created_at_across_windows(self, conn, mock_api, mock_igdb):
        clips = [
            make_api_clip("c1", created_at="2024-01-01T10:00:00Z"),
            make_api_clip("c2", created_at="2024-01-01T20:00:00Z"),
        ]
        mock_api.get_clips_window.return_value = (clips, False)
        from_dt = datetime(2024, 1, 1, tzinfo=UTC)
        to_dt = datetime(2024, 1, 2, tzinfo=UTC)

        _, max_created_at = fetch_history(mock_api, mock_igdb, conn, "123", from_dt, to_dt)

        assert max_created_at == "2024-01-01T20:00:00Z"

    def test_window_narrows_when_has_more(self, conn, mock_api, mock_igdb):
        """has_more=True causes the same start to be retried with a halved window."""
        from_dt = datetime(2024, 1, 1, tzinfo=UTC)
        to_dt = datetime(2024, 1, 2, tzinfo=UTC)

        # Full-day window overflows; first half fits; second half fits.
        mock_api.get_clips_window.side_effect = [
            ([], True),   # 1-day window: too many clips
            ([], False),  # 12-hour window: fits
            ([], False),  # remaining 12 hours: fits
        ]

        fetch_history(mock_api, mock_igdb, conn, "123", from_dt, to_dt)

        calls = mock_api.get_clips_window.call_args_list
        # First retry has the same start as the original call.
        assert calls[0].kwargs["started_at"] == calls[1].kwargs["started_at"]
        # But an earlier end (narrowed window).
        assert calls[1].kwargs["ended_at"] < calls[0].kwargs["ended_at"]

    def test_progress_saved_after_every_completed_window(self, conn, mock_api, mock_igdb):
        """fetch_progress_at advances to each window_end as windows complete."""
        mock_api.get_clips_window.return_value = ([], False)
        from_dt = datetime(2024, 1, 1, tzinfo=UTC)
        to_dt = datetime(2024, 1, 3, tzinfo=UTC)  # two 1-day windows

        fetch_history(mock_api, mock_igdb, conn, "123", from_dt, to_dt)

        assert mock_api.get_clips_window.call_count == 2
        row = conn.execute(
            "SELECT fetch_progress_at FROM streamers WHERE id = '123'"
        ).fetchone()
        assert row["fetch_progress_at"] == to_dt.isoformat(timespec="seconds")

    def test_min_window_guard_does_not_loop(self, conn, mock_api, mock_igdb):
        """When the effective window is already at _MIN_WINDOW, proceed even if has_more=True."""
        # Exactly 1-second range: effective window == _MIN_WINDOW from the start.
        from_dt = datetime(2024, 1, 1, 0, 0, 0, tzinfo=UTC)
        to_dt = datetime(2024, 1, 1, 0, 0, 1, tzinfo=UTC)
        mock_api.get_clips_window.return_value = ([], True)

        fetch_history(mock_api, mock_igdb, conn, "123", from_dt, to_dt)

        # Must terminate with exactly one API call, not loop forever.
        assert mock_api.get_clips_window.call_count == 1

    def test_window_grows_after_successful_windows(self, conn, mock_api, mock_igdb):
        """After a successful window the stored window doubles (up to _MAX_WINDOW)."""
        # Two-day range: first 1-day window overflows (halve to 12h), the
        # subsequent 12h window fits, then the window grows back to 1d for
        # the next call.
        mock_api.get_clips_window.side_effect = [
            ([], True),   # [Jan 1 00:00, Jan 2 00:00]: overflow → halve to 12h
            ([], False),  # [Jan 1 00:00, Jan 1 12:00]: fits → grow to 1d
            ([], False),  # [Jan 1 12:00, Jan 2 12:00]: 1-day window, fits
            ([], False),  # [Jan 2 12:00, Jan 3 00:00]: remaining 12h, fits
        ]
        from_dt = datetime(2024, 1, 1, tzinfo=UTC)
        to_dt = datetime(2024, 1, 3, tzinfo=UTC)

        fetch_history(mock_api, mock_igdb, conn, "123", from_dt, to_dt)

        calls = mock_api.get_clips_window.call_args_list

        def span(call):
            return datetime.fromisoformat(call.kwargs["ended_at"]) - datetime.fromisoformat(
                call.kwargs["started_at"]
            )

        # Call 3 (after growth) must cover a larger span than call 2 (12h).
        assert span(calls[2]) > span(calls[1])

    def test_no_clips_returns_none_for_max_created_at(self, conn, mock_api, mock_igdb):
        mock_api.get_clips_window.return_value = ([], False)
        from_dt = datetime(2024, 1, 1, tzinfo=UTC)
        to_dt = datetime(2024, 1, 2, tzinfo=UTC)

        total, max_created_at = fetch_history(mock_api, mock_igdb, conn, "123", from_dt, to_dt)

        assert total == 0
        assert max_created_at is None
