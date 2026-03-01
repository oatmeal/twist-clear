import time
from collections.abc import Iterator

import requests


class TwitchAPI:
    _BASE = "https://api.twitch.tv/helix"
    _TOKEN_URL = "https://id.twitch.tv/oauth2/token"

    def __init__(self, client_id: str, client_secret: str) -> None:
        self.client_id = client_id
        self.client_secret = client_secret
        self._token: str | None = None
        self._token_expiry: float = 0.0

    # ------------------------------------------------------------------
    # Auth
    # ------------------------------------------------------------------

    def _get_token(self) -> str:
        if self._token and time.time() < self._token_expiry - 60:
            return self._token
        resp = requests.post(
            self._TOKEN_URL,
            params={
                "client_id": self.client_id,
                "client_secret": self.client_secret,
                "grant_type": "client_credentials",
            },
        )
        resp.raise_for_status()
        data = resp.json()
        self._token = data["access_token"]
        self._token_expiry = time.time() + data["expires_in"]
        return self._token

    def _headers(self) -> dict:
        return {
            "Client-Id": self.client_id,
            "Authorization": f"Bearer {self._get_token()}",
        }

    # ------------------------------------------------------------------
    # Low-level request with rate-limit handling
    # ------------------------------------------------------------------

    def _get(self, endpoint: str, params: dict) -> dict:
        url = f"{self._BASE}/{endpoint}"
        while True:
            resp = requests.get(url, headers=self._headers(), params=params)
            if resp.status_code == 429:
                reset = float(resp.headers.get("Ratelimit-Reset", time.time() + 1))
                wait = max(0.0, reset - time.time()) + 0.1
                print(f"  Rate limited — waiting {wait:.1f}s...")
                time.sleep(wait)
                continue
            resp.raise_for_status()
            return resp.json()

    # ------------------------------------------------------------------
    # API methods
    # ------------------------------------------------------------------

    def get_users(self, logins: list[str]) -> list[dict]:
        """Resolve up to 100 usernames to user objects."""
        data = self._get("users", {"login": logins})
        return data.get("data", [])

    def get_clips(
        self,
        broadcaster_id: str,
        started_at: str | None = None,
    ) -> Iterator[list[dict]]:
        """Yield pages of clip dicts for a broadcaster.

        Pages are returned in descending view-count order (Twitch default).
        Pass started_at (ISO 8601) to restrict to clips created on or after
        that timestamp — used for incremental updates.
        """
        params: dict = {"broadcaster_id": broadcaster_id, "first": 100}
        if started_at:
            params["started_at"] = started_at

        while True:
            data = self._get("clips", params)
            clips = data.get("data", [])
            if not clips:
                break
            yield clips
            cursor = data.get("pagination", {}).get("cursor")
            if not cursor:
                break
            params["after"] = cursor

    def get_games(self, game_ids: list[str]) -> list[dict]:
        """Batch-resolve game IDs to game objects (max 100 per request)."""
        results: list[dict] = []
        for i in range(0, len(game_ids), 100):
            batch = game_ids[i : i + 100]
            data = self._get("games", {"id": batch})
            results.extend(data.get("data", []))
        return results
