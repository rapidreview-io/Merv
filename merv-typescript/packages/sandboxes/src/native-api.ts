import { check, MervError } from '@merv/contracts';
import type { MountHandler } from '@merv/api/types';
import type { NativeConnections } from './native-connections.js';

/** The public callback only holds the code; authenticated finish binds project authority. */
export function nativeRoutes(connections?: NativeConnections): MountHandler {
  return async (req, res, r) => {
    res.setHeader('cache-control', 'no-store');
    if (r.url.pathname === '/sandboxes/connection/callback' && req.method === 'GET') {
      res.setHeader('referrer-policy', 'no-referrer');
      check(connections, 'sandbox_setup_required', 'Compute is not configured', 503);
      check(
        [...r.url.searchParams.keys()].every(
          (key) => ['code', 'state'].includes(key) && r.url.searchParams.getAll(key).length === 1,
        ),
        'invalid_input',
        'Invalid compute sign-in reply',
      );
      const location = await connections.callbackReady(
        req.headers.cookie,
        r.url.searchParams.get('code') ?? '',
        r.url.searchParams.get('state') ?? '',
      );
      res.writeHead(303, { location });
      res.end();
      return;
    }
    // A public-prefix descendant must never become an authenticated action.
    if (
      !r.principal ||
      ![
        '/sandboxes/connection',
        '/sandboxes/connection/start',
        '/sandboxes/connection/finish',
        '/sandboxes/connection/managed',
      ].includes(r.url.pathname)
    )
      throw new MervError('not_found', 'Unknown compute endpoint', 404);
    const caller = await r.caller();
    check(!r.url.search, 'invalid_input', 'Compute controls do not accept query parameters');
    if (req.method === 'GET' && r.url.pathname === '/sandboxes/connection') {
      return connections
        ? connections.status(caller)
        : {
            available: false,
            connected: false,
            connectionId: null,
            accountId: null,
            memberId: null,
            connectedAt: null,
            url: null,
          };
    }
    check(connections, 'sandbox_setup_required', 'Compute is not configured', 503);
    if (req.method === 'DELETE' && r.url.pathname === '/sandboxes/connection')
      return connections.disconnect(caller);
    if (req.method === 'POST') {
      const body = await r.json(undefined, 1024);
      check(
        body && typeof body === 'object' && !Array.isArray(body) && !Object.keys(body).length,
        'invalid_input',
        'Compute controls expect an empty object',
      );
      if (r.url.pathname === '/sandboxes/connection/managed')
        return connections.enableManaged(caller);
      if (r.url.pathname === '/sandboxes/connection/start') {
        const result = await connections.begin(caller);
        res.setHeader('set-cookie', result.cookie);
        return { url: result.url };
      }
      if (r.url.pathname === '/sandboxes/connection/finish')
        return connections.finish(caller, req.headers.cookie);
    }
    throw new MervError('not_found', 'Unknown compute endpoint', 404);
  };
}
