# CLAUDE.md — project guide for AI assistants

## Keeping documentation up to date

Update these files in the same commit as the change that makes them stale —
don't wait to be asked:

- **`CLAUDE.md`** and **`frontend/CLAUDE.md`** — update when source files are
  added/removed, architectural patterns change, or design decisions are made.
- **`docs/future-work.md`** — add new deferred items with rationale; remove or
  mark items that get implemented.
- **`README.md`** — update when user-facing behaviour, setup steps, or
  deployment instructions change.
- **`docs/deploying.md`** — update when the deployment workflow or GitHub Pages
  setup changes. The **Inputs reference** section is the canonical list of all
  `deploy.yml` inputs (names, defaults, descriptions) — keep it in sync with
  the workflow file whenever inputs are added, removed, or changed.

---

## What this repo is

Two components of roughly equal importance in one repository:

1. **Python scraper** (`scrape.py`, `lib/`) — fetches Twitch clip metadata via the Helix API using adaptive time-windowing and stores it in a local SQLite database.
2. **Browser viewer** (`frontend/`) — a TypeScript + Vite SPA that queries the database directly in the browser using [sql.js-httpvfs](https://github.com/phiresky/sql.js-httpvfs) (HTTP Range requests; only the B-tree pages needed for each query are fetched). See `frontend/CLAUDE.md` for details.

## Repository layout

```
scrape.py               # CLI entry point (fetch / update / enrich-names subcommands)
prepare_web_db.py       # Build a browser-ready copy of clips.db
config.toml.example     # Template — copy to config.toml and fill in credentials
lib/
  api.py                # Twitch Helix API client
  db.py                 # SQLite schema + upsert helpers
  igdb.py               # IGDB API client — maps Twitch game IDs → Japanese names;
                        #   falls back to Twitch web pages for non-game categories
tests/                  # pytest tests for the scraper
docs/
  deploying.md          # Full GitHub Pages deployment walkthrough
  future-work.md        # Deferred features and known quirks with rationale
  theming.md            # Accent colour + full palette customisation guide
frontend/               # TypeScript + Vite SPA (see frontend/CLAUDE.md)
```

`config.toml` (gitignored) holds Twitch API credentials and is read by both
the scraper and the Vite dev server (as a fallback for `VITE_TWITCH_CLIENT_ID`).

## Default branch

The default branch is **`master`**. Claude Code's session header may show
"Main branch: main" — this is a generic label injected by the tool, not the
actual branch name. Always target `master` for merges and PRs.

## Worktree setup (do this once per new worktree)

Git worktrees are created under `.claude/worktrees/<name>/`. They share the
main repo's git history but have an independent working tree. A few things
need to be wired up before the frontend dev server works:

### 1. Install frontend dependencies

```sh
cd frontend && npm install
```

### 2. Create `.claude/launch.json`

The Claude Preview tool looks for this file relative to the worktree root.
Create `.claude/launch.json`:

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "frontend-dev",
      "runtimeExecutable": "npm",
      "runtimeArgs": ["--prefix", "frontend", "run", "dev"],
      "port": 5173
    }
  ]
}
```

### 3. Symlink the database

The Vite dev server serves `frontend/public/clips.db`. The worktree's
`frontend/public/` directory does not exist by default — create it and
symlink the prepared DB from the main repo:

```sh
mkdir -p frontend/public
ln -s /absolute/path/to/main-repo/frontend/public/clips.db frontend/public/clips.db
```

Or, using a relative path (works if worktree is 3 levels below the main repo,
e.g. `.claude/worktrees/<name>/`):

```sh
mkdir -p frontend/public
ln -s ../../../../../frontend/public/clips.db frontend/public/clips.db
```

> **Note:** If `frontend/public/clips.db` does not exist in the main repo yet,
> run `npm run prepare-db` in the main repo's `frontend/` directory first.

### 4. Symlink config.toml

`vite.config.ts` reads `../config.toml` (relative to `frontend/`) as a
fallback source for `VITE_TWITCH_CLIENT_ID`. In a worktree that path resolves
to the worktree root, not the main repo, so the login banner and live-clip
features will be silently disabled unless you symlink it:

```sh
ln -s ../../../config.toml config.toml
```

(Three levels up: worktree-name → worktrees → .claude → main repo root.)

After these steps, `npm run dev` (via the Claude Preview tool or directly)
will serve the site on port 5173 with the full database and auth UI enabled.

## Known shell environment quirks

### nvm — npm/node not on PATH

The Bash tool does not source `~/.zshrc` or `~/.bash_profile`, so nvm's PATH
injection never runs. `npm`, `npx`, and `node` are **not** available as bare
commands. Prepend the nvm bin directory to PATH at the start of each Bash call:

```sh
PATH="$(echo ~/.nvm/versions/node/*/bin | tr ' ' '\n' | sort -V | tail -1):$PATH"
npm --prefix frontend test
```

Or for `npx`-style tool invocations, use the locally-installed binary directly:

```sh
# run from frontend/
node node_modules/.bin/tsc --noEmit
node node_modules/.bin/vitest run
```

### pyenv rehash lock errors

Bash tool invocations may print a line like:

```
pyenv: cannot rehash: couldn't acquire lock /Users/…/.pyenv/shims/.pyenv-shim
```

This is a **cosmetic warning** from a stale pyenv lock file — it does not affect
command output or exit codes. The permanent fix (run once in a terminal):

```sh
rm -f ~/.pyenv/shims/.pyenv-shim
```

When you see this warning in tool output, ignore it and look at the rest of the
output for actual results or errors.

## Development commands

### Python scraper

```sh
uv run python scrape.py fetch                   # full historical scrape (resume from checkpoint)
uv run python scrape.py fetch --force           # reset checkpoints, rescan everything
uv run python scrape.py update                  # incremental update
uv run python scrape.py enrich-names            # backfill Japanese game names via IGDB + Twitch web (skip existing)
uv run python scrape.py enrich-names --force    # re-fetch all, including already-enriched

uv run pytest                    # tests
uv run ruff check .              # lint
uv run ruff format .             # format
```

### Frontend

> **Bash tool note**: `npm`/`npx` are not on PATH (see nvm quirk above).
> Prepend the nvm bin dir or use `node node_modules/.bin/<tool>` directly.
> Examples below use bare `npm` for readability.

```sh
cd frontend
npm install
npm run dev          # Vite dev server → http://localhost:5173
npm test             # Vitest unit tests
npm run test:watch   # Vitest in watch mode
node node_modules/.bin/tsc --noEmit   # type-check (npx not on PATH in Bash tool)

# Build a browser-ready DB (DELETE journal mode, FTS5 index, precomputed
# metadata tables, covering indexes, VACUUM):
npm run prepare-db   # → writes frontend/public/clips.db

npm run build        # production Vite build → frontend/dist/
                     # requires frontend/public/clips.db (run prepare-db first)
npm run screenshot-og  # take 1200×630 og:image screenshot → frontend/dist/og-image.png
                       # requires a build (run build first); uses system Chrome
```
