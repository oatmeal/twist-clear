from unittest.mock import MagicMock, patch

import pytest

from lib.api import TwitchAPI


@pytest.fixture
def api():
    """TwitchAPI with a pre-loaded token so token fetching is bypassed."""
    a = TwitchAPI("test_client_id", "test_client_secret")
    a._token = "test_token"
    a._token_expiry = float("inf")
    return a


def make_response(data=None, cursor=None, status_code=200, remaining=500):
    resp = MagicMock()
    resp.status_code = status_code
    body = {"data": data if data is not None else []}
    if cursor:
        body["pagination"] = {"cursor": cursor}
    resp.json.return_value = body
    resp.raise_for_status = MagicMock()
    resp.headers = {"Ratelimit-Remaining": str(remaining), "Ratelimit-Reset": "9999999999"}
    return resp


class TestTokenManagement:
    @patch("lib.api.requests.post")
    def test_fetches_new_token(self, mock_post):
        mock_post.return_value.json.return_value = {
            "access_token": "newtoken",
            "expires_in": 3600,
        }
        mock_post.return_value.raise_for_status = MagicMock()

        a = TwitchAPI("client_id", "secret")
        token = a._get_token()

        assert token == "newtoken"
        mock_post.assert_called_once()

    @patch("lib.api.requests.post")
    def test_uses_cached_token(self, mock_post):
        a = TwitchAPI("client_id", "secret")
        a._token = "cached"
        a._token_expiry = float("inf")

        assert a._get_token() == "cached"
        mock_post.assert_not_called()


class TestRateLimiting:
    @patch("lib.api.time.sleep")
    @patch("lib.api.time.time", return_value=1000.0)
    @patch("lib.api.requests.get")
    def test_retries_on_429(self, mock_get, _mock_time, mock_sleep, api):
        rate_limited = MagicMock()
        rate_limited.status_code = 429
        rate_limited.headers = {"Ratelimit-Reset": "1002", "Ratelimit-Remaining": "0"}

        mock_get.side_effect = [rate_limited, make_response()]

        api.get_users(["streamer"])

        assert mock_get.call_count == 2
        mock_sleep.assert_called_once()
        wait = mock_sleep.call_args[0][0]
        assert wait > 0

    @patch("lib.api.time.sleep")
    @patch("lib.api.time.time", return_value=1000.0)
    @patch("lib.api.requests.get")
    def test_proactive_pause_when_remaining_low(self, mock_get, _mock_time, mock_sleep, api):
        mock_get.return_value = make_response(remaining=5)  # below _RATE_LIMIT_BUFFER

        api.get_users(["streamer"])

        mock_sleep.assert_called_once()


class TestGetClipsWindow:
    @patch("lib.api.requests.get")
    def test_returns_clips_and_false_when_no_cursor(self, mock_get, api):
        clips = [{"id": "clip1", "title": "Test"}]
        mock_get.return_value = make_response(data=clips)

        result_clips, has_more = api.get_clips_window(
            "123", "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z"
        )

        assert result_clips == clips
        assert has_more is False

    @patch("lib.api.requests.get")
    def test_returns_true_when_cursor_present(self, mock_get, api):
        clips = [{"id": f"clip{i}"} for i in range(100)]
        mock_get.return_value = make_response(data=clips, cursor="abc123")

        _, has_more = api.get_clips_window(
            "123", "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z"
        )

        assert has_more is True

    @patch("lib.api.requests.get")
    def test_passes_correct_params(self, mock_get, api):
        mock_get.return_value = make_response()

        api.get_clips_window("broadcaster99", "2024-03-01T00:00:00Z", "2024-03-02T00:00:00Z")

        _, kwargs = mock_get.call_args
        params = kwargs["params"]
        assert params["broadcaster_id"] == "broadcaster99"
        assert params["started_at"] == "2024-03-01T00:00:00Z"
        assert params["ended_at"] == "2024-03-02T00:00:00Z"
        assert params["first"] == 100


class TestGetClips:
    @patch("lib.api.requests.get")
    def test_paginates_until_no_cursor(self, mock_get, api):
        mock_get.side_effect = [
            make_response(data=[{"id": "c1"}], cursor="cur1"),
            make_response(data=[{"id": "c2"}], cursor="cur2"),
            make_response(data=[{"id": "c3"}]),  # no cursor → last page
        ]

        pages = list(api.get_clips("123"))

        assert len(pages) == 3
        assert mock_get.call_count == 3

    @patch("lib.api.requests.get")
    def test_stops_on_empty_response(self, mock_get, api):
        mock_get.return_value = make_response(data=[])

        pages = list(api.get_clips("123"))

        assert pages == []

    @patch("lib.api.requests.get")
    def test_passes_started_at(self, mock_get, api):
        mock_get.return_value = make_response()

        list(api.get_clips("123", started_at="2024-06-01T00:00:00Z"))

        _, kwargs = mock_get.call_args
        assert kwargs["params"]["started_at"] == "2024-06-01T00:00:00Z"
