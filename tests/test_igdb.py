from unittest.mock import MagicMock, patch

import requests

from lib.igdb import _fetch_twitch_ja_name, _name_to_slug


class TestNameToSlug:
    def test_simple_spaces_become_hyphens(self):
        assert _name_to_slug("Just Chatting") == "just-chatting"

    def test_all_caps_lowercased(self):
        assert _name_to_slug("ELDEN RING") == "elden-ring"

    def test_unicode_normalized_to_ascii(self):
        # NFD decomposition turns é into e + combining accent; ASCII encode drops the accent.
        assert _name_to_slug("Pokémon UNITE") == "pokemon-unite"

    def test_colon_stripped(self):
        assert _name_to_slug("Animal Crossing: New Horizons") == "animal-crossing-new-horizons"

    def test_plus_stripped(self):
        assert _name_to_slug("Games + Demos") == "games-demos"

    def test_existing_hyphens_preserved(self):
        # Hyphens already in the name are kept (not stripped, not doubled).
        assert _name_to_slug("VA-11 HALL-A") == "va-11-hall-a"

    def test_ampersand_stripped(self):
        assert _name_to_slug("Sports & Fitness") == "sports-fitness"

    def test_empty_string(self):
        assert _name_to_slug("") == ""


class TestFetchTwitchJaName:
    """Tests for HTML parsing in _fetch_twitch_ja_name.

    The function takes a ``requests.Session`` as its first argument, so tests
    can pass a MagicMock directly — no patching of global state needed.
    """

    def _response(self, html: str = '', status_code: int = 200) -> MagicMock:
        resp = MagicMock()
        resp.status_code = status_code
        resp.ok = (200 <= status_code < 300)
        resp.text = html
        return resp

    def _session(self, html: str) -> MagicMock:
        session = MagicMock()
        session.get.return_value = self._response(html)
        return session

    def test_parses_og_title(self):
        session = self._session('<meta property="og:title" content="雑談 - Twitch"/>')
        assert _fetch_twitch_ja_name(session, "Just Chatting") == "雑談"

    def test_parses_name_title_as_fallback(self):
        # Some categories only carry name="title", not og:title.
        session = self._session('<meta name="title" content="ウォッチパーティ - Twitch"/>')
        assert _fetch_twitch_ja_name(session, "Watch Parties") == "ウォッチパーティ"

    def test_returns_none_when_title_echoes_english(self):
        # Twitch echoes the English name verbatim when no localisation exists.
        session = self._session(
            '<meta property="og:title" content="PUBG: BATTLEGROUNDS - Twitch"/>'
        )
        assert _fetch_twitch_ja_name(session, "PUBG: BATTLEGROUNDS") is None

    def test_returns_none_when_no_meta_tag_found(self):
        # A bad slug still returns 200 but has no category title meta.
        session = self._session("<html><head><title>Twitch</title></head></html>")
        assert _fetch_twitch_ja_name(session, "Something") is None

    @patch('lib.igdb.time.sleep')
    def test_returns_none_after_all_retries_exhausted(self, mock_sleep):
        # All four attempts (1 initial + 3 retries) fail → return None.
        session = MagicMock()
        session.get.side_effect = requests.RequestException("network error")
        assert _fetch_twitch_ja_name(session, "Just Chatting") is None
        assert session.get.call_count == 4
        assert mock_sleep.call_count == 3

    def test_title_containing_dash_parsed_correctly(self):
        # Japanese title that itself contains spaces (no inner " - ") still
        # strips the " - Twitch" suffix correctly.
        session = self._session(
            '<meta property="og:title" content="ゼルダの伝説 ブレス オブ ザ ワイルド - Twitch"/>'
        )
        result = _fetch_twitch_ja_name(session, "The Legend of Zelda: Breath of the Wild")
        assert result == "ゼルダの伝説 ブレス オブ ザ ワイルド"

    def test_uses_lang_ja_query_param_in_request_url(self):
        session = self._session('<meta property="og:title" content="雑談 - Twitch"/>')
        _fetch_twitch_ja_name(session, "Just Chatting")
        url = session.get.call_args[0][0]
        assert "lang=ja" in url
        assert "just-chatting" in url

    @patch('lib.igdb.time.sleep')
    def test_retries_on_request_exception_then_succeeds(self, mock_sleep):
        # First attempt raises a network error; second succeeds.
        session = MagicMock()
        session.get.side_effect = [
            requests.RequestException("network error"),
            self._response('<meta property="og:title" content="雑談 - Twitch"/>'),
        ]
        assert _fetch_twitch_ja_name(session, "Just Chatting") == "雑談"
        assert session.get.call_count == 2
        mock_sleep.assert_called_once()

    @patch('lib.igdb.time.sleep')
    def test_retries_on_429_then_succeeds(self, mock_sleep):
        # First attempt gets rate-limited; second succeeds.
        session = MagicMock()
        session.get.side_effect = [
            self._response(status_code=429),
            self._response('<meta property="og:title" content="雑談 - Twitch"/>'),
        ]
        assert _fetch_twitch_ja_name(session, "Just Chatting") == "雑談"
        assert session.get.call_count == 2
        mock_sleep.assert_called_once()

    @patch('lib.igdb.time.sleep')
    def test_retries_on_500_then_succeeds(self, mock_sleep):
        # First attempt hits a server error; second succeeds.
        session = MagicMock()
        session.get.side_effect = [
            self._response(status_code=500),
            self._response('<meta property="og:title" content="雑談 - Twitch"/>'),
        ]
        assert _fetch_twitch_ja_name(session, "Just Chatting") == "雑談"
        assert session.get.call_count == 2
        mock_sleep.assert_called_once()

    def test_returns_none_immediately_on_404(self):
        # 404 means the slug doesn't exist — no point retrying.
        session = MagicMock()
        session.get.return_value = self._response(status_code=404)
        assert _fetch_twitch_ja_name(session, "Unknown Game") is None
        assert session.get.call_count == 1

    def test_utf8_decoding_forced_regardless_of_content_type(self):
        """requests defaults to ISO-8859-1 for text/html when no charset is present
        in the Content-Type header, turning UTF-8 Japanese into mojibake.
        _fetch_twitch_ja_name must force UTF-8 decoding explicitly.

        "雑談" in UTF-8: E9 9B 93 E8 AB 87.  Decoded as Latin-1 those bytes produce
        visible characters é, è, « with the non-printable bytes dropped — exactly
        the corrupt "éè«" observed in the deployed version.
        """
        import requests as req_module

        html = '<meta property="og:title" content="雑談 - Twitch"/>'
        resp = req_module.models.Response()
        resp.status_code = 200
        resp.headers['Content-Type'] = 'text/html'  # no charset → ISO-8859-1 default
        resp._content = html.encode('utf-8')

        session = MagicMock()
        session.get.return_value = resp

        assert _fetch_twitch_ja_name(session, "Just Chatting") == "雑談"
