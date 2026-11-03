import { defineConfig, mergeConfig } from 'vite';
import { resolve } from 'node:path';
import base, { excalidrawFonts } from './vite.config';

// The board app: a page of its own built beside Merv's (web/board-app), reusing the board's views.
// @merv/ui serves it with `bundle: 'board'`, as it serves dist/ for Merv.
const outDir = resolve(import.meta.dirname, 'dist-board');
export default defineConfig(() =>
  mergeConfig(
    {
      ...base,
      plugins: (base.plugins ?? []).filter(
        (plugin) => !plugin || !('name' in plugin) || plugin.name !== 'excalidraw-fonts',
      ),
      build: { ...base.build, rollupOptions: undefined },
    },
    {
      root: 'web/board-app',
      cacheDir: resolve(import.meta.dirname, 'node_modules/.vite-board'),
      plugins: [excalidrawFonts(outDir)],
      build: { outDir, emptyOutDir: true },
      server: { port: Number(process.env.PORT) || 5190 },
    },
  ),
);
