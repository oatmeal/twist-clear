from unittest.mock import MagicMock

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

    def _session(self, html: str) -> MagicMock:
        session = MagicMock()
        resp = MagicMock()
        resp.text = html
        resp.raise_for_status = MagicMock()
        session.get.return_value = resp
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

    def test_returns_none_on_request_error(self):
        session = MagicMock()
        session.get.side_effect = requests.RequestException("network error")
        assert _fetch_twitch_ja_name(session, "Just Chatting") is None

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
