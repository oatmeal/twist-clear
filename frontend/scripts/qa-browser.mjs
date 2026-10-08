/**
 * Headless-browser helpers for ad-hoc visual QA scripts (screenshots, layout
 * measurements) run by AI sessions — see "Headless browser for visual QA" in
 * the root CLAUDE.md.
 *
 * Import it by absolute path from a script anywhere (e.g. a session
 * scratchpad); `playwright-core` then resolves from frontend/node_modules:
 *
 *   import { launchBrowser, stubClipEmbeds, gotoApp } from '/abs/path/frontend/scripts/qa-browser.mjs';
 *
 * Plain .mjs rather than .ts so `node script.mjs` runs it with no loader.
 */

import { chromium } from 'playwright-core';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Path to the newest Playwright "chromium headless shell" in the local
 * browser cache, or null if none is installed.
 */
export function findHeadlessShell() {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ??
    join(homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
  if (!existsSync(cache)) return null;
  const revisions = readdirSync(cache)
    .filter(d => d.startsWith('chromium_headless_shell-'))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const rev of revisions) {
    for (const sub of readdirSync(join(cache, rev))) {
      const bin = join(cache, rev, sub, 'chrome-headless-shell');
      if (sub.startsWith('chrome-headless-shell-') && existsSync(bin)) return bin;
    }
  }
  return null;
}

/**
 * Launch a headless Chromium. Prefers the Playwright headless shell, which
 * runs inside Claude Code's Bash sandbox; system Chrome (`channel: 'chrome'`,
 * as used by screenshot-og.ts) is the fallback, but on macOS the sandbox
 * blocks it from loading its framework, so it only works outside it.
 */
export function launchBrowser(options = {}) {
  const executablePath = findHeadlessShell();
  return executablePath
    ? chromium.launch({ executablePath, ...options })
    : chromium.launch({ channel: 'chrome', ...options });
}

/**
 * Serve a stub page for every Twitch clip embed iframe: the run stays offline
 * and deterministic, and the stub shows the clip slug so screenshots say which
 * clip is open. Returns a live counter of embed loads — assert it is unchanged
 * to prove an action didn't reload (restart) the player.
 */
export async function stubClipEmbeds(page) {
  const counter = { loads: 0 };
  await page.route('https://clips.twitch.tv/**', route => {
    counter.loads++;
    const slug = new URL(route.request().url()).searchParams.get('clip') ?? '';
    return route.fulfill({
      contentType: 'text/html',
      body: '<body style="margin:0;height:100vh;display:grid;place-items:center;' +
        'background:#223;color:#ccd;font:14px sans-serif">stub player: ' +
        slug.replace(/[<&]/g, '') + '</body>',
    });
  });
  return counter;
}

/** Open the app and wait until the first page of clips has rendered. */
export async function gotoApp(page, url = 'http://localhost:5173/') {
  await page.goto(url);
  await page.waitForSelector('#clips-grid .clip-card, #clips-grid .clip-row', { timeout: 30_000 });
}
