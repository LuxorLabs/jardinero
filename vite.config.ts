import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The operator dashboard SPA. Sources live in `web/`; the build emits static
// assets into `dist/public/` which the Node server serves under `/dashboard/`.
const rootDir = import.meta.dirname;

export default defineConfig({
  root: resolve(rootDir, 'web'),
  base: '/dashboard/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(rootDir, 'web/src'),
      '@shared': resolve(rootDir, 'src/transport/dashboard/dashboard-api-types.ts'),
    },
  },
  // Benchmark/prod target is headless Chromium (evergreen); es2022 lets esbuild
  // skip legacy-syntax downleveling (class fields, spread helpers, etc.) that
  // Vite's conservative default target still emits.
  esbuild: {
    legalComments: 'none',
    drop: ['console', 'debugger'],
  },
  build: {
    target: 'es2022',
    outDir: resolve(rootDir, 'dist/public'),
    emptyOutDir: true,
    manifest: true,
    rollupOptions: {
      input: resolve(rootDir, 'web/index.html'),
    },
  },
  server: {
    proxy: {
      '/dashboard/api': 'http://localhost:3000',
    },
  },
});
