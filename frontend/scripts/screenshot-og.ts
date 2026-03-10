/**
 * Takes a 1200×630 screenshot of the built site for use as og:image.
 *
 * Must be run after `npm run build` — reads compiled files from frontend/dist/.
 * Starts `vite preview` (which handles DB range requests via dbRangePlugin) as
 * the local HTTP server, then launches system Chrome via playwright-core to
 * capture the page once the clip grid has finished loading.
 *
 * Output: frontend/dist/og-image.png
 *
 * Uses `channel: 'chrome'` so no Playwright browser download is needed — the
 * system-installed Chrome is used on both macOS (local) and the ubuntu-24.04
 * GitHub Actions runner (where Chrome is pre-installed).
 */

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const frontendDir = join(__dirname, '..');
const outPath = join(frontendDir, 'dist', 'og-image.png');

// Use a port distinct from the default (4173) to avoid colliding with a preview
// server the developer might already have running.
const PORT = 4174;
const BASE_URL = `http://localhost:${PORT}`;

async function pollUntilReady(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(1000) });
      return;
    } catch {
      await new Promise(r => setTimeout(r, 300));
    }
  }
  throw new Error(`Server at ${url} did not respond within ${timeoutMs}ms`);
}

// Spawn vite preview directly (not via `npm run preview`) so SIGTERM propagates
// cleanly to the vite process on both macOS and Linux.
const viteBin = join(frontendDir, 'node_modules', '.bin', 'vite');
const server = spawn(viteBin, ['preview'], {
  cwd: frontendDir,
  stdio: 'inherit',
  env: { ...process.env, PREVIEW_PORT: String(PORT) },
});

server.on('error', err => {
  console.error('Failed to start vite preview:', err);
  process.exit(1);
});

let exitCode = 0;
try {
  await pollUntilReady(BASE_URL);

  const browser = await chromium.launch({
    channel: 'chrome',
    // Standard CI flags: --no-sandbox avoids namespace/seccomp issues in
    // container environments; --disable-dev-shm-usage routes shared memory
    // through /tmp instead of /dev/shm (harmless on macOS).
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });

    // Set language to Japanese before the page scripts run. app.ts reads
    // localStorage.getItem('tc_lang') at startup with higher priority than
    // detectLang(), so this ensures the first render is already in Japanese.
    await page.addInitScript(() => localStorage.setItem('tc_lang', 'ja'));

    await page.goto(`${BASE_URL}${import.meta.env.BASE_URL}`, { waitUntil: 'load' });

    // Wait for the DB to initialise — app.ts hides #loading once the first
    // query completes, whether or not there are any clips in the result set.
    await page.waitForSelector('#loading', { state: 'hidden', timeout: 30_000 });

    // Wait for thumbnail images to finish loading. Clip thumbnails are
    // loading="lazy" and fetched from Twitch's CDN, so they start arriving
    // after the clip cards are rendered. networkidle fires once there have
    // been no in-flight requests for 500 ms, which is the right signal.
    await page.waitForLoadState('networkidle', { timeout: 30_000 });

    await page.screenshot({ path: outPath });
    console.log(`og:image written to ${outPath}`);
  } finally {
    await browser.close();
  }
} catch (err) {
  console.error('Screenshot failed:', err);
  exitCode = 1;
} finally {
  server.kill();
}

process.exit(exitCode);
