from lib.db import (
    get_known_game_ids,
    mark_full_history_fetched,
    save_fetch_progress,
    update_watermark,
    upsert_clips,
    upsert_streamer,
)


def make_clip(clip_id="clip1", broadcaster_id="123", created_at="2024-01-01T00:00:00Z"):
    return {
        "id": clip_id,
        "broadcaster_id": broadcaster_id,
        "creator_id": "creator1",
        "creator_name": "Creator1",
        "title": "Test Clip",
        "game_id": None,
        "view_count": 100,
        "created_at": created_at,
        "duration": 30.0,
        "thumbnail_url": "https://example.com/thumb.jpg",
        "url": f"https://clips.twitch.tv/{clip_id}",
        "language": "en",
        "vod_offset": None,
    }


class TestUpsertStreamer:
    def test_inserts_new_streamer(self, conn):
        upsert_streamer(conn, {
            "id": "456",
            "login": "newstreamer",
            "display_name": "NewStreamer",
            "account_created_at": "2022-01-01T00:00:00Z",
        })
        row = conn.execute("SELECT * FROM streamers WHERE id = '456'").fetchone()
        assert row["login"] == "newstreamer"
        assert row["account_created_at"] == "2022-01-01T00:00:00Z"

    def test_updates_login_and_display_name(self, conn):
        upsert_streamer(conn, {
            "id": "123",
            "login": "renamedstreamer",
            "display_name": "RenamedStreamer",
            "account_created_at": "2020-01-01T00:00:00Z",
        })
        row = conn.execute("SELECT login, display_name FROM streamers WHERE id = '123'").fetchone()
        assert row["login"] == "renamedstreamer"
        assert row["display_name"] == "RenamedStreamer"

    def test_preserves_existing_account_created_at_on_null_update(self, conn):
        """COALESCE in the ON CONFLICT clause means a NULL update never overwrites."""
        upsert_streamer(conn, {
            "id": "123",
            "login": "teststreamer",
            "display_name": "TestStreamer",
            "account_created_at": None,
        })
        row = conn.execute(
            "SELECT account_created_at FROM streamers WHERE id = '123'"
        ).fetchone()
        assert row["account_created_at"] == "2020-01-01T00:00:00Z"


class TestUpsertClips:
    def test_inserts_clip(self, conn):
        upsert_clips(conn, [make_clip()])
        row = conn.execute("SELECT * FROM clips WHERE id = 'clip1'").fetchone()
        assert row["title"] == "Test Clip"
        assert row["view_count"] == 100

    def test_updates_view_count_and_title_on_conflict(self, conn):
        upsert_clips(conn, [make_clip()])
        upsert_clips(conn, [{**make_clip(), "view_count": 9999, "title": "Updated"}])
        row = conn.execute("SELECT view_count, title FROM clips WHERE id = 'clip1'").fetchone()
        assert row["view_count"] == 9999
        assert row["title"] == "Updated"

    def test_preserves_other_fields_on_conflict(self, conn):
        """Fields not in the ON CONFLICT SET clause should be unchanged."""
        upsert_clips(conn, [make_clip()])
        upsert_clips(conn, [{**make_clip(), "view_count": 9999}])
        row = conn.execute("SELECT creator_name, duration FROM clips WHERE id = 'clip1'").fetchone()
        assert row["creator_name"] == "Creator1"
        assert row["duration"] == 30.0

    def test_returns_row_count(self, conn):
        count = upsert_clips(conn, [make_clip("a"), make_clip("b")])
        assert count == 2


class TestFetchProgress:
    def test_save_fetch_progress(self, conn):
        save_fetch_progress(conn, "123", "2024-06-15T00:00:00+00:00")
        row = conn.execute(
            "SELECT fetch_progress_at FROM streamers WHERE id = '123'"
        ).fetchone()
        assert row["fetch_progress_at"] == "2024-06-15T00:00:00+00:00"

    def test_save_fetch_progress_overwrites(self, conn):
        save_fetch_progress(conn, "123", "2024-01-01T00:00:00+00:00")
        save_fetch_progress(conn, "123", "2024-06-01T00:00:00+00:00")
        row = conn.execute(
            "SELECT fetch_progress_at FROM streamers WHERE id = '123'"
        ).fetchone()
        assert row["fetch_progress_at"] == "2024-06-01T00:00:00+00:00"


class TestMarkFullHistoryFetched:
    def test_sets_all_fields(self, conn):
        mark_full_history_fetched(conn, "123", "2024-12-01T00:00:00Z", "2024-12-15T00:00:00Z")
        row = conn.execute("SELECT * FROM streamers WHERE id = '123'").fetchone()
        assert row["full_history_fetched"] == 1
        assert row["newest_clip_at"] == "2024-12-01T00:00:00Z"
        assert row["first_scraped_at"] == "2024-12-15T00:00:00Z"
        assert row["last_scraped_at"] == "2024-12-15T00:00:00Z"

    def test_preserves_first_scraped_at_on_second_call(self, conn):
        mark_full_history_fetched(conn, "123", "2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z")
        mark_full_history_fetched(conn, "123", "2024-12-01T00:00:00Z", "2024-12-15T00:00:00Z")
        row = conn.execute("SELECT first_scraped_at FROM streamers WHERE id = '123'").fetchone()
        assert row["first_scraped_at"] == "2024-01-01T00:00:00Z"


class TestUpdateWatermark:
    def test_advances_watermark(self, conn):
        conn.execute(
            "UPDATE streamers SET newest_clip_at = '2024-01-01T00:00:00Z' WHERE id = '123'"
        )
        conn.commit()
        update_watermark(conn, "123", "2024-06-01T00:00:00Z", "2024-12-15T00:00:00Z")
        row = conn.execute("SELECT newest_clip_at FROM streamers WHERE id = '123'").fetchone()
        assert row["newest_clip_at"] == "2024-06-01T00:00:00Z"

    def test_does_not_regress_watermark(self, conn):
        conn.execute(
            "UPDATE streamers SET newest_clip_at = '2024-06-01T00:00:00Z' WHERE id = '123'"
        )
        conn.commit()
        update_watermark(conn, "123", "2024-01-01T00:00:00Z", "2024-12-15T00:00:00Z")
        row = conn.execute("SELECT newest_clip_at FROM streamers WHERE id = '123'").fetchone()
        assert row["newest_clip_at"] == "2024-06-01T00:00:00Z"


class TestGetKnownGameIds:
    def test_returns_all_game_ids(self, conn):
        conn.executemany(
            "INSERT INTO games (id, name) VALUES (?, ?)",
            [("game1", "Game 1"), ("game2", "Game 2")],
        )
        conn.commit()
        assert get_known_game_ids(conn) == {"game1", "game2"}

    def test_returns_empty_set_when_no_games(self, conn):
        assert get_known_game_ids(conn) == set()
