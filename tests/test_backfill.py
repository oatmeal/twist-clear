from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock

import pytest

from scrape import _align_10min, _BackfillStats, _bisect_coverage, backfill_range


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


# ---------------------------------------------------------------------------
# _align_10min
# ---------------------------------------------------------------------------


class TestAlign10Min:
    def test_already_aligned(self):
        dt = datetime(2024, 1, 1, 10, 0, 0, tzinfo=UTC)
        assert _align_10min(dt) == dt

    def test_rounds_down(self):
        dt = datetime(2024, 1, 1, 10, 17, 43, tzinfo=UTC)
        assert _align_10min(dt) == datetime(2024, 1, 1, 10, 10, 0, tzinfo=UTC)

    def test_boundary_values(self):
        for minute, expected in [(9, 0), (10, 10), (19, 10), (29, 20), (59, 50)]:
            dt = datetime(2024, 1, 1, 12, minute, 30, tzinfo=UTC)
            assert _align_10min(dt).minute == expected


# ---------------------------------------------------------------------------
# _bisect_coverage
# ---------------------------------------------------------------------------


class TestBisectCoverage:
    def test_empty_range_no_api_call(self, conn, mock_api, mock_igdb):
        stats = _BackfillStats()
        dt = datetime(2024, 1, 1, tzinfo=UTC)
        _bisect_coverage(
            mock_api,
            mock_igdb,
            conn,
            "123",
            dt,
            dt,
            timedelta(minutes=10),
            stats,
        )
        assert stats.api_calls == 0
        mock_api.get_clips_window.assert_not_called()

    def test_zero_clips_stops_immediately(self, conn, mock_api, mock_igdb):
        """A 0-clip response proves the range is empty — no bisection."""
        mock_api.get_clips_window.return_value = ([], False)
        stats = _BackfillStats()
        _bisect_coverage(
            mock_api,
            mock_igdb,
            conn,
            "123",
            datetime(2024, 1, 1, tzinfo=UTC),
            datetime(2024, 2, 1, tzinfo=UTC),
            timedelta(minutes=10),
            stats,
        )
        assert stats.api_calls == 1
        assert stats.zero_windows == 1

    def test_clips_at_min_window_stored_without_bisect(self, conn, mock_api, mock_igdb):
        """At minimum window, clips are stored but no further bisection."""
        clip = make_api_clip("c1", created_at="2024-01-01T10:05:00Z")
        mock_api.get_clips_window.return_value = ([clip], False)
        stats = _BackfillStats()

        _bisect_coverage(
            mock_api,
            mock_igdb,
            conn,
            "123",
            datetime(2024, 1, 1, 10, 0, tzinfo=UTC),
            datetime(2024, 1, 1, 10, 10, tzinfo=UTC),
            timedelta(minutes=10),
            stats,
        )

        assert stats.api_calls == 1
        assert stats.clips_found == 1
        row = conn.execute("SELECT id FROM clips WHERE id = 'c1'").fetchone()
        assert row is not None

    def test_bisects_when_clips_found_in_wide_window(self, conn, mock_api, mock_igdb):
        """A wide window with clips triggers bisection into sub-windows."""
        clip = make_api_clip("c1", created_at="2024-01-01T10:05:00Z")

        def fake_window(broadcaster_id, started_at, ended_at):
            start = datetime.fromisoformat(started_at)
            end = datetime.fromisoformat(ended_at)
            clip_time = datetime(2024, 1, 1, 10, 5, tzinfo=UTC)
            if start <= clip_time < end:
                return [clip], False
            return [], False

        mock_api.get_clips_window.side_effect = fake_window
        stats = _BackfillStats()

        _bisect_coverage(
            mock_api,
            mock_igdb,
            conn,
            "123",
            datetime(2024, 1, 1, 10, 0, tzinfo=UTC),
            datetime(2024, 1, 1, 11, 0, tzinfo=UTC),
            timedelta(minutes=10),
            stats,
        )

        # Must have made more than 1 call (the parent + children).
        assert stats.api_calls > 1
        # Empty sub-windows should be counted.
        assert stats.zero_windows > 0

    def test_suppressed_clip_discovered_via_bisection(self, conn, mock_api, mock_igdb):
        """The core scenario: a clip suppressed in wide queries appears in
        narrow queries when its suppressor is no longer in the same window.

        Clip A: 10:05  (always visible)
        Clip B: 10:25  (suppressed when A is in the same query)

        In any window containing both, only A is returned.  Bisection
        eventually creates a [10:20, 10:30] window where B appears alone.
        """
        clip_a = make_api_clip(
            "clipA",
            created_at="2024-01-01T10:05:00Z",
            view_count=3,
        )
        clip_b = make_api_clip(
            "clipB",
            created_at="2024-01-01T10:25:00Z",
            view_count=3,
        )

        def fake_window_with_suppression(broadcaster_id, started_at, ended_at):
            start = datetime.fromisoformat(started_at)
            end = datetime.fromisoformat(ended_at)
            a_time = datetime(2024, 1, 1, 10, 5, tzinfo=UTC)
            b_time = datetime(2024, 1, 1, 10, 25, tzinfo=UTC)
            a_in = start <= a_time < end
            b_in = start <= b_time < end

            if a_in and b_in:
                # Suppression: only A returned.
                return [clip_a], False
            results = []
            if a_in:
                results.append(clip_a)
            if b_in:
                results.append(clip_b)
            return results, False

        mock_api.get_clips_window.side_effect = fake_window_with_suppression
        stats = _BackfillStats()

        _bisect_coverage(
            mock_api,
            mock_igdb,
            conn,
            "123",
            datetime(2024, 1, 1, 10, 0, tzinfo=UTC),
            datetime(2024, 1, 1, 10, 30, tzinfo=UTC),
            timedelta(minutes=10),
            stats,
        )

        # Both clips must be in the DB.
        ids = {row["id"] for row in conn.execute("SELECT id FROM clips").fetchall()}
        assert "clipA" in ids
        assert "clipB" in ids

    def test_overflow_triggers_bisection(self, conn, mock_api, mock_igdb):
        """has_more=True (>100 clips) also triggers bisection."""

        def fake_overflow(broadcaster_id, started_at, ended_at):
            start = datetime.fromisoformat(started_at)
            end = datetime.fromisoformat(ended_at)
            # Overflow only in the top-level 1-hour window.
            if (end - start) > timedelta(minutes=10):
                return [], True
            return [], False

        mock_api.get_clips_window.side_effect = fake_overflow
        stats = _BackfillStats()

        _bisect_coverage(
            mock_api,
            mock_igdb,
            conn,
            "123",
            datetime(2024, 1, 1, 10, 0, tzinfo=UTC),
            datetime(2024, 1, 1, 11, 0, tzinfo=UTC),
            timedelta(minutes=10),
            stats,
        )

        # The 1-hour window should be bisected into sub-windows.
        assert stats.api_calls > 1


