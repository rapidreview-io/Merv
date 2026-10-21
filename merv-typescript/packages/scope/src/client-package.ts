import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { clientBundle } from './client-bundle.js';
const production = 'https://experiments.rapidreview.io';
export const packageName = (origin: string) =>
  origin === production
    ? 'merv'
    : `merv-${createHash('sha256').update(origin).digest('hex').slice(0, 8)}`;
export function packageFiles(origin: string): Record<string, string> {
  const name = packageName(origin);
  return Object.fromEntries(
    Object.entries(clientBundle).map(([path, text]) => [
      path,
      text
        .replaceAll(production, origin)
        .replaceAll('"name": "merv"', `"name": "${name}"`)
        .replaceAll('"merv": {', `"${name}": {`),
    ]),
  );
}
/** Small deterministic ustar archive of trusted package files; no executables or symlinks. */
export function packageArchive(origin: string): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(packageFiles(origin))) {
    if (name.length > 100 || name.includes('..') || name.startsWith('/'))
      throw new Error('Invalid bundled path');
    const body = Buffer.from(text),
      header = Buffer.alloc(512);
    header.write(name);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write('ustar\0', 257);
    header.write('00', 263);
    header.write(
      header
        .reduce((a, b) => a + b, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
      148,
    );
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
