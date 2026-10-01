import type { Context } from 'cordis';
import { z } from 'zod';
import { check, MervError } from '@merv/contracts';
import type { MountHandler } from '@merv/api/types';
import type { Secrets } from './types.js';
import { huggingFaceToken } from './index.js';
import type { IncomingMessage } from 'node:http';
import { createProxyServer } from 'httpxy';

const input = z.object({ token: huggingFaceToken }).strict();
export function secretsRoutes(secrets: Secrets): MountHandler {
  return async (req, res, request) => {
    res.setHeader('Cache-Control', 'no-store');
    if (request.url.pathname !== '/secrets/huggingface')
      throw new MervError('not_found', 'Unknown endpoint', 404);
    const principal = request.principal;
    // Only transport-verified humans: no actor, key, managed worker or conversation caller.
    check(
      principal && !('caller' in principal) && principal.kind === 'user',
      'forbidden',
      'Sign in with an account to manage Hugging Face access',
      403,
    );
    check(!request.url.search, 'invalid_input', 'This endpoint accepts no query parameters');
    if (req.method === 'GET') return secrets.huggingFaceStatus(principal);
    if (req.method === 'PUT')
      return secrets.saveHuggingFace(principal, (await request.json(input, 8192)).token);
    if (req.method === 'DELETE') return secrets.removeHuggingFace(principal);
    throw new MervError('not_found', 'Unknown endpoint', 404);
  };
}
export const secretsApiPlugin = {
  name: 'merv-secrets-api',
  inject: ['secrets', 'api'],
  apply(ctx: Context) {
    ctx.effect(() => ctx.api.mount('/secrets', secretsRoutes(ctx.secrets)));
    ctx.effect(() => ctx.api.mount('/hf', huggingFaceProxy(ctx.secrets), { public: true }));
  },
};
export default secretsApiPlugin;

const origin = 'https://huggingface.co';
const prefix = '/hf';
const requestHeaders = new Set([
  'accept',
  'accept-encoding',
  'user-agent',
  'content-type',
  'content-length',
  'range',
  'if-range',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
]);

/** Validate the raw path before URL normalization or httpxy's path concatenation. */
export function huggingFacePath(raw: string): string | null {
  if (!raw.startsWith(prefix + '/')) return null;
  const path = raw.slice(prefix.length);
  const pathname = path.split('?')[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  // HF's resolve-cache redirect encodes folder separators inside its filename parameter.
  // Permit them only after the fixed API, repo and revision; never in the routing prefix.
  const filename = /^\/api\/resolve-cache\/(?:models|datasets)\/[^/%]+\/[^/%]+\/[^/%]+\/(.+)$/.exec(
    pathname,
  )?.[1];
  if (
    decoded.includes('//') ||
    /[\\\x00-\x20#?]/.test(decoded) ||
    /%(?:2e|5c|25)/i.test(pathname) ||
    (/%2f/i.test(pathname) && (!filename || /%2f/i.test(pathname.slice(0, -filename.length)))) ||
    decoded.split('/').some((part) => part === '.' || part === '..')
  )
    return null;
  return path;
}

export function huggingFaceRead(method: string, path: string): boolean {
  let pathname: string;
  try {
    pathname = decodeURIComponent(path.split('?')[0]!);
  } catch {
    return false;
  }
  if (/\/xet-write-token(?:\/|$)/.test(pathname)) return false;
  if (method === 'POST')
    return /^\/api\/(?:models|datasets)\/[^/]+(?:\/[^/]+)?\/paths-info\/[^/]+$/.test(pathname);
  return (
    (method === 'GET' || method === 'HEAD') &&
    (/^\/api\/(?:models|datasets|resolve-cache)\//.test(pathname) ||
      (!/^\/(?:api|settings|oauth|spaces)(?:\/|$)/.test(pathname) &&
        /^\/(?:datasets\/)?[^/]+(?:\/[^/]+)?\/resolve\//.test(pathname)))
  );
}

/** Streaming fixed-origin proxy. The target override is only a synthetic-upstream test seam. */
export function huggingFaceProxy(
  secrets: Pick<Secrets, 'huggingFaceEndpoint' | 'resolveHuggingFaceGrant'>,
  target = origin,
): MountHandler {
  const tokens = new WeakMap<IncomingMessage, string>();
  const proxy = createProxyServer({
    target,
    changeOrigin: true,
    followRedirects: false,
    xfwd: false,
  });
  proxy.on('proxyReq', (out, req) => {
    out.setHeader('authorization', `Bearer ${tokens.get(req)}`);
    tokens.delete(req);
  });
  const rewrite = (value: string) =>
    value.startsWith('/') && !value.startsWith('//')
      ? prefix + value
      : value === origin || value.startsWith(origin + '/')
        ? secrets.huggingFaceEndpoint + value.slice(origin.length)
        : value;
  proxy.on('proxyRes', (reply) => {
    delete reply.headers['set-cookie'];
    delete reply.headers.authorization;
    reply.headers['cache-control'] = 'private, no-store';
    for (const name of ['location', 'x-xet-refresh-route']) {
      const value = reply.headers[name];
      if (typeof value === 'string') reply.headers[name] = rewrite(value);
    }
    if (typeof reply.headers.link === 'string')
      reply.headers.link = reply.headers.link.replace(
        /<([^>]+)>/g,
        (_, link: string) => `<${rewrite(link)}>`,
      );
  });
  proxy.on('error', (_error, _req, res) => {
    if (!res || !('writeHead' in res)) return;
    if (!res.headersSent) res.writeHead(502, { 'cache-control': 'no-store' });
    res.end('Hugging Face unavailable');
  });
  return async (req, res) => {
    const refuse = (status: number) => {
      res.writeHead(status, { 'cache-control': 'no-store' });
      res.end('Hugging Face access unavailable');
    };
    const path = huggingFacePath(req.url ?? '');
    if (!path) return refuse(400);
    if (!huggingFaceRead(req.method ?? '', path)) return refuse(403);
    const bearer = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(req.headers.authorization ?? '')?.[1];
    const token =
      bearer && secrets.huggingFaceEndpoint ? await secrets.resolveHuggingFaceGrant(bearer) : null;
    if (!token) return refuse(401);
    // Allow only HF client content/conditional headers. No cookies, tracing, edge identity,
    // forwarding headers or Merv credentials can cross this boundary.
    for (const name of Object.keys(req.headers))
      if (!requestHeaders.has(name)) delete req.headers[name];
    req.url = path;
    tokens.set(req, token);
    // Keep the API's drain accounting open until the streamed response finishes or disconnects.
    await new Promise<void>((resolve) => {
      const done = () => {
        tokens.delete(req);
        resolve();
      };
      res.once('finish', done);
      res.once('close', done);
      void proxy.web(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(502, { 'cache-control': 'no-store' });
        res.end('Hugging Face unavailable');
      });
    });
  };
}