# ---------------------------------------------------------------------------
# backfill_range
# ---------------------------------------------------------------------------


class TestBackfillRange:
    def test_progress_saved_after_each_top_level_window(self, conn, mock_api, mock_igdb):
        mock_api.get_clips_window.return_value = ([], False)

        backfill_range(
            mock_api,
            mock_igdb,
            conn,
            "123",
            datetime(2024, 1, 1, tzinfo=UTC),
            datetime(2024, 2, 1, tzinfo=UTC),
            timedelta(minutes=10),
        )

        row = conn.execute("SELECT backfill_progress_at FROM streamers WHERE id = '123'").fetchone()
        assert row["backfill_progress_at"] == "2024-02-01T00:00:00+00:00"

    def test_empty_range_no_api_calls(self, conn, mock_api, mock_igdb):
        stats = backfill_range(
            mock_api,
            mock_igdb,
            conn,
            "123",
            datetime(2024, 1, 1, tzinfo=UTC),
            datetime(2024, 1, 1, tzinfo=UTC),
            timedelta(minutes=10),
        )
        assert stats.api_calls == 0
        mock_api.get_clips_window.assert_not_called()

    def test_multiple_top_level_windows(self, conn, mock_api, mock_igdb):
        """A 60-day range should produce 2 top-level 30-day windows."""
        mock_api.get_clips_window.return_value = ([], False)

        stats = backfill_range(
            mock_api,
            mock_igdb,
            conn,
            "123",
            datetime(2024, 1, 1, tzinfo=UTC),
            datetime(2024, 3, 1, tzinfo=UTC),
            timedelta(minutes=10),
        )

        # Each top-level 30-day window is a single API call (all empty).
        assert stats.api_calls == 2

    def test_suppressed_clip_found_across_full_range(self, conn, mock_api, mock_igdb):
        """End-to-end: suppressed clip B is discovered when backfilling a
        multi-day range that contains both clips.
        """
        clip_a = make_api_clip(
            "clipA",
            created_at="2024-01-15T10:05:00Z",
            view_count=3,
        )
        clip_b = make_api_clip(
            "clipB",
            created_at="2024-01-15T10:25:00Z",
            view_count=3,
        )

        def fake_window(broadcaster_id, started_at, ended_at):
            start = datetime.fromisoformat(started_at)
            end = datetime.fromisoformat(ended_at)
            a_time = datetime(2024, 1, 15, 10, 5, tzinfo=UTC)
            b_time = datetime(2024, 1, 15, 10, 25, tzinfo=UTC)
            a_in = start <= a_time < end
            b_in = start <= b_time < end

            if a_in and b_in:
                return [clip_a], False
            results = []
            if a_in:
                results.append(clip_a)
            if b_in:
                results.append(clip_b)
            return results, False

        mock_api.get_clips_window.side_effect = fake_window

        stats = backfill_range(
            mock_api,
            mock_igdb,
            conn,
            "123",
            datetime(2024, 1, 1, tzinfo=UTC),
            datetime(2024, 2, 1, tzinfo=UTC),
            timedelta(minutes=10),
        )

        ids = {row["id"] for row in conn.execute("SELECT id FROM clips").fetchall()}
        assert "clipA" in ids
        assert "clipB" in ids
        assert stats.clips_found > 0

    def test_custom_min_window(self, conn, mock_api, mock_igdb):
        """A 1-minute min-window should bisect more deeply than 10-minute."""
        clip = make_api_clip("c1", created_at="2024-01-01T10:05:00Z")

        def fake_window(broadcaster_id, started_at, ended_at):
            start = datetime.fromisoformat(started_at)
            end = datetime.fromisoformat(ended_at)
            clip_time = datetime(2024, 1, 1, 10, 5, tzinfo=UTC)
            if start <= clip_time < end:
                return [clip], False
            return [], False

        mock_api.get_clips_window.side_effect = fake_window

        stats_10m = backfill_range(
            mock_api,
            mock_igdb,
            conn,
            "123",
            datetime(2024, 1, 1, 10, 0, tzinfo=UTC),
            datetime(2024, 1, 1, 11, 0, tzinfo=UTC),
            timedelta(minutes=10),
        )

        mock_api.get_clips_window.side_effect = fake_window
        stats_1m = backfill_range(
            mock_api,
            mock_igdb,
            conn,
            "123",
            datetime(2024, 1, 1, 10, 0, tzinfo=UTC),
            datetime(2024, 1, 1, 11, 0, tzinfo=UTC),
            timedelta(minutes=1),
        )

        # 1-minute windows should require more API calls.
        assert stats_1m.api_calls > stats_10m.api_calls
