import { OAuthAdmission } from './oauth-admission.js';
import { z } from 'zod';
import type { MountHandler } from '@merv/api/types';
import type { IdentityProvider } from '@merv/identity/types';
import { OAuth, OAuthError } from './oauth.js';
import { MervError } from '@merv/contracts';

export function oauthRoutes(
  oauth: OAuth,
  identity: IdentityProvider,
  trustedProxyIps: readonly string[] = ['127.0.0.1', '::1'],
): MountHandler {
  const admission = new OAuthAdmission(trustedProxyIps, oauth.clock);
  return async (req, res, r) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('pragma', 'no-cache');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-content-type-options', 'nosniff');
    try {
      const path = r.url.pathname;
      const kind =
        req.method === 'POST' && path === '/oauth/register'
          ? 'register'
          : req.method === 'GET' && path === '/oauth/authorize'
            ? 'authorize'
            : null;
      if (kind) {
        const retry = admission.admit(req, kind);
        if (retry !== null) {
          res.setHeader('retry-after', String(retry));
          throw new OAuthError(
            'temporarily_unavailable',
            'Too many OAuth requests; retry shortly',
            429,
          );
        }
      }
      if (req.method === 'GET' && path === '/.well-known/oauth-authorization-server')
        return oauth.metadata();
      if (
        req.method === 'GET' &&
        [
          '/.well-known/oauth-protected-resource',
          '/.well-known/oauth-protected-resource/mcp',
        ].includes(path)
      )
        return oauth.protectedResource();
      if (req.method === 'POST' && path === '/oauth/register') {
        const result = await oauth.register(await r.json(undefined, 8192));
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      if (req.method === 'GET' && path === '/oauth/authorize') {
        const id = await oauth.start(r.url.searchParams);
        res.writeHead(302, { location: `${oauth.origin}/ui/connect/${id}` });
        res.end();
        return;
      }
      const consent = /^\/oauth\/requests\/([A-Za-z0-9_-]{43})$/.exec(path);
      if (consent) {
        if (req.method === 'GET') return oauth.details(consent[1]!);
        if (req.method === 'POST') {
          // Browser sends its own account bearer, never a cookie. Require same-origin as well.
          if (req.headers.origin !== oauth.origin)
            throw new OAuthError('access_denied', 'Consent must come from the Merv website', 403);
          const verified = await identity.verify(r.bearer());
          const principal = await oauth.scope.members.acceptVerifiedIdentity(verified);
          const input = await r.json(
            z.object({ projectId: z.string().min(1).max(200), allow: z.boolean() }).strict(),
            4096,
          );
          return {
            redirect: await oauth.consent(consent[1]!, principal, input.projectId, input.allow),
          };
        }
      }
      if (req.method === 'POST' && ['/oauth/token', '/oauth/revoke'].includes(path)) {
        const p = new URLSearchParams(
          (await r.bytes(8192, 'application/x-www-form-urlencoded')).toString('utf8'),
        );
        if (path === '/oauth/token') {
          try {
            return await oauth.exchange(p);
          } catch (e) {
            if (e instanceof MervError && [401, 403].includes(e.status))
              throw new OAuthError('invalid_grant', 'Authorization is no longer valid');
            throw e;
          }
        }
        await oauth.revoke(p);
        return {};
      }
      throw new OAuthError('invalid_request', 'Unknown OAuth endpoint', 404);
    } catch (e) {
      if (!(e instanceof OAuthError)) throw e;
      res.writeHead(e.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.error, error_description: e.message }));
    }
  };
}
