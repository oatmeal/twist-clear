# Deploying a clip archive to GitHub Pages

This guide walks through deploying a live clip archive as a GitHub Pages site. The archive runs on a schedule: once a day it scrapes the latest clips and redeploys the viewer.

## Architecture overview

Two GitHub repositories are involved:

| Repo | Visibility | Purpose |
|---|---|---|
| `twist-clear` (this repo) | Public | Scraper code + frontend + reusable workflow |
| `my-clips` (your archive repo) | Public or private* | Schedule config + Twitch secrets |

The archive repo's workflow calls the reusable `deploy.yml` in this repo, which handles everything: checking out the code, scraping, building, and deploying to the archive repo's GitHub Pages site.

> \* GitHub Pages for private repositories requires GitHub Pro or a paid organisation plan.

**Note**: the reusable workflow defaults to checking out `oatmeal/twist-clear`. If you are using a fork or a copy of the code under a different account, pass the `code_repo` input explicitly (see [Inputs reference](#inputs-reference)).

---

## Step 1 — Create the archive repo

Create a new GitHub repository for your archive. It can be named anything (e.g. `my-clips`). No special files are needed; the workflow downloads all code from this repo.

---

## Step 2 — Add Twitch credentials as secrets

In your archive repo, go to **Settings → Secrets and variables → Actions** and add the following repository secrets:

| Secret name | Required | Value |
|---|---|---|
| `TWITCH_CLIENT_ID` | Yes | Client ID of your **Confidential** Twitch app (used by the scraper) |
| `TWITCH_CLIENT_SECRET` | Yes | Client Secret of your **Confidential** Twitch app |
| `TWITCH_WEB_CLIENT_ID` | No | Client ID of a separate **Public** Twitch app (enables "Login with Twitch" in the viewer) |

If you haven't created Twitch applications yet, see [Setting up Twitch applications](../README.md#1-create-twitch-applications) in the main README.

> **Live clips feature:** To enable the "Login with Twitch" button, add `TWITCH_WEB_CLIENT_ID` (a *Public* app — separate from the scraper's Confidential app). Register your GitHub Pages URL **without a trailing slash** (e.g. `https://you.github.io/my-clips`) as an OAuth Redirect URL in that app's settings. If the secret is omitted, the button is simply hidden.

---

## Step 3 — Enable GitHub Pages

In your archive repo, go to **Settings → Pages**:

- **Source**: select **GitHub Actions**

That's all. GitHub will create a `github-pages` deployment environment automatically on the first successful workflow run.

---

## Step 4 — Create the workflow file

Create `.github/workflows/deploy.yml` in your archive repo with the following content, replacing `YOUR_GITHUB_USERNAME` and the streamer logins:

```yaml
name: Deploy clip archive

on:
  schedule:
    - cron: '0 6 * * *'   # every day at 06:00 UTC
  workflow_dispatch:
    inputs:
      mode:
        description: 'Scraping mode'
        required: false
        type: choice
        options: [fetch, update, skip]
        default: fetch

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  deploy:
    uses: oatmeal/twist-clear/.github/workflows/deploy.yml@master
    with:
      streamers: "streamer1,streamer2"
      scrape_mode: ${{ github.event.inputs.mode || 'fetch' }}
    secrets:
      TWITCH_CLIENT_ID: ${{ secrets.TWITCH_CLIENT_ID }}
      TWITCH_CLIENT_SECRET: ${{ secrets.TWITCH_CLIENT_SECRET }}
      TWITCH_WEB_CLIENT_ID: ${{ secrets.TWITCH_WEB_CLIENT_ID }}  # optional, enables Login with Twitch
```

Commit and push this file.

---

## Step 5 — Trigger the first deployment

The scheduled workflow won't run until GitHub activates the schedule (which can take up to 24 hours after the first commit). To deploy immediately:

1. Go to your archive repo's **Actions** tab.
2. Select the **Deploy clip archive** workflow.
3. Click **Run workflow**.

The first run performs a full historical scrape, which can take up to ~30 minutes depending on how many clips the channels have. The database is cached between runs, so subsequent runs using `scrape_mode: update` are much faster (incremental only). With the default `scrape_mode: fetch` (one full rescan per day), each run takes roughly the same amount of time but keeps view counts current.

Once complete, your clip archive will be live at:
```
https://YOUR_GITHUB_USERNAME.github.io/my-clips/
```

---

## Keeping view counts current

With the default `scrape_mode: fetch`, each run does a full historical rescan via `scrape.py fetch --force`, re-fetching all clip metadata including current view counts. View counts are fully refreshed on every deployment. No extra configuration is needed.

If the scrape is ever interrupted mid-run, the next run picks up where it left off (the progress checkpoint is written to the database after each time window).

---

## Customisation

### Refresh on a different schedule

Edit the `cron` expression in your archive repo's workflow. Some examples:

```yaml
- cron: '0 6 * * *'     # daily at 06:00 UTC (default)
- cron: '0 6 * * 1'     # weekly on Mondays
- cron: '0 0,12 * * *'  # twice a day
```

### Pin to a specific version of the scraper

Change `@master` to a tag or commit SHA:

```yaml
uses: oatmeal/twist-clear/.github/workflows/deploy.yml@v1.2.3
```

### Frequent intra-day updates with a daily full rescan

For an archive that updates throughout the day while still refreshing view counts once daily, use two schedules and pass `scrape_mode` based on which cron fired:

```yaml
name: Deploy clip archive

on:
  schedule:
    - cron: '0 * * * *'   # every hour — fast incremental update
    - cron: '0 6 * * *'   # daily at 06:00 UTC — full rescan, refresh view counts
  workflow_dispatch:
    inputs:
      mode:
        description: 'Scraping mode'
        required: false
        type: choice
        options: [fetch, update, skip]
        default: fetch

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  deploy:
    uses: oatmeal/twist-clear/.github/workflows/deploy.yml@master
    with:
      streamers: "streamer1,streamer2"
      scrape_mode: ${{ github.event.schedule == '0 6 * * *' && 'fetch' || github.event.inputs.mode || 'update' }}
    secrets:
      TWITCH_CLIENT_ID: ${{ secrets.TWITCH_CLIENT_ID }}
      TWITCH_CLIENT_SECRET: ${{ secrets.TWITCH_CLIENT_SECRET }}
      TWITCH_WEB_CLIENT_ID: ${{ secrets.TWITCH_WEB_CLIENT_ID }}
```

The expression resolves to:

| Trigger | `scrape_mode` | Behaviour |
|---|---|---|
| Daily schedule (`0 6 * * *`) | `fetch` | Full rescan, view counts refreshed |
| Hourly schedule (any other cron) | `update` | Incremental, ~seconds |
| Manual dispatch | whichever option you selected | — |

To redeploy after a styling change without waiting for the scraper, trigger a manual run and select **skip**.

### Using a fork or copy of the code under a different account

If your copy of `twist-clear` is under a different account than `oatmeal`, pass the `code_repo` input:

```yaml
with:
  streamers: "streamer1"
  code_repo: "your-username/twist-clear"
```

---

## Inputs reference

> **This section is the canonical reference for all `deploy.yml` workflow
> inputs.** Keep it in sync with `deploy.yml` whenever inputs are added,
> removed, or changed — including their defaults and descriptions.

### Scraper

| Input | Required | Default | Description |
|---|---|---|---|
| `streamers` | Yes | — | Comma-separated Twitch channel logins |
| `scrape_mode` | No | `fetch` | `fetch` — full rescan via `scrape.py fetch --force`, refreshes all view counts; `update` — restore cached DB then run `scrape.py update` (incremental, only new clips; falls back to full fetch if no cache exists); `skip` — restore cached DB and skip scraping (fails if no cache) |
| `scraper_ref` | No | `master` | Branch, tag, or SHA of `twist-clear` to use |
| `code_repo` | No | `oatmeal/twist-clear` | Override if using a fork or copy under a different account |

### Branding / metadata

| Input | Required | Default | Description |
|---|---|---|---|
| `site_title` | No | `twist-clear clip archive` | Title prefix shown in the browser tab and page heading (streamer names are appended automatically at runtime) |
| `site_description` | No | *(empty)* | Optional subtitle shown below the site title in the page header. Visible on desktop; collapsible via a chevron button on narrow screens. Leave empty for no subtitle. |
| `og_description` | No | `A Twitch clip archive.` | Text for the `og:description` meta tag used in social link previews |
| `site_url` | No | *(auto-computed)* | Canonical URL for the `og:url` meta tag (e.g. `https://user.github.io/my-clips/`). Auto-computed from the calling repo if omitted |

### Colours

All colour inputs accept any valid CSS colour value (`#rrggbb`, `hsl()`, `oklch()`, etc.). Omitting an input keeps the default dark-theme value. See [docs/theming.md](theming.md) for guidance and example palettes.

| Input | Required | Default | Description |
|---|---|---|---|
| `accent_color` | No | `#9147ff` | Accent colour for interactive highlights, buttons, and the calendar heat-map |
| `color_bg` | No | `#0e0e0e` | Page background colour |
| `color_surface` | No | `#1f1f23` | Card and header background colour |
| `color_surface2` | No | `#26262c` | Secondary surfaces: dropdowns, nav buttons |
| `color_border` | No | `#3a3a40` | Border and divider colour |
| `color_text` | No | `#efeff1` | Primary text colour |
| `color_muted` | No | `#adadb8` | Secondary text and labels colour |
| `cal_accent_color` | No | `#22a84a` | Calendar heat-map colour, kept separate from `accent_color` so the density ramp reads as data rather than interactive UI |

---

## Troubleshooting

**The workflow fails with "No streamers configured"**
Check that the `streamers` input in your workflow file contains at least one login.

**The workflow fails at "Deploy to GitHub Pages"**
Make sure GitHub Pages is enabled with **GitHub Actions** as the source in your archive repo's settings. Also check that the `github-pages` environment exists (it's created automatically, but only after the first Pages deployment attempt).

**The deployed site loads but shows no clips**
The scrape completed but found no clips. Verify the streamer logins are correct (Twitch login names are lowercase). Check the workflow logs for any API errors.

**The workflow fails at "Verify database available"**
You used `scrape_mode: skip` but no cached database exists yet. Run the workflow once without `skip` (e.g. `fetch` or `update`) to populate the cache, then switch back to `skip`.

**`prepare_web_db.py` fails with "SQLite too old"**
The FTS5 trigram tokenizer requires SQLite ≥ 3.38. The reusable workflow pins to `ubuntu-24.04` (SQLite 3.45+) to avoid this. If you're running the preparation script locally, make sure your system SQLite is ≥ 3.38 (`sqlite3 --version`).
