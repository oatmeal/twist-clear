import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  server: {
    port: 5173,
    host: '127.0.0.1',
    fs: {
      // Allow resolving symlinks that point outside the package root (e.g. public/clips.db)
      allow: ['..'],
    },
  },
  optimizeDeps: {
    // sql.js-httpvfs ships pre-bundled; exclude from Vite's dep optimizer
    exclude: ['sql.js-httpvfs'],
  },
  assetsInclude: ['**/*.wasm'],
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
