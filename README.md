# twist-clear

A two-part tool for building and browsing a personal archive of Twitch clip metadata.

**Scraper** (`scrape.py`, `lib/`) — fetches clip metadata for your chosen channels via the Twitch Helix API and stores it in a local SQLite database. Handles full historical scrapes and lightweight incremental updates.

**Viewer** (`frontend/`) — a browser-based SPA that queries the database directly in the browser via HTTP Range requests ([sql.js-httpvfs](https://github.com/phiresky/sql.js-httpvfs)), so only the pages needed for each query are fetched — the full database is never downloaded at once.

The easiest way to get a live, automatically-updating archive is to [deploy it to GitHub Pages](#deploying-to-github-pages) — no server required. If you prefer to run everything locally, see [Running locally](#running-locally).

---

## Deploying to GitHub Pages

The recommended setup uses two GitHub repositories:

- **This repo** (`twist-clear`) — contains all the code and a reusable GitHub Actions workflow.
- **Your archive repo** (e.g. `my-clips`, can be private) — contains only your credentials (as secrets) and a short workflow file that calls the reusable one. The archive repo's GitHub Pages site hosts your clip viewer.

A daily Actions run scrapes all clips from scratch and redeploys the site. Each run takes roughly 30 minutes for a typical archive, which is well within Actions' free tier limits.

**Full walkthrough:** [docs/deploying.md](docs/deploying.md)

**Quick summary:**

1. **Twitch app** — create one at https://dev.twitch.tv/console/apps (see [step-by-step instructions](#1-create-a-twitch-application) below; you'll need Client ID and Client Secret).
2. **Create the archive repo** — any name, public or private.
3. **Add secrets** — `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` (required); `TWITCH_WEB_CLIENT_ID` (optional, enables Login with Twitch) under *Settings → Secrets and variables → Actions*.
4. **Enable Pages** — *Settings → Pages*, source set to **GitHub Actions**.
5. **Add this workflow file** as `.github/workflows/deploy.yml` in the archive repo, replacing `YOUR_USERNAME` and the streamer logins:

```yaml
name: Deploy clip archive

on:
  schedule:
    - cron: '0 6 * * *'
  workflow_dispatch:

jobs:
  deploy:
    uses: oatmeal/twist-clear/.github/workflows/deploy.yml@master
    with:
      streamers: "streamer1,streamer2"
    secrets:
      TWITCH_CLIENT_ID: ${{ secrets.TWITCH_CLIENT_ID }}
      TWITCH_CLIENT_SECRET: ${{ secrets.TWITCH_CLIENT_SECRET }}
      TWITCH_WEB_CLIENT_ID: ${{ secrets.TWITCH_WEB_CLIENT_ID }}  # optional, enables Login with Twitch
```

6. **Trigger the first run** manually from the Actions tab. Once it completes, your archive is live at `https://YOUR_USERNAME.github.io/my-clips/`.

Optional inputs let you customise the site title, social-preview metadata, and the full colour palette — see [Inputs reference](docs/deploying.md#inputs-reference) in the deployment guide.

---

## Running locally

For local development, ad-hoc scraping, or self-hosting on your own server.

### Prerequisites

- Python 3.11+ and [uv](https://docs.astral.sh/uv/)
- Node.js 18+ and npm

### Setup

#### 1. Create Twitch applications

Two separate apps are required because the scraper and the browser viewer need different OAuth client types.

**App 1 — Scraper (required)**

The scraper uses the **Client Credentials** flow to read public clip data.

1. Go to **https://dev.twitch.tv/console/apps** and sign in, then click **Register Your Application**.

2. Fill in the registration form:

   | Field | What to enter |
   |---|---|
   | **Name** | Anything descriptive, e.g. `clips-scraper`. Must be unique on Twitch. |
   | **OAuth Redirect URLs** | `http://localhost` (placeholder; the scraper doesn't use OAuth redirects). |
   | **Category** | *Application Integration* (doesn't affect credentials). |
   | **Client Type** | **Confidential** — required to generate a client secret for the scraper. |

3. Click **Create**, then **Manage** next to your app. Click **New Secret**, then copy both the **Client ID** and **Client Secret** — the secret is only shown once.

**App 2 — Browser login (optional)**

Enables the **"Login with Twitch"** button in the viewer, which fetches clips newer than the archive date. Uses Twitch's implicit grant OAuth (response_type=token) — no secret is ever sent from the browser.

1. Register a second application at the same URL.

2. Fill in the registration form:

   | Field | What to enter |
   |---|---|
   | **Name** | Anything descriptive, e.g. `clips-viewer`. Must be unique on Twitch. |
   | **OAuth Redirect URLs** | All URLs where your viewer runs, **without trailing slashes**: `http://localhost:5173`, `http://localhost:4173`, and your deployed URL (e.g. `https://you.github.io/my-clips`). |
   | **Category** | *Application Integration*. |
   | **Client Type** | **Public** — required for browser OAuth; public apps have no client secret. |

3. Click **Create**, then **Manage** and copy the **Client ID** (no secret is generated or needed).

#### 2. Configure

```sh
git clone <repo>
cd twist-clear
cp config.toml.example config.toml
```

Edit `config.toml`:

```toml
[twitch]
client_id     = "..."   # Scraper app (Confidential) — Client ID
client_secret = "..."   # Scraper app (Confidential) — Client Secret

# Optional: enables "Login with Twitch" in the viewer (separate Public app).
# web_client_id = "..."

[scraper]
db_path = "data/clips.db"   # created automatically on first run

[[streamers]]
login = "channelname"       # Twitch login (lowercase), one block per channel
```

#### 3. Install dependencies

```sh
uv sync                      # Python scraper
cd frontend && npm install   # browser viewer
```

### Scraper

**Initial scrape** — fetches the full clip history for every configured streamer:

```sh
uv run python scrape.py fetch
```

This can take a while for channels with large histories. Progress is saved after every time window, so if interrupted it picks up where it left off.

**Incremental update** — fetches only clips created since the last run:

```sh
uv run python scrape.py update
```

Both commands upsert clips, so re-running is always safe and `view_count` values stay current.

**Options:**

```
--config PATH   Path to config file (default: config.toml)
--db PATH       Override the database path from config
```

**How fetch works:** `fetch` uses adaptive time windows starting from the channel's account creation date. Each window makes one API call (up to 100 clips). If a full page comes back the window is halved; on success it doubles again up to a maximum of 30 days, so long quiet stretches are covered efficiently. Pagination cursors are never saved — each window is a fully stateless, self-contained request.

### Browser viewer

**Dev server** — the dev server reads `data/clips.db` directly via a symlink, always reflecting the latest scraped data:

```sh
cd frontend
npm run dev   # → http://localhost:5173
```

**Prepare the database for deployment:**

```sh
cd frontend
npm run prepare-db   # → writes frontend/public/clips.db
```

This converts the database to DELETE journal mode (required by sql.js-httpvfs), adds a FTS5 trigram index for fast title search, adds covering indexes and precomputed metadata to avoid expensive full-table scans on first load, then VACUUMs for compact layout.

**Production build:**

```sh
cd frontend
npm run build   # → frontend/dist/
```

Requires `frontend/public/clips.db` — run `prepare-db` first. Serve `frontend/dist/` from any static host that supports HTTP Range requests (`206 Partial Content`).

**Viewer features:**

- Thumbnail grid with clip title, view count, creator, game, and date
- Search by title, filter by game, sort by views or date
- Date range filter and calendar view (year heatmap → month grid, selectable by day or week)
- URL hash preserves all filter state — links are bookmarkable and shareable
- Click a thumbnail to embed the clip inline; click outside or press Escape to close
- **Login with Twitch** — fetches clips newer than the archive date live from the Twitch API and displays them above the archive grid (no backend required; uses Twitch's implicit grant OAuth)

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
npm test           # Vitest unit tests (123 tests — query builder, hash, date utils, formatting, live filter, OAuth helpers)
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
