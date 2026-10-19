// Excalidraw's bundled fonts are split by Unicode range. Embed their installed subsets so
// restoreElements measures text using the same font as the editor, with no CDN access.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
export function boardFontManifest() {
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
      path: join(fontRoot, 'fonts', directory, file),
      url: `/ui/assets/excalidraw/fonts/${directory}/${file}`,
      range,
    };
  });
  if (fonts.filter((f) => f.family === 'Excalifont').length !== 7 || fonts.some((f) => !f.family))
    throw Error('Excalidraw font manifest changed');
  return fonts;
}
