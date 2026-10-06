import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, Agent, type Server } from 'node:http';
import { createService, type HumanPrincipal } from '@merv/contracts';
import { AccountSecrets } from '@merv/secrets';
import { huggingFacePath, huggingFaceRead, huggingFaceProxy } from '@merv/secrets/api';
import { openState } from './fixtures/state.js';

const listen = async (server: Server) => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};
const close = async (server: Server) => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
};
test('HF read boundary rejects ambiguous paths and account/write APIs', () => {
  for (const path of [
    'http://elsewhere/hf/api/models/x',
    '//hf/api/models/x',
    '/hf//api/models/x',
    '/hf/../api/models/x',
    '/hf/%2e%2e/api/models/x',
    '/hf/api%2fmodels/x',
    '/hf/%252e/api/models/x',
    '/hf/api\\models/x',
  ])
    assert.equal(huggingFacePath(path), null, path);
  for (const [method, path] of [
    ['GET', '/api/whoami-v2'],
    ['GET', '/api/settings/webhooks'],
    ['GET', '/api/spaces/x'],
    ['GET', '/oauth/token'],
    ['GET', '/api/models/x/xet-write-token/main'],
    ['GET', '/api/models/x/xet%2dwrite-token/main'],
    ['POST', '/api/models/x/commit/main'],
    ['DELETE', '/api/models/x'],
  ])
    assert.equal(huggingFaceRead(method!, path!), false, path);
  assert.ok(huggingFacePath('/hf/api/resolve-cache/datasets/org/repo/sha/folder%2Ffile.csv'));
  assert.equal(
    huggingFacePath('/hf/api/resolve-cache/datasets/org/repo/sha/folder%2F..%2Ffile.csv'),
    null,
  );
  assert.ok(huggingFaceRead('GET', '/api/models/org/repo/xet-read-token/main'));
  assert.ok(huggingFaceRead('POST', '/api/datasets/org/repo/paths-info/main'));
});

test('real encrypted grant, prefixed streaming proxy, rotated/revoked access and secret isolation', async (t) => {
  const state = await openState();
  t.after(() => state.close());
  let now = Date.now(),
    live = true,
    checks = 0;
  const person: HumanPrincipal = {
    kind: 'user',
    user: {
      issuer: 'https://identity.test',
      subject: 'owner',
      createdAt: new Date(now).toISOString(),
    },
    expiresAt: new Date(now + 3600000).toISOString(),
  };
  const secrets = await createService(
    new AccountSecrets(
      state,
      Buffer.alloc(32, 4).toString('base64url'),
      () => now,
      'https://merv.example/hf',
    ),
  );
  const unregister = secrets.registerHuggingFaceAuthority(async (grant) => {
    // The authority gets back exactly the binding it issued; Secrets never reads into it.
    assert.deepEqual(grant, context);
    checks++;
    return live ? person.user : null;
  });
  await secrets.saveHuggingFace(person, 'hf_SYNTHETIC_ROOT_ONLY');
  const context = { binding: 'opaque:session_test@host', exp: Math.floor(now / 1000) + 100 };
  const access = (await secrets.createHuggingFaceAccess(context))!;
  assert.ok(access && !access.token.includes('hf_SYNTHETIC_ROOT_ONLY'));
  const cipher = await state.read((sql) =>
    sql.get<{ ciphertext: string }>('SELECT ciphertext FROM account_huggingface_secrets'),
  );
  assert.equal(await secrets.resolveHuggingFaceGrant(cipher!.ciphertext), null);
  assert.equal(await secrets.resolveHuggingFaceGrant(access.token + 'bad'), null);
  let expected = 'hf_SYNTHETIC_ROOT_ONLY',
    upstreamCalls = 0;
  const data = Buffer.alloc(1024 * 1024, 120);
  const upstream = createServer((req, res) => {
    upstreamCalls++;
    assert.equal(req.headers.authorization, `Bearer ${expected}`);
    for (const name of [
      'cookie',
      'origin',
      'referer',
      'forwarded',
      'x-forwarded-for',
      'x-merv-secret',
      'cf-connecting-ip',
      'proxy-authorization',
    ])
      assert.equal(req.headers[name], undefined, name);
    if (req.url === '/api/models/redirect') {
      res.writeHead(302, {
        location: '/api/models/target',
        'set-cookie': 'private=yes',
        'x-xet-refresh-route': 'https://huggingface.co/api/models/x/xet-read-token/main',
        link: '<https://huggingface.co/api/models/next>; rel="next"',
      });
      res.end();
      return;
    }
    const offset = Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1] ?? 0);
    res.writeHead(offset ? 206 : 200, {
      'content-length': data.length - offset,
      ...(offset ? { 'content-range': `bytes ${offset}-${data.length - 1}/${data.length}` } : {}),
    });
    res.end(data.subarray(offset));
  });
  const target = await listen(upstream);
  const handler = huggingFaceProxy(secrets, target);
  const server = createServer((req, res) => {
    void handler(req, res, {} as never);
  });
  const base = await listen(server);
  t.after(async () => {
    await close(server);
    await close(upstream);
  });
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  let socket: unknown;
  const call = (path = '/hf/api/models/test', headers: Record<string, string> = {}) =>
    new Promise<{
      status: number;
      body: Buffer;
      headers: Record<string, unknown>;
      reused: boolean;
    }>((resolve, reject) => {
      const req = httpRequest(
        base + path,
        { agent, headers: { authorization: `Bearer ${access.token}`, ...headers } },
        (res) => {
          const chunks: Buffer[] = [];
          const reused = socket === res.socket;
          socket = res.socket;
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode!,
              body: Buffer.concat(chunks),
              headers: res.headers,
              reused,
            }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });
  assert.deepEqual(
    (
      await call(undefined, {
        'x-forwarded-for': 'private',
        'x-merv-secret': 'private',
        'cf-connecting-ip': 'private',
        cookie: 'private',
        referer: 'private',
        forwarded: 'private',
        'proxy-authorization': 'private',
      })
    ).body,
    data,
  );
  const ranged = await call(undefined, { range: 'bytes=65536-' });
  assert.equal(ranged.status, 206);
  assert.deepEqual(ranged.body, data.subarray(65536));
  const redirect = await call('/hf/api/models/redirect');
  assert.equal(redirect.headers.location, '/hf/api/models/target');
  assert.equal(
    redirect.headers['x-xet-refresh-route'],
    'https://merv.example/hf/api/models/x/xet-read-token/main',
  );
  assert.equal(redirect.headers['set-cookie'], undefined);
  assert.match(String(redirect.headers.link), /merv.example\/hf\/api\/models\/next/);
  const before = upstreamCalls;
  assert.equal((await call('/hf/api/settings/webhooks')).status, 403);
  assert.equal(upstreamCalls, before);
  expected = 'hf_ROTATED_SYNTHETIC';
  await secrets.saveHuggingFace(person, expected);
  assert.equal((await call()).status, 200);
  live = false;
  const denied = await call();
  assert.equal(denied.status, 401);
  assert.equal(denied.reused, true);
  live = true;
  await secrets.removeHuggingFace(person);
  assert.equal((await call()).status, 401);
  await secrets.saveHuggingFace(person, expected);
  now += 101000;
  assert.equal((await call()).status, 401);
  assert.ok(checks >= 5);
  now -= 101000;
  unregister();
  assert.equal((await call()).status, 401);
});

