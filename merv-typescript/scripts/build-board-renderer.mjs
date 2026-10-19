// Build the exact Excalidraw export path used by the board, for the offline headless renderer.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
await build({
  entryPoints: [fileURLToPath(new URL('../packages/board/render/client.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../packages/board/dist/renderer.js', import.meta.url)),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.woff2': 'dataurl', '.ttf': 'dataurl', '.css': 'empty' },
  logLevel: 'warning',
});
import { boardFontManifest } from './board-font-manifest.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
const fonts = boardFontManifest().map(({ family, path, range }) => ({
  family,
  range,
  data: readFileSync(path).toString('base64'),
}));
writeFileSync(new URL('../packages/board/dist/fonts.json', import.meta.url), JSON.stringify(fonts));
