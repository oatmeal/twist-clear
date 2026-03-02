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

### Options

```
--config PATH   Path to config file (default: config.toml)
--db PATH       Override the database path from config
```

## How the scraper works

### `fetch` — full historical scrape

The fetch command scans a streamer's entire clip history using adaptive time windows, starting from the date the Twitch account was created.

Each window makes exactly one API request (`started_at` + `ended_at`, up to 100 clips). If the API returns a full page with a continuation cursor — indicating more than 100 clips exist in that window — the window is halved and retried. Narrowing continues until the window fits in a single request. After a successful window the size doubles again, up to a maximum of one day, so long inactive periods are covered efficiently.

```
[2022-01-01 → 2022-01-02]   12 clips  ✓  advance, try 2-day window
[2022-01-02 → 2022-01-04]   87 clips  ✓  advance, try 4-day window
[2022-01-04 → 2022-01-08]  100 clips  ✗  too many — halve to 2 days
[2022-01-04 → 2022-01-06]   43 clips  ✓  advance
...
```

Pagination cursors are intentionally never stored. Per Twitch's own documentation, cursors are intended only for immediate sequential use and offer no validity guarantees if saved and reused later. Each window is instead a fully self-contained, stateless request.

After each completed window, `fetch_progress_at` is written to the database. If the run is interrupted, restarting `fetch` picks up from that timestamp — at most one window of work is repeated. Streamers that have already been fully fetched are skipped automatically.

### `update` — incremental update

The update command fetches only clips created after the most recent clip already in the database (`newest_clip_at`). It uses standard cursor-based pagination within the single session, advancing the watermark once all pages are processed.

Both commands upsert clips, so re-running is always safe and `view_count` values are kept current.

## Database schema

The database lives at `data/clips.db` (or wherever `db_path` points).

| Table | Description |
|---|---|
| `streamers` | One row per tracked channel, including scrape state |
| `clips` | One row per clip — all metadata returned by the API |
| `games` | Game ID → name cache, populated lazily as clips are fetched |

Key columns on `streamers`:

| Column | Description |
|---|---|
| `account_created_at` | Twitch account creation date; used as the fetch start point |
| `fetch_progress_at` | Latest completed window end; allows fetch to resume after interruption |
| `full_history_fetched` | Set to 1 once fetch completes; gates the update command |
| `newest_clip_at` | Most recent clip timestamp; used as the update watermark |

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
SELECT display_name, full_history_fetched, fetch_progress_at, newest_clip_at, last_scraped_at
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
uv run pytest              # run tests
uv run ruff check .        # lint
uv run ruff check --fix .  # lint + auto-fix
uv run ruff format .       # format
```