test('public API mount drains a transfer and a new deployment resumes with Range', async (t) => {
  const { ProjectScope } = await import('@merv/scope');
  const { ApiServer, ToolRegistry } = await import('@merv/api');
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  const tools = new ToolRegistry(scope);
  const data = Buffer.alloc(1024 * 1024, 97);
  const upstream = createServer((req, res) => {
    let offset = Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1] ?? 0);
    res.writeHead(offset ? 206 : 200, {
      'content-length': data.length - offset,
      ...(offset ? { 'content-range': `bytes ${offset}-${data.length - 1}/${data.length}` } : {}),
    });
    const timer = setInterval(() => {
      const end = Math.min(data.length, offset + 16384);
      res.write(data.subarray(offset, end));
      offset = end;
      if (offset === data.length) res.end();
    }, 5);
    res.once('close', () => clearInterval(timer));
  });
  const target = await listen(upstream);
  const broker = {
    huggingFaceEndpoint: 'https://merv.example/hf',
    resolveHuggingFaceGrant: async (token: string) =>
      token === 'test-capability' ? 'hf_SYNTHETIC' : null,
  };
  const start = async () => {
    const api = new ApiServer(scope, tools, { port: 0, drainMs: 20 });
    api.mount('/hf', huggingFaceProxy(broker, target), { public: true });
    return { api, base: await api.start() };
  };
  const first = await start();
  let second: Awaited<ReturnType<typeof start>> | undefined;
  t.after(async () => {
    await first.api.stop();
    await second?.api.stop();
    await close(upstream);
    await tools.close();
    await state.close();
  });
  let stopping: Promise<void> | undefined;
  const partial = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const req = httpRequest(
      first.base + '/hf/api/models/test',
      { headers: { authorization: 'Bearer test-capability' } },
      (res) => {
        res.on('data', (chunk) => {
          chunks.push(chunk);
          stopping ??= first.api.stop();
        });
        res.on('aborted', () => resolve(Buffer.concat(chunks)));
        res.on('end', () => reject(Error('drain did not interrupt the slow transfer')));
      },
    );
    req.on('error', reject);
    req.end();
  });
  await stopping;
  assert.ok(partial.length > 0 && partial.length < data.length);
  second = await start();
  const response = await fetch(second.base + '/hf/api/models/test', {
    headers: { authorization: 'Bearer test-capability', range: `bytes=${partial.length}-` },
  });
  assert.equal(response.status, 206);
  const rest = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(Buffer.concat([partial, rest]), data);
});
