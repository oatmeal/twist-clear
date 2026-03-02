import pytest

from lib.db import init_db


@pytest.fixture
def conn():
    """In-memory SQLite DB with schema applied and a test streamer inserted."""
    c = init_db(":memory:")
    c.execute(
        """
        INSERT INTO streamers (id, login, display_name, account_created_at)
        VALUES ('123', 'teststreamer', 'TestStreamer', '2020-01-01T00:00:00Z')
        """
    )
    c.commit()
    return c
