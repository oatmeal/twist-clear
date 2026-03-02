import { defineConfig } from 'vitest/config';

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
  plugins: [
    {
      name: 'accept-ranges',
      configureServer(server) {
        // Vite's dev server (sirv) omits Accept-Ranges by default.
        // sql.js-httpvfs requires it to issue Range requests instead of
        // downloading the full DB file.
        server.middlewares.use((_req, res, next) => {
          res.setHeader('Accept-Ranges', 'bytes');
          next();
        });
      },
    },
  ],
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
