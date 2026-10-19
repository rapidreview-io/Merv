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
// Excalidraw's bundled fonts are split by Unicode range. Embed their installed subsets so
// restoreElements measures text using the same font as the editor, with no CDN access.
const { readFileSync, readdirSync, writeFileSync } = await import('node:fs');
const { join, dirname } = await import('node:path');
const { createRequire } = await import('node:module');
const fontRoot = dirname(createRequire(import.meta.url).resolve('@excalidraw/excalidraw'));
const chunk = readdirSync(fontRoot)
  .filter((x) => x.endsWith('.js'))
  .map((x) => readFileSync(join(fontRoot, x), 'utf8'))
  .find((x) => x.includes('Excalifont-Regular-'));
const families = {
  Cascadia: 'Cascadia',
  ComicShanns: 'Comic Shanns',
  Excalifont: 'Excalifont',
  Liberation: 'Liberation Sans',
  Lilita: 'Lilita One',
  Nunito: 'Nunito',
  Virgil: 'Virgil',
  Xiaolai: 'Xiaolai',
};
const definitions = [...chunk.matchAll(/var (\w+)="\.\/fonts\/([^/]+)\/([^"]+)"/g)];
const fonts = definitions.map(([, variable, directory, file]) => {
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = chunk.match(
    new RegExp('uri:' + escaped + ',descriptors:\\{unicodeRange:("[^\"]+"|[\\w.]+)'),
  );
  let range = match?.[1];
  if (range?.startsWith('"')) range = JSON.parse(range);
  else if (range) {
    const key = range.split('.').at(-1);
    range = chunk.match(new RegExp(key + ':"([^\"]+)"'))?.[1];
    if (!range) throw Error('Unknown font range ' + key);
  }
  return {
    family: families[directory],
    data: readFileSync(join(fontRoot, 'fonts', directory, file)).toString('base64'),
    range,
  };
});
if (fonts.filter((f) => f.family === 'Excalifont').length !== 7 || fonts.some((f) => !f.family))
  throw Error('Excalidraw font manifest changed');
writeFileSync(new URL('../packages/board/dist/fonts.json', import.meta.url), JSON.stringify(fonts));
