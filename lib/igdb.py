"""IGDB API client for fetching localised game names.

IGDB uses the same Twitch OAuth credentials (client-id / client-secret) as the
Twitch Helix API.  A client-credentials token obtained from
``https://id.twitch.tv/oauth2/token`` is accepted by both services.

The two IGDB endpoints used here:

* ``/v4/external_games`` — maps third-party platform IDs to IGDB game IDs.
  Filtering by ``external_game_source = 14`` targets Twitch category IDs,
  which are the same IDs stored in the local ``games`` table.

* ``/v4/game_localizations`` — per-region localised names.
  ``region = 3`` is Japan (ja-JP).

For categories not in IGDB at all (e.g. "Just Chatting", "Watch Parties"),
``get_ja_names`` falls back to Twitch's own web directory pages.  These pages
carry official Twitch localisations in their ``og:title`` / ``name="title"``
meta tags and are served fully server-side — no JavaScript execution needed.
"""

import re
import time
import unicodedata

import requests

_BASE = "https://api.igdb.com/v4"
_TOKEN_URL = "https://id.twitch.tv/oauth2/token"

# How many IDs to include in a single Apicalypse ``where … = (…)`` clause.
_BATCH_SIZE = 100

# IGDB external_game_sources ID for Twitch (confirmed via /v4/external_game_sources).
_TWITCH_SOURCE_ID = 14

# IGDB regions ID for Japan (confirmed via /v4/regions, identifier "ja-JP").
_JAPAN_REGION_ID = 3

# ---------------------------------------------------------------------------
# Twitch web fallback helpers
# ---------------------------------------------------------------------------

_TWITCH_CAT_URL = "https://www.twitch.tv/directory/category/{slug}?lang=ja"
_TWITCH_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

# Matches either og:title or name="title" meta content, stripping " - Twitch".
# Both variants appear in Twitch's HTML depending on the category:
#   <meta property="og:title" content="雑談 - Twitch"/>
#   <meta name="title" content="ウォッチパーティ - Twitch"/>
#
# The closing " of the attribute value sits in different positions in each form:
#   og:title → property="og:title"·content=  (the " closes the property value)
#   name="title" → name="title"·content=      (the " closes the title value, inside the pattern)
# So the " must be part of the og:title branch, not after the group.
_TITLE_RE = re.compile(r'(?:og:title"|name="title") content="([^"]*?) - Twitch"')

# Polite delay between consecutive Twitch web requests (seconds).
_TWITCH_DELAY = 1.0

# Delays (seconds) before each retry attempt after the initial request fails.
# Applied on: network errors, HTTP 429 (rate-limited), HTTP 5xx (server error).
# Non-retriable failures (HTTP 4xx other than 429) return None immediately.
_RETRY_DELAYS = (2.0, 5.0, 10.0)


def _name_to_slug(name: str) -> str:
    """Convert a Twitch game/category name to its web directory URL slug.

    Algorithm: NFD-normalise (é→e), ASCII-only, lowercase, strip
    non-alphanumeric chars (except hyphens), collapse spaces/hyphens.

    Examples::

        "Just Chatting"  → "just-chatting"
        "ELDEN RING"     → "elden-ring"
        "Pokémon UNITE"  → "pokemon-unite"
        "Animal Crossing: New Horizons" → "animal-crossing-new-horizons"
        "Games + Demos"  → "games-demos"
    """
    normalized = unicodedata.normalize("NFD", name)
    ascii_only = normalized.encode("ascii", "ignore").decode()
    slug = ascii_only.lower()
    slug = re.sub(r"[^a-z0-9\s-]", "", slug)  # strip special chars
    slug = re.sub(r"\s+", "-", slug.strip())  # spaces → hyphens
    slug = re.sub(r"-+", "-", slug)  # collapse runs of hyphens
    return slug


def _fetch_twitch_ja_name(session: requests.Session, en_name: str) -> str | None:
    """Return the Japanese name for a Twitch category from its public web page.

    Returns ``None`` if:

    * the slug cannot be derived (empty result),
    * the request fails on all attempts,
    * no title meta tag is found (slug does not match any Twitch category), or
    * Twitch echoes the English name back (meaning no Japanese localisation).

    Retries up to ``len(_RETRY_DELAYS)`` times (with the configured back-off
    delays) on network errors, HTTP 429 (rate-limited), and HTTP 5xx (server
    error).  Non-retriable HTTP errors (4xx other than 429) return ``None``
    immediately.
    """
    slug = _name_to_slug(en_name)
    if not slug:
        return None

    url = _TWITCH_CAT_URL.format(slug=slug)

    for delay in (0.0, *_RETRY_DELAYS):
        if delay:
            time.sleep(delay)
        try:
            resp = session.get(url, headers={"User-Agent": _TWITCH_UA}, timeout=10)
        except requests.RequestException:
            continue  # network error — retry

        if resp.status_code == 429 or resp.status_code >= 500:
            continue  # rate-limited or server error — retry

        if not resp.ok:
            return None  # 4xx (e.g. slug not found) — no point retrying

        resp.encoding = 'utf-8'  # Twitch omits charset in Content-Type; requests
        # defaults to ISO-8859-1 for text/html per RFC 2616, causing mojibake.
        m = _TITLE_RE.search(resp.text)
        if not m:
            return None
        ja_name = m.group(1).strip()
        # If Twitch just echoes the English name, there is no Japanese localisation.
        return None if ja_name == en_name else ja_name

    return None  # all attempts exhausted


