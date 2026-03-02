import { defineConfig } from 'vitest/config';
import { createReadStream, realpathSync, statSync, accessSync, constants } from 'node:fs';
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

export default defineConfig({
  root: '.',
  publicDir: 'public',
  server: {
    port: parseInt(process.env['PORT'] ?? '5173', 10),
    host: '127.0.0.1',
    fs: {
      // Allow resolving symlinks that point outside the package root (e.g. public/clips.db)
      allow: ['..'],
    },
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
