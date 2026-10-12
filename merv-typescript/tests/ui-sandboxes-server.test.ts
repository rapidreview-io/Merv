import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from 'cordis';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { MervError, type Caller, type Scope } from '@merv/contracts';
import { ApiServer } from '../packages/api/src/http.js';
import { ToolRegistry } from '../packages/api/src/registry.js';
import { sandboxesProxy } from '../packages/sandboxes/src/sandboxes-proxy.js';
import plugin from '../packages/sandboxes/src/console.js';

function server() {
  const scope = {
    authenticate: (token: string) => {
      if (!['human', 'actor'].includes(token))
        throw new MervError('unauthorized', 'Invalid token', 401);
      return { id: token };
    },
    caller: async (
      principal: { actor: { id: string } },
      projectId = 'project-a',
    ): Promise<Caller> => {
      if (projectId === 'denied') throw new MervError('forbidden', 'Project access denied', 403);
      return {
        actorId: principal.actor.id,
        projectId,
        ...(principal.actor.id === 'human'
          ? {
              human: {
                issuer: 'https://identity.example/auth/v1',
                subject: 'person-a',
                expiresAt: '2030-01-01T00:00:00Z',
                membershipId: 'member',
              },
            }
          : {}),
      };
    },
  } as unknown as Scope;
  return {
    scope,
    api: new ApiServer(scope, new ToolRegistry(scope), {
      snapshot: async () => {
        throw new Error('Console issuance must not enter a snapshot');
      },
    }),
  };
}