# ---------------------------------------------------------------------------
# IGDB client
# ---------------------------------------------------------------------------


class IGDBClient:
    """Minimal IGDB client for resolving Twitch game IDs to Japanese names."""

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
            _TOKEN_URL,
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
            "Client-ID": self.client_id,
            "Authorization": f"Bearer {self._get_token()}",
        }

    # ------------------------------------------------------------------
    # Low-level POST helper
    # ------------------------------------------------------------------

    def _post(self, endpoint: str, query: str) -> list[dict]:
        url = f"{_BASE}/{endpoint}"
        resp = requests.post(url, headers=self._headers(), data=query)
        resp.raise_for_status()
        result = resp.json()
        if isinstance(result, list):
            return result
        return []

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get_ja_names(self, id_to_name: dict[str, str]) -> dict[str, str]:
        """Return a mapping of Twitch game ID → Japanese localised name.

        ``id_to_name`` maps each Twitch category ID to its English name (as
        returned by the Helix ``/games`` endpoint).  The English names are
        needed for the Twitch web fallback described below.

        Games that have no Japanese localisation in either source are omitted
        from the result; callers should treat missing entries as "use English
        name".

        Implementation:

        1. **IGDB** ``external_games`` look-up (source 14 = Twitch) converts
           Twitch IDs to IGDB game IDs; ``game_localizations`` (region 3 =
           Japan) resolves those to Japanese names.  Covers most real games.

        2. **Twitch web fallback** — for any IDs not found in IGDB (typically
           non-game categories like "Just Chatting"), the method fetches
           ``https://www.twitch.tv/directory/category/<slug>?lang=ja`` and
           extracts the Japanese name from the ``og:title`` / ``name="title"``
           meta tag.  Requests are spaced ``_TWITCH_DELAY`` seconds apart.
        """
        if not id_to_name:
            return {}

        twitch_ids = list(id_to_name)

        # ---- Step 1: IGDB lookup ----------------------------------------

        # Twitch game ID → IGDB game ID
        twitch_to_igdb: dict[str, int] = {}
        for i in range(0, len(twitch_ids), _BATCH_SIZE):
            batch = twitch_ids[i : i + _BATCH_SIZE]
            uid_list = ", ".join(f'"{tid}"' for tid in batch)
            rows = self._post(
                "external_games",
                f"fields game, uid;"
                f" where external_game_source = {_TWITCH_SOURCE_ID}"
                f" & uid = ({uid_list});"
                f" limit 500;",
            )
            for row in rows:
                if "game" in row and "uid" in row:
                    twitch_to_igdb[str(row["uid"])] = int(row["game"])

        result: dict[str, str] = {}

        if twitch_to_igdb:
            # IGDB game ID → Japanese localised name
            igdb_ids = list(twitch_to_igdb.values())
            igdb_to_ja: dict[int, str] = {}
            for i in range(0, len(igdb_ids), _BATCH_SIZE):
                batch_ids = igdb_ids[i : i + _BATCH_SIZE]
                id_list = ", ".join(str(gid) for gid in batch_ids)
                rows = self._post(
                    "game_localizations",
                    f"fields game, name;"
                    f" where region = {_JAPAN_REGION_ID}"
                    f" & game = ({id_list});"
                    f" limit 500;",
                )
                for row in rows:
                    if "game" in row and "name" in row:
                        igdb_to_ja[int(row["game"])] = str(row["name"])

            # Compose: twitch_id → ja_name
            igdb_to_twitch = {v: k for k, v in twitch_to_igdb.items()}
            result = {
                igdb_to_twitch[igdb_id]: ja_name
                for igdb_id, ja_name in igdb_to_ja.items()
                if igdb_id in igdb_to_twitch
            }

        # ---- Step 2: Twitch web fallback --------------------------------
        # For IDs not found in IGDB (e.g. non-game categories), try scraping
        # Twitch's own directory page which carries official localisations.

        missing = [tid for tid in twitch_ids if tid not in result]
        if missing:
            session = requests.Session()
            for i, tid in enumerate(missing):
                if i > 0:
                    time.sleep(_TWITCH_DELAY)
                ja = _fetch_twitch_ja_name(session, id_to_name[tid])
                if ja:
                    result[tid] = ja

        return result
