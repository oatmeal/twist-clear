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
  workflow_dispatch:        # allow manual runs from the Actions tab

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

Commit and push this file.

---

## Step 5 — Trigger the first deployment

The scheduled workflow won't run until GitHub activates the schedule (which can take up to 24 hours after the first commit). To deploy immediately:

1. Go to your archive repo's **Actions** tab.
2. Select the **Deploy clip archive** workflow.
3. Click **Run workflow**.

The first run performs a full historical scrape, which can take up to ~30 minutes depending on how many clips the channels have. Subsequent daily runs are the same — each run rebuilds from a blank database — but the full scrape time is acceptable for a daily job.

Once complete, your clip archive will be live at:
```
https://YOUR_GITHUB_USERNAME.github.io/my-clips/
```

---

## Keeping view counts current

Each daily run starts from a blank database and runs `scrape.py fetch`, which re-fetches all clip metadata including current view counts. So view counts are always fully refreshed on every deployment. No extra configuration is needed.

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

### Using a fork or copy of the code under a different account

If your copy of `twist-clear` is under a different account than `oatmeal`, pass the `code_repo` input:

```yaml
with:
  streamers: "streamer1"
  code_repo: "your-username/twist-clear"
```

---

## Inputs reference

| Input | Required | Default | Description |
|---|---|---|---|
| `streamers` | Yes | — | Comma-separated Twitch channel logins |
| `force` | No | `false` | Reset fetch state before scraping (re-scans full history; rarely needed since daily runs already rebuild from scratch) |
| `scraper_ref` | No | `master` | Branch, tag, or SHA of `twist-clear` to use |
| `code_repo` | No | `oatmeal/twist-clear` | Override if using a fork or copy under a different account |

---

## Troubleshooting

**The workflow fails with "No streamers configured"**
Check that the `streamers` input in your workflow file contains at least one login.

**The workflow fails at "Deploy to GitHub Pages"**
Make sure GitHub Pages is enabled with **GitHub Actions** as the source in your archive repo's settings. Also check that the `github-pages` environment exists (it's created automatically, but only after the first Pages deployment attempt).

**The deployed site loads but shows no clips**
The scrape completed but found no clips. Verify the streamer logins are correct (Twitch login names are lowercase). Check the workflow logs for any API errors.

**`prepare_web_db.py` fails with "SQLite too old"**
The FTS5 trigram tokenizer requires SQLite ≥ 3.38. The reusable workflow pins to `ubuntu-24.04` (SQLite 3.45+) to avoid this. If you're running the preparation script locally, make sure your system SQLite is ≥ 3.38 (`sqlite3 --version`).
