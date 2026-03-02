# twitch-clips-scraper

A two-part tool for building and browsing a personal archive of Twitch clip metadata.

**Scraper** (`scrape.py`, `lib/`) — fetches clip metadata for your chosen channels via the Twitch Helix API and stores it in a local SQLite database. Handles full historical scrapes and lightweight incremental updates.

**Viewer** (`frontend/`) — a browser-based SPA that queries the database directly in the browser via HTTP Range requests ([sql.js-httpvfs](https://github.com/phiresky/sql.js-httpvfs)), so only the pages needed for each query are fetched — the full database is never downloaded at once.

---

## Quick start

```sh
git clone <repo>
cd twitch-clips-scraper

# Configure credentials and streamers (see Setup below)
cp config.toml.example config.toml
# edit config.toml

# Install scraper dependencies
uv sync

# Run the initial scrape
uv run python scrape.py fetch

# Launch the viewer
cd frontend && npm install && npm run dev
# → open http://localhost:5173
```

---

## Setup

### 1. Create a Twitch application

The scraper uses the **Client Credentials** flow — an app access token with no user login required — to read public clip data. You need a Twitch application to get a client ID and secret.

1. Go to **https://dev.twitch.tv/console/apps** and sign in, then click **Register Your Application** (or **+ Register Your Application**).

2. Fill in the registration form:

   | Field | What to enter |
   |---|---|
   | **Name** | Anything descriptive, e.g. `clips-scraper`. Must be unique on Twitch. |
   | **OAuth Redirect URLs** | `http://localhost` — this field is required by the form but is never used by the client credentials flow. |
   | **Category** | *Application Integration* (or any category; it doesn't affect the credentials). |
   | **Client Type** | **Confidential** — this is the option that provides a client secret, which the client credentials flow requires. If you choose *Public* you won't get a secret. |

3. Click **Create**. You'll be returned to the app list.

4. Click **Manage** next to your new application. Here you'll see your **Client ID**. Click **New Secret** to generate a client secret. Copy both values — the secret is only shown once (you can regenerate it if you lose it).

### 2. Edit config.toml

```sh
cp config.toml.example config.toml
```

Open `config.toml` and fill in your credentials and the channels you want to track:

```toml
[twitch]
client_id     = "..."   # from the app management page
client_secret = "..."   # the secret you generated above

[scraper]
db_path = "data/clips.db"   # created automatically on first run

[[streamers]]
login = "channelname"       # Twitch login (lowercase), one block per channel

[[streamers]]
login = "anotherchannel"
```

Add as many `[[streamers]]` blocks as you need.

### 3. Install dependencies

**Scraper** (requires Python 3.11+ and [uv](https://docs.astral.sh/uv/)):

```sh
uv sync
```

**Viewer** (requires Node.js 18+ and npm):

```sh
cd frontend && npm install
```

---

## Scraper

### Commands

**Initial scrape** — fetches the full clip history for every configured streamer:

```sh
uv run python scrape.py fetch
```

This can take a while for channels with large histories. It writes progress after every time window, so if interrupted it picks up where it left off.

**Incremental update** — fetches only clips created since the last run:

```sh
uv run python scrape.py update
```

Both commands upsert clips, so re-running is always safe and `view_count` values are kept current.

### Options

```
--config PATH   Path to config file (default: config.toml)
--db PATH       Override the database path from config
```

### Keeping the database current

Run `update` on whatever schedule suits your needs. As a daily cron job:

```
0 6 * * * cd /path/to/twitch-clips-scraper && uv run python scrape.py update
```

Or as a GitHub Actions scheduled workflow — store your credentials as repository secrets and pass them in via environment variables or a generated `config.toml`.

### How it works

**`fetch`** uses adaptive time windows to scan the full clip history starting from the channel's account creation date. Each window covers a fixed time range and makes one API call (up to 100 clips). If the response fills a full page (indicating more clips exist in that range), the window is halved and retried. Once a window fits in a single request the size doubles again, up to a maximum of 30 days:

```
[2022-01-01 → 2022-01-02]   12 clips  ✓  advance, try 2-day window
[2022-01-02 → 2022-01-04]   87 clips  ✓  advance, try 4-day window
[2022-01-04 → 2022-01-08]  100 clips  ✗  too many — halve to 2 days
[2022-01-04 → 2022-01-06]   43 clips  ✓  advance
...
```

Pagination cursors are never saved. Per Twitch's documentation they are for immediate sequential use only; each window is a fully stateless, self-contained request.

**`update`** fetches clips created after the most recent clip already in the database (`newest_clip_at`), using standard cursor-based pagination within the session.

---

## Browser viewer

### Features

- Thumbnail grid with clip title, view count, creator, game, and date
- Search by title, filter by game, sort by views or date
- Date range filter (from/to inputs)
- Calendar view — year heatmap → month grid with clip counts per day, selectable by day or ISO week
- Pagination (24 clips per page)
- URL hash preserves all filter and navigation state; links are bookmarkable and shareable
- Each thumbnail links directly to the clip on Twitch

### Dev server

The dev server uses `data/clips.db` directly via a symlink at `frontend/public/clips.db`, so it always reflects the latest scraped data without any export step.

```sh
cd frontend
npm run dev   # → http://localhost:5173
```

### Preparing the database for deployment

The raw `data/clips.db` is suitable for local development, but before deploying run the preparation script:

```sh
cd frontend
npm run prepare-db   # → writes frontend/public/clips.db
```

This script:

- Converts the database to **DELETE journal mode** (required by sql.js-httpvfs; WAL mode is not supported)
- Adds a **FTS5 trigram index** (`clips_fts`) for fast substring title search, including Japanese/CJK (requires SQLite ≥ 3.38)
- Adds covering indexes and a precomputed metadata table to avoid expensive full-table scans on cold browser cache
- VACUUMs the file for compact range-request access

The viewer detects these additions at startup and uses them automatically; without them it falls back to live aggregate queries.

### Production build

```sh
cd frontend
npm run build   # → frontend/dist/
```

Requires `frontend/public/clips.db` to exist — run `prepare-db` first.

Serve `frontend/dist/` from any static host that supports HTTP Range requests (`206 Partial Content`). Most CDNs and object storage services (S3, Cloudflare R2, Netlify) do; standard nginx and Apache do too.

### Deploying to GitHub Pages

See **[docs/deploying.md](docs/deploying.md)** for a complete walkthrough. The short version: create a private archive repo, add your Twitch credentials as secrets, enable Pages with "GitHub Actions" as the source, and add a workflow that calls the reusable `deploy.yml` in this repo. A daily schedule rebuilds and redeploys the archive automatically.

---

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

---

## Development

**Scraper (Python):**

```sh
uv run pytest              # run tests
uv run ruff check .        # lint
uv run ruff check --fix .  # lint + auto-fix
uv run ruff format .       # format
```

**Viewer (TypeScript):**

```sh
cd frontend
npm test           # Vitest unit tests (88 tests — query builder, hash, date utils, formatting)
npx tsc --noEmit   # type-check
```

Source layout under `frontend/src/`:

| File | Purpose |
|---|---|
| `app.ts` | Main render loop, event binding, URL hash state |
| `calendar.ts` | Calendar view (year/month/day/week navigation) |
| `db.ts` | sql.js-httpvfs worker setup; async `q()` helper |
| `state.ts` | All shared mutable state with typed setters |
| `lib/query.ts` | Pure `buildWhere()` — SQL WHERE clause builder |
| `lib/hash.ts` | Pure `serializeHash()` / `deserializeHash()` |
| `lib/format.ts` | HTML escaping, duration/views/date formatting |
| `lib/dateUtils.ts` | Local-timezone date arithmetic (no UTC pitfalls) |
