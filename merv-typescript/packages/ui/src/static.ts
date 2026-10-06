import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import type { MountHandler } from '@merv/api/types';

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
/** Text shrinks to a fraction gzipped; images and fonts are compressed already. */
const compressible = /^(text\/|application\/json|image\/svg)/;
const packed = promisify(gzip);

/** Serves a built browser bundle under /ui; routes without an extension fall back to index.html. */
export function serveBundle(root: string): MountHandler {
  const base = resolve(root);
  /** A hashed asset never changes, so it is gzipped once. */
  const gzipped = new Map<string, Promise<Buffer>>();
  return async (req, res) => {
    const send = (status: number, body: Uint8Array | string, headers: Record<string, string>) => {
      res.writeHead(status, { ...headers, 'x-content-type-options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const problem = (status: number, code: string, message: string) =>
      send(status, JSON.stringify({ error: { code, message } }), {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      return problem(405, 'method_not_allowed', 'The UI bundle is read-only');
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/ui') {
      res.writeHead(302, { location: `/ui/${url.search}` });
      res.end();
      return;
    }
    let relative: string;
    try {
      relative = decodeURIComponent(url.pathname.slice('/ui/'.length));
    } catch {
      return problem(404, 'not_found', 'Unknown UI path');
    }
    const spa = extname(relative) === '';
    // A hashed asset is a file under assets/, however its path is spelled; a route without an
    // extension there is a missing asset, never the page, which is not cached for a year.
    const hashed = relative.startsWith('assets/');
    const file = resolve(base, spa && !hashed ? 'index.html' : relative);
    if (!file.startsWith(`${base}${sep}${hashed ? `assets${sep}` : ''}`))
      return problem(404, 'not_found', 'Unknown UI path');
    const type = types[extname(file)] ?? 'application/octet-stream';
    const headers = {
      'content-type': type,
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    const zipped =
      compressible.test(type) && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    const sendText = (body: Uint8Array) =>
      send(200, body, {
        ...headers,
        vary: 'accept-encoding',
        ...(zipped && { 'content-encoding': 'gzip' }),
      });
    try {
      // What was gzipped once is sent as it was, without reading the disk again.
      const cached = hashed && zipped && req.method !== 'HEAD' ? gzipped.get(file) : undefined;
      if (cached) return sendText(await cached);
      const bytes = await readFile(file);
      if (!compressible.test(type)) return send(200, bytes, headers);
      // A HEAD is sent the headers alone: there is nothing to gzip.
      return sendText(
        !zipped || req.method === 'HEAD'
          ? bytes
          : await (hashed
              ? (gzipped.get(file) ?? gzipped.set(file, packed(bytes)).get(file)!)
              : packed(bytes)),
      );
    } catch {
      return spa && !hashed
        ? problem(503, 'ui_not_built', 'The UI bundle is not built; run npm run build:ui')
        : problem(404, 'not_found', 'Unknown UI path');
    }
  };
}