test('console sessions use the authenticated human and selected project, strip queries, preserve the host default, and never cache', async (t) => {
  const { api, scope } = server();
  const calls: { caller: Caller; options: { path?: string } }[] = [];
  const ctx = new Context();
  ctx.provide('api', api);
  ctx.provide('scope', scope);
  ctx.provide('ui', { contribute: () => () => {} } as never);
  ctx.provide('sbxMerv', {
    consoleSession: async (caller: Caller, options: { path?: string }) => {
      calls.push({ caller, options });
      return {
        url: 'https://sandboxes.example/ui/#code=single_use',
        expiresAt: '2030-01-01T00:00:00Z',
      };
    },
  } as never);
  const upstream = 'http://sbx-control:8000';
  plugin.apply(ctx, { upstream });
  const url = await api.start();
  t.after(() => api.stop());
  const post = (path: string, token = 'human', project = 'project-b') =>
    fetch(`${url}/sandboxes/console-session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-merv-project-id': project,
      },
      body: JSON.stringify({ path }),
    });
  const response = await post('/ui/jobs?x=1');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { url: '/sbx/ui/#code=single_use' });
  assert.deepEqual(calls, [
    {
      caller: {
        actorId: 'human',
        projectId: 'project-b',
        human: {
          issuer: 'https://identity.example/auth/v1',
          subject: 'person-a',
          expiresAt: '2030-01-01T00:00:00Z',
          membershipId: 'member',
        },
      },
      options: { path: '/ui/jobs' },
    },
  ]);
  assert.equal((await post('/ui/')).status, 200);
  assert.deepEqual(calls[1], { caller: calls[0]!.caller, options: {} });
  assert.equal((await post('/ui/', 'human', 'denied')).status, 403);
  assert.equal((await post('/ui/', 'bad')).status, 401);
  assert.equal((await fetch(`${url}/sandboxes/console-session`)).status, 401);
  assert.equal(calls.length, 2);
});

test('proxy strips only /sbx, preserves cookies and Origin, and drops forwarded trust headers', async (t) => {
  const seen: { path: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const upstream = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    seen.push({ path: req.url!, headers: req.headers, body });
    res.writeHead(200, {
      'set-cookie': '__Host-sbx=session; Secure; HttpOnly; Path=/; SameSite=Lax',
      'content-type': 'application/json',
    });
    res.end(JSON.stringify({ path: req.url }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const { api } = server();
  const target = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const proxy = sandboxesProxy(target);
  const withdraw = api.mount('/sbx', proxy.handler, { public: true, upgrade: proxy.upgrade });
  api.mount('/ui', (_req, res) => void res.end('Merv'), { public: true });
  const url = await api.start();
  t.after(async () => {
    await api.stop();
    upstream.close();
    await once(upstream, 'close');
  });
  for (const path of ['/ui/', '/ui/assets/app.js', '/v1/auth/browser/code']) {
    const response = await fetch(`${url}/sbx${path}?a=1`, {
      method: 'POST',
      headers: {
        origin: url,
        cookie: '__Host-sbx=existing',
        'x-sbx-csrf': 'proof',
        forwarded: 'host=trusted',
        'x-forwarded-host': 'trusted',
        'x-forwarded-proto': 'https',
        'x-real-ip': 'trusted',
      },
      body: 'body',
    });
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get('set-cookie'),
      '__Host-sbx=session; Secure; HttpOnly; Path=/; SameSite=Lax',
    );
    assert.deepEqual(await response.json(), { path: `${path}?a=1` });
    const last = seen.at(-1)!;
    assert.equal(last.body, 'body');
    assert.equal(last.headers.origin, url);
    assert.equal(last.headers.cookie, '__Host-sbx=existing');
    assert.equal(last.headers['x-sbx-csrf'], 'proof');
    for (const name of ['forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip'])
      assert.equal(last.headers[name], undefined);
  }
  for (const path of ['/sbx/mcp', '/sbx/ui-other/', '/sbx/v1', '/sbx/ui/%2f..%2fmcp'])
    assert.equal((await fetch(url + path)).status, 404, path);
  assert.equal(await (await fetch(`${url}/ui/`)).text(), 'Merv');
  assert.equal((await fetch(`${url}/mcp`)).status, 401);
  assert.equal(seen.length, 3);
  withdraw();
  assert.equal((await fetch(`${url}/sbx/ui/`)).status, 503);
});

test('terminal upgrades forward the stripped path, cookies, origin and bidirectional frames; shutdown closes them', async (t) => {
  const upstream = createServer();
  const wss = new WebSocketServer({ noServer: true });
  let received: { path: string; headers: IncomingHttpHeaders } | undefined;
  upstream.on('upgrade', (req, socket, head) => {
    received = { path: req.url!, headers: req.headers };
    wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (data) => ws.send(data)));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const { api } = server();
  const proxy = sandboxesProxy(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`);
  const withdraw = api.mount('/sbx', proxy.handler, { public: true, upgrade: proxy.upgrade });
  const url = await api.start();
  const ws = new WebSocket(`${url.replace('http:', 'ws:')}/sbx/v1/terminal/one?ticket=two`, {
    headers: {
      origin: url,
      cookie: '__Host-sbx=ok',
      forwarded: 'host=trusted',
      'x-forwarded-for': 'trusted',
    },
  });
  t.after(async () => {
    ws.terminate();
    await api.stop();
    wss.close();
    upstream.close();
  });
  await once(ws, 'open');
  assert.equal(received?.path, '/v1/terminal/one?ticket=two');
  assert.equal(received?.headers.origin, url);
  assert.equal(received?.headers.cookie, '__Host-sbx=ok');
  assert.equal(received?.headers.forwarded, undefined);
  assert.equal(received?.headers['x-forwarded-for'], 'trusted');
  const echoed = once(ws, 'message');
  ws.send('terminal input');
  assert.equal(String((await echoed)[0]), 'terminal input');
  const refused = (path: string, origin = url) =>
    new Promise<number>((resolve, reject) => {
      const client = new WebSocket(`${url.replace('http:', 'ws:')}${path}`, { origin });
      client.on('error', () => {});
      client.once('open', () => {
        client.terminate();
        reject(new Error('Unexpected upgrade'));
      });
      client.once('unexpected-response', (req, response) => {
        resolve(response.statusCode!);
        req.destroy();
      });
    });
  assert.equal(await refused('/sbx/mcp'), 404);
  assert.equal(await refused('/mcp'), 404);
  assert.equal(await refused('/sbx/v1/terminal', 'https://forged.example'), 403);
  withdraw();
  assert.equal(await refused('/sbx/v1/terminal'), 503);
  const closed = once(ws, 'close');
  await api.stop();
  await closed;
});
