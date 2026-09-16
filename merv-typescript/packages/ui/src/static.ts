import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
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

/** Serves a built browser bundle under /ui; routes without an extension fall back to index.html. */
export function serveBundle(root: string): MountHandler {
  const base = resolve(root);
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
    const file = spa ? resolve(base, 'index.html') : resolve(base, relative);
    if (!file.startsWith(`${base}${sep}`)) return problem(404, 'not_found', 'Unknown UI path');
    try {
      const bytes = await readFile(file);
      return send(200, bytes, {
        'content-type': types[extname(file)] ?? 'application/octet-stream',
        'cache-control': relative.startsWith('assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      });
    } catch {
      return spa
        ? problem(503, 'ui_not_built', 'The UI bundle is not built; run npm run build:ui')
        : problem(404, 'not_found', 'Unknown UI path');
    }
  };
}
