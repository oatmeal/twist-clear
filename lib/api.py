import time
from collections.abc import Iterator

import requests

# Slow down proactively when fewer than this many requests remain in the window.
_RATE_LIMIT_BUFFER = 20
# Seconds to pause when the remaining budget is low (avoids hitting 429).
_RATE_LIMIT_PAUSE = 1.0


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

            # Proactive: pause briefly when the remaining budget is nearly gone
            # so we don't have to wait for a full 429 cycle.
            remaining = resp.headers.get("Ratelimit-Remaining")
            if remaining is not None and int(remaining) < _RATE_LIMIT_BUFFER:
                reset = float(resp.headers.get("Ratelimit-Reset", time.time() + 1))
                wait = max(_RATE_LIMIT_PAUSE, reset - time.time())
                print(f"  Rate limit low ({remaining} remaining) — waiting {wait:.1f}s...")
                time.sleep(wait)

            return resp.json()

    # ------------------------------------------------------------------
    # API methods
    # ------------------------------------------------------------------

    def get_users(self, logins: list[str]) -> list[dict]:
        """Resolve up to 100 usernames to user objects."""
        data = self._get("users", {"login": logins})
        return data.get("data", [])

    def get_clips_window(
        self,
        broadcaster_id: str,
        started_at: str,
        ended_at: str,
    ) -> tuple[list[dict], bool]:
        """Fetch at most 100 clips in [started_at, ended_at].

        Returns (clips, has_more). has_more is True when the response includes
        a pagination cursor, meaning the window contains more than 100 clips
        and should be narrowed before retrying. The cursor itself is discarded —
        it is never stored, only used as a boolean overflow signal.
        """
        data = self._get(
            "clips",
            {
                "broadcaster_id": broadcaster_id,
                "started_at": started_at,
                "ended_at": ended_at,
                "first": 100,
            },
        )
        clips = data.get("data", [])
        has_more = bool(data.get("pagination", {}).get("cursor"))
        return clips, has_more

    def get_clips(
        self,
        broadcaster_id: str,
        started_at: str | None = None,
    ) -> Iterator[list[dict]]:
        """Yield pages of clip dicts for a broadcaster (used by incremental update).

        Pages are returned in descending view-count order (Twitch default).
        Cursors are consumed within this single call and are never persisted.
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

    def get_clips_by_ids(self, clip_ids: list[str]) -> list[dict]:
        """Fetch current metadata for specific clip IDs (max 100 per API call)."""
        results: list[dict] = []
        for i in range(0, len(clip_ids), 100):
            batch = clip_ids[i : i + 100]
            data = self._get("clips", {"id": batch})
            results.extend(data.get("data", []))
        return results

    def get_games(self, game_ids: list[str]) -> list[dict]:
        """Batch-resolve game IDs to game objects (max 100 per request)."""
        results: list[dict] = []
        for i in range(0, len(game_ids), 100):
            batch = game_ids[i : i + 100]
            data = self._get("games", {"id": batch})
            results.extend(data.get("data", []))
        return results
