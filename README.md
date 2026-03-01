# twitch-clips-scraper

Scrapes clip metadata for a set of Twitch channels via the Twitch Helix API and stores it in a local SQLite database. Designed for an initial full scrape followed by lightweight incremental updates as new clips are created.

## Prerequisites

- Python 3.11+
- [uv](https://docs.astral.sh/uv/)
- A Twitch application (client ID + secret) — create one at https://dev.twitch.tv/console/apps

No user login or OAuth flow is required; the scraper uses the app access token (client credentials) to access public clip data.

## Setup

```sh
git clone <repo>
cd twitch-clips-scraper

cp config.toml.example config.toml
# Edit config.toml with your credentials and streamers

uv sync
```

## Configuration

`config.toml` has three sections:

```toml
[twitch]
client_id     = "..."
client_secret = "..."

[scraper]
db_path = "data/clips.db"   # where to write the SQLite database

[[streamers]]
login = "channelname"       # Twitch login (lowercase), one block per channel
```

Add as many `[[streamers]]` blocks as you like. The `db_path` is created automatically on first run.

## Usage

**Initial scrape** — fetches the full clip history for every configured streamer:

```sh
uv run python scrape.py fetch
```

**Incremental update** — fetches only clips created since the last run:

```sh
uv run python scrape.py update
```

Both commands are safe to re-run. Clips are upserted, so interrupted runs can be resumed and `view_count` values are refreshed on each pass.

### Options

```
--config PATH   Path to config file (default: config.toml)
--db PATH       Override the database path from config
```

## Database schema

The database lives at `data/clips.db` (or wherever `db_path` points).

| Table | Description |
|---|---|
| `streamers` | One row per tracked channel, including scrape state |
| `clips` | One row per clip — all metadata returned by the API |
| `games` | Game ID → name cache, populated lazily as clips are fetched |

Useful queries:

```sql
-- All clips for a channel, newest first
SELECT c.title, c.view_count, c.created_at, g.name AS game
FROM clips c
LEFT JOIN games g ON g.id = c.game_id
WHERE c.broadcaster_id = (SELECT id FROM streamers WHERE login = 'channelname')
ORDER BY c.created_at DESC;

-- Top 10 clips by view count across all channels
SELECT c.title, s.display_name, c.view_count, g.name AS game
FROM clips c
JOIN streamers s ON s.id = c.broadcaster_id
LEFT JOIN games g ON g.id = c.game_id
ORDER BY c.view_count DESC
LIMIT 10;

-- Scrape state summary
SELECT display_name, full_history_fetched, newest_clip_at, last_scraped_at
FROM streamers;
```

## Keeping the database up to date

Run `update` on whatever schedule suits your needs. For example, as a daily cron job:

```
0 6 * * * cd /path/to/twitch-clips-scraper && uv run python scrape.py update
```

Or as a GitHub Actions workflow on a schedule — store your credentials as repository secrets and pass them in via environment variables or a generated `config.toml`.

## Development

```sh
uv run ruff check .        # lint
uv run ruff check --fix .  # lint + auto-fix
uv run ruff format .       # format
```
