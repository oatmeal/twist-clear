import { defineConfig } from 'vitest/config';
import { createReadStream, realpathSync, statSync, accessSync, constants, readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Vite plugin that properly handles HTTP Range requests for .db files.
 *
 * Vite's built-in static file server (sirv) ignores Range request headers and
 * always returns a full 200 response. sql.js-httpvfs requires actual 206 Partial
 * Content responses to fetch only the B-tree pages it needs; without this, it
 * falls back to downloading the entire database on every query.
 *
 * Applies to both the dev server (publicDir) and the preview server (outDir).
 */
function dbRangePlugin(): Plugin {
  let publicDir: string;
  let outDir: string;

  function makeMiddleware(dir: string) {
    return (req: { url?: string; headers: Record<string, string | string[] | undefined> }, res: import('node:http').ServerResponse, next: () => void) => {
      const urlPath = (req.url ?? '').split('?')[0];
      if (!urlPath.endsWith('.db')) return next();

      const absPath = join(dir, urlPath);
      let realPath: string;
      let size: number;
      try {
        realPath = realpathSync(absPath);
        accessSync(realPath, constants.R_OK);
        size = statSync(realPath).size;
      } catch {
        return next();
      }

      const range = req.headers['range'];
      res.setHeader('Accept-Ranges', 'bytes');

      if (!range) {
        res.writeHead(200, { 'Content-Length': size, 'Content-Type': 'application/octet-stream' });
        createReadStream(realPath).pipe(res);
        return;
      }

      const m = /bytes=(\d+)-(\d*)/.exec(range as string);
      if (!m) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }

      const start = parseInt(m[1]!, 10);
      const end = m[2] ? parseInt(m[2], 10) : size - 1;

      if (start > end || end >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': 'application/octet-stream',
      });
      createReadStream(realPath, { start, end }).pipe(res);
    };
  }

  return {
    name: 'db-range-requests',
    configResolved(config) {
      publicDir = config.publicDir;
      outDir = isAbsolute(config.build.outDir)
        ? config.build.outDir
        : join(config.root, config.build.outDir);
    },
    configureServer(server) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      server.middlewares.use(makeMiddleware(publicDir) as any);
    },
    configurePreviewServer(server) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      server.middlewares.use(makeMiddleware(outDir) as any);
    },
  };
}

// Inject VITE_ vars from config.toml for local dev so users don't need a
// separate .env.local file. In CI, env vars are set explicitly by the workflow
// and process.env checks below will short-circuit before touching toml content.
// Attempting to read a non-existent config.toml (e.g. in CI) is caught silently.
{
  let toml = '';
  try { toml = readFileSync('../config.toml', 'utf-8'); } catch { /* absent in CI */ }

  // web_client_id — Public Twitch app for browser OAuth (implicit grant).
  // Must be a separate app from the scraper's Confidential client_id.
  if (!process.env['VITE_TWITCH_CLIENT_ID']) {
    const m = /web_client_id\s*=\s*"([^"]+)"/.exec(toml);
    if (m?.[1]) process.env['VITE_TWITCH_CLIENT_ID'] = m[1];
  }

  // site_title — archive name shown in the browser tab and page heading.
  // Streamer names are appended at runtime by JS.
  if (!process.env['VITE_SITE_TITLE']) {
    const m = /site_title\s*=\s*"([^"]+)"/.exec(toml);
    process.env['VITE_SITE_TITLE'] = m?.[1] ?? 'twist-clear clip archive';
  }

  // og_description — text for the og:description meta tag.
  if (!process.env['VITE_OG_DESCRIPTION']) {
    const m = /og_description\s*=\s*"([^"]+)"/.exec(toml);
    process.env['VITE_OG_DESCRIPTION'] = m?.[1] ?? 'A Twitch clip archive.';
  }

  // site_url — canonical URL for og:url. Empty in local dev; CI auto-computes it.
  if (!process.env['VITE_SITE_URL']) {
    const m = /site_url\s*=\s*"([^"]+)"/.exec(toml);
    process.env['VITE_SITE_URL'] = m?.[1] ?? '';
  }

  // Optional CSS colour overrides — no defaults; style.css :root values apply
  // when absent. Maps VITE env var name → config.toml key → CSS custom property.
  // See docs/theming.md for guidance and example palettes.
  const cssVarMap: Array<[string, string]> = [
    ['VITE_COLOR_ACCENT',     'accent_color'],
    ['VITE_COLOR_BG',         'color_bg'],
    ['VITE_COLOR_SURFACE',    'color_surface'],
    ['VITE_COLOR_SURFACE2',   'color_surface2'],
    ['VITE_COLOR_BORDER',     'color_border'],
    ['VITE_COLOR_TEXT',       'color_text'],
    ['VITE_COLOR_MUTED',      'color_muted'],
    ['VITE_COLOR_CAL_ACCENT', 'cal_accent_color'],
  ];
  for (const [envVar, tomlKey] of cssVarMap) {
    if (!process.env[envVar]) {
      const m = new RegExp(`${tomlKey}\\s*=\\s*"([^"]+)"`).exec(toml);
      if (m?.[1]) process.env[envVar] = m[1];
    }
  }
}

export default defineConfig({
  root: '.',
  publicDir: 'public',
  server: {
    port: parseInt(process.env['PORT'] ?? '5173', 10),
    host: 'localhost',
    fs: {
      // Allow resolving symlinks that point outside the package root (e.g. public/clips.db)
      allow: ['..'],
    },
  },
  preview: {
    // Explicit port so `vite preview` is always on 4173 regardless of whether
    // Vite inherits server.port (behaviour varies across Vite versions).
    port: parseInt(process.env['PREVIEW_PORT'] ?? '4173', 10),
    host: 'localhost',
  },
  plugins: [dbRangePlugin()],
  optimizeDeps: {
    // The worker and WASM are imported with ?url so they bypass the optimizer.
    // The main package entry (index.js) is CJS and must be pre-bundled so Vite
    // can expose its named exports as ESM.
    exclude: ['sql.js-httpvfs/dist/sqlite.worker.js', 'sql.js-httpvfs/dist/sql-wasm.wasm'],
  },
  assetsInclude: ['**/*.wasm'],
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
