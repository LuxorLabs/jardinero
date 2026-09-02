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
  // Benchmark/prod is headless Chromium, so this only has to clear es2022.
  // Vite 8's default (baseline-widely-available) is already higher and builds
  // identical code; the pin is a floor, not an optimization.
  build: {
    target: 'es2022',
    outDir: resolve(rootDir, 'dist/public'),
    emptyOutDir: true,
    manifest: true,
    rollupOptions: {
      input: resolve(rootDir, 'web/index.html'),
      output: {
        // web/ is outside biome's files.includes, so nothing lints a stray
        // console.log or debugger out of the dashboard. This is the only thing
        // keeping them out of the operator's browser. Vite 8 transforms with
        // oxc, which ignores the old esbuild `drop`; the equivalent lives here.
        minify: { compress: { dropConsole: true, dropDebugger: true } },
      },
    },
  },
  server: {
    proxy: {
      '/dashboard/api': 'http://localhost:3000',
    },
  },
});
