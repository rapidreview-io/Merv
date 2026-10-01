import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createService, sha256Hex } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { NativeConnections } from '../packages/sandboxes/src/native-connections.js';
import { nativeMigrations } from '../packages/sandboxes/src/native-schema.js';
import { openState } from './fixtures/state.js';
import { deferred } from './fixtures/deferred.js';

async function foundation(t: TestContext) {
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  await state.migrate('sandboxes-native', nativeMigrations);
  const issuer = 'https://identity.example/auth/v1';
  const principal = await scope.acceptVerifiedIdentity({
    issuer,
    subject: 'owner',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const project = await scope.createProject(principal, {
    name: 'Native compute',
    requestId: 'create',
  });
  const caller = await scope.caller(principal, project.id);
  const starts: Record<string, string>[] = [];
  const roots = new Map<
    string,
    {
      connection_id: string;
      account_id: string;
      member_id: string;
      project_ref: string;
      revoked: boolean;
    }
  >();
  const control = {
    loseReply: false,
    suspended: false,
    denyDelete: false,
    deletes: 0,
    pause: undefined as ReturnType<typeof deferred<void>> | undefined,
    entered: deferred<void>(),
  };
  let origin = '';
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.url === '/v1/auth/connections/start') {
      assert.equal(req.headers['x-sandbox-application-secret'], 'synthetic-application-secret');
      starts.push(body);
      json({
        consent_url: `${origin}/ui/consent?request=${starts.length - 1}`,
        expires_at: '2099-01-01T00:00:00Z',
      });
      return;
    }
    if (req.url === '/v1/auth/connections/exchange') {
      const start = starts[Number(body.code)];
      assert.ok(start);
      for (const key of [
        'project_ref',
        'operator_ref',
        'operator_issuer',
        'operator_subject',
        'state',
        'redirect_uri',
        'application_id',
      ])
        assert.equal(body[key], start[key]);
      assert.equal(
        Buffer.from(sha256Hex(body.code_verifier), 'hex').toString('base64url'),
        start.code_challenge,
      );
      if (!roots.has(start.token_hash!))
        roots.set(start.token_hash!, {
          connection_id: `root_${body.code}`,
          account_id: `account_${body.code}`,
          member_id: `member_${body.code}`,
          project_ref: start.project_ref!,
          revoked: false,
        });
      control.entered.resolve();
      await control.pause?.promise;
      if (control.loseReply) {
        control.loseReply = false;
        req.socket.destroy();
        return;
      }
      json(roots.get(start.token_hash!));
      return;
    }
    if (req.url === '/v1/delegations/connection') {
      const root = roots.get(sha256Hex((req.headers.authorization ?? '').slice(7)));
      if (!root) {
        json({}, 401);
        return;
      }
      if (req.method === 'DELETE') {
        control.deletes++;
        if (control.denyDelete) {
          json({}, 403);
          return;
        }
        root.revoked = true;
        res.writeHead(204);
        res.end();
        return;
      }
      json(root, control.suspended || root.revoked ? 403 : 200);
      return;
    }
    json({}, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await state.close();
  });
  let now = Date.now();
  const config = {
    applicationId: 'merv',
    applicationSecretEnv: 'TEST_APP',
    encryptionKeyEnv: 'TEST_KEY',
    publicOrigin: 'http://127.0.0.1:4317',
  };
  const environment = {
    TEST_APP: 'synthetic-application-secret',
    TEST_KEY: Buffer.alloc(32, 9).toString('base64url'),
  };
  const reopen = () =>
    new NativeConnections(state, scope, config, origin, environment, fetch, () => now);
  const service = reopen();
  const ready = async () => {
    const result = await service.begin(caller);
    const code = new URL(result.url).searchParams.get('request')!;
    await service.callbackReady(result.cookie, code, starts[Number(code)]!.state!);
    return result.cookie;
  };
  return {
    state,
    scope,
    principal,
    project,
    caller,
    starts,
    roots,
    control,
    service,
    ready,
    reopen,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('native consent persists encrypted authority, binds the same human, and survives restart', async (t) => {
  const f = await foundation(t);
  const cookie = await f.ready();
  assert.deepEqual(
    [f.starts[0]!.operator_issuer, f.starts[0]!.operator_subject],
    ['https://identity.example/auth/v1', 'owner'],
  );
  const status = await f.reopen().finish(f.caller, cookie);
  assert.equal(status.connected, true);
  assert.match(status.url!, /\/ui$/);
  assert.deepEqual(await f.service.finish(f.caller, cookie), status);
  assert.equal(f.roots.size, 1);
  const flow = await f.state.read((sql) =>
    sql.get<{ payload: string; code: string }>('SELECT payload,code FROM sandbox_native_flows'),
  );
  assert.ok(flow);
  assert.doesNotMatch(flow.payload, /sbxt_|owner|verifier/);
  assert.notEqual(flow.code, '0');
});

test('lost exchange reply can replay its exact persisted request', async (t) => {
  const f = await foundation(t);
  const cookie = await f.ready();
  f.control.loseReply = true;
  await assert.rejects(f.service.finish(f.caller, cookie), /unreachable/);
  assert.equal(f.roots.size, 1);
  assert.equal((await f.reopen().finish(f.caller, cookie)).connected, true);
  assert.equal(f.roots.size, 1);
});

test('expired unknown exchange recovers and revokes its root after a restart', async (t) => {
  const f = await foundation(t);
  const cookie = await f.ready();
  f.control.loseReply = true;
  await assert.rejects(f.service.finish(f.caller, cookie));
  f.advance(631000);
  await f.reopen().reconcileRevocations();
  assert.equal([...f.roots.values()][0]!.revoked, true);
  assert.equal((await f.service.status(f.caller)).connected, false);
  assert.equal(
    (await f.state.read((sql) => sql.all('SELECT id FROM sandbox_native_flows'))).length,
    0,
  );
});

test('a temporarily suspended account still self-revokes; a rejected DELETE is never confirmation', async (t) => {
  const f = await foundation(t);
  await f.service.finish(f.caller, await f.ready());
  f.control.suspended = true;
  f.control.denyDelete = true;
  assert.equal((await f.service.disconnect(f.caller)).connected, false);
  let row = await f.state.read((sql) =>
    sql.get<{ revoke_pending: boolean }>('SELECT revoke_pending FROM sandbox_native_connections'),
  );
  assert.equal(row?.revoke_pending, true);
  f.control.denyDelete = false;
  await f.service.reconcileRevocations();
  row = await f.state.read((sql) =>
    sql.get<{ revoke_pending: boolean }>('SELECT revoke_pending FROM sandbox_native_connections'),
  );
  assert.equal(row?.revoke_pending, false);
  assert.equal([...f.roots.values()][0]!.revoked, true);
});

test('overlapping flows cannot replace a new connection or revoke its winning root', async (t) => {
  const f = await foundation(t);
  const first = await f.ready(),
    second = await f.ready();
  const winner = await f.service.finish(f.caller, first);
  await assert.rejects(f.service.finish(f.caller, second), /changed during sign-in/);
  await f.service.reconcileRevocations();
  assert.equal((await f.service.status(f.caller)).connectionId, winner.connectionId);
  assert.equal([...f.roots.values()][0]!.revoked, false);
  assert.equal([...f.roots.values()][1]!.revoked, true);
});

test('a stale tab cannot begin a replacement while the project is connected', async (t) => {
  const f = await foundation(t);
  const first = await f.service.finish(f.caller, await f.ready());
  const starts = f.starts.length;
  await assert.rejects(f.service.begin(f.caller), { code: 'sandbox_already_connected' });
  assert.equal(f.starts.length, starts, 'no extra consent reaches Sandboxes');
  assert.equal((await f.service.status(f.caller)).connectionId, first.connectionId);
  assert.equal(f.roots.size, 1);
  assert.equal(f.control.deletes, 0);
});

test('an old replacement flow cannot replace a connection even if its former pointer still matches', async (t) => {
  const f = await foundation(t);
  const firstCookie = await f.ready();
  const staleCookie = await f.ready();
  const first = await f.service.finish(f.caller, firstCookie);
  await f.state.transaction((tx) =>
    tx.run(
      'UPDATE sandbox_native_flows SET previous_connection_id=? WHERE completed_at IS NULL',
      first.connectionId!,
    ),
  );
  await assert.rejects(f.service.finish(f.caller, staleCookie), {
    code: 'sandbox_connection_conflict',
  });
  await f.service.reconcileRevocations();
  assert.equal((await f.service.status(f.caller)).connectionId, first.connectionId);
  assert.equal([...f.roots.values()][0]!.revoked, false);
  assert.equal([...f.roots.values()][1]!.revoked, true);
});

test('concurrent consent finishes activate exactly one root and revoke the loser', async (t) => {
  const f = await foundation(t);
  const first = await f.ready(),
    second = await f.ready();
  f.control.pause = deferred<void>();
  const a = f.service.finish(f.caller, first),
    b = f.service.finish(f.caller, second);
  const finished = Promise.allSettled([a, b]);
  await f.control.entered.promise;
  f.control.pause.resolve();
  const results = await finished;
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  await f.service.reconcileRevocations();
  assert.equal([...f.roots.values()].filter((root) => !root.revoked).length, 1);
  await f.service.disconnect(f.caller);
  assert.equal([...f.roots.values()].filter((root) => !root.revoked).length, 0);
});

test('disconnect fences an in-flight first connection even before any local root exists', async (t) => {
  const f = await foundation(t);
  const cookie = await f.ready();
  f.control.pause = deferred<void>();
  const finish = f.service.finish(f.caller, cookie);
  await f.control.entered.promise;
  assert.equal((await f.service.disconnect(f.caller)).connected, false);
  f.control.pause.resolve();
  await assert.rejects(finish, /Start Sandboxes sign-in again/);
  await f.service.reconcileRevocations();
  assert.equal([...f.roots.values()][0]!.revoked, true);
  assert.equal((await f.service.status(f.caller)).connected, false);
});

test('a different project operator cannot complete the initiating human consent', async (t) => {
  const f = await foundation(t);
  const cookie = await f.ready();
  const other = await f.scope.acceptVerifiedIdentity({
    issuer: 'https://identity.example/auth/v1',
    subject: 'other',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  await f.scope.addMember(f.principal, f.project.id, { subject: 'other', role: 'operator' });
  await assert.rejects(
    f.service.finish(await f.scope.caller(other, f.project.id), cookie),
    /account that started/,
  );
  assert.equal(f.roots.size, 0);
});

test('reconciliation leaves a persisted pending root alone during a valid finish', async (t) => {
  const f = await foundation(t);
  const cookie = await f.ready();
  const internal = f.service as unknown as { saveReceipt(...args: unknown[]): Promise<void> };
  const original = internal.saveReceipt.bind(f.service),
    saved = deferred<void>(),
    resume = deferred<void>();
  internal.saveReceipt = async (...args) => {
    await original(...args);
    saved.resolve();
    await resume.promise;
  };
  const finish = f.service.finish(f.caller, cookie);
  await saved.promise;
  await f.service.reconcileRevocations();
  assert.equal(f.control.deletes, 0);
  resume.resolve();
  assert.equal((await finish).connected, true);
});

test('operator removal during exchange refuses activation and revokes its orphan', async (t) => {
  const f = await foundation(t);
  const other = await f.scope.acceptVerifiedIdentity({
    issuer: 'https://identity.example/auth/v1',
    subject: 'other',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  await f.scope.addMember(f.principal, f.project.id, { subject: 'other', role: 'operator' });
  const cookie = await f.ready();
  f.control.pause = deferred<void>();
  const finish = f.service.finish(f.caller, cookie);
  const rejected = assert.rejects(finish);
  await f.control.entered.promise;
  await f.scope.removeMember(other, f.project.id, 'owner');
  f.control.pause.resolve();
  await rejected;
  await f.service.reconcileRevocations();
  assert.equal([...f.roots.values()][0]!.revoked, true);
  assert.equal(
    (await f.service.status(await f.scope.caller(other, f.project.id))).connected,
    false,
  );
});

test('HTTP controls authenticate before bodies and public callback has no project authority', async (t) => {
  const f = await foundation(t);
  const { ApiServer } = await import('../packages/api/src/http.js');
  const { ToolRegistry } = await import('../packages/api/src/registry.js');
  const { nativeRoutes } = await import('../packages/sandboxes/src/native-api.js');
  const tools = new ToolRegistry(f.scope);
  const api = new ApiServer(
    f.scope,
    tools,
    { port: 0 },
    {
      configuration: () => ({ enabled: true }),
      verify: async (token) => {
        assert.equal(token, 'owner.jwt.token');
        return {
          issuer: 'https://identity.example/auth/v1',
          subject: 'owner',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        };
      },
    },
  );
  const dispose = api.mount('/sandboxes', nativeRoutes(f.service), {
    public: ['/sandboxes/connection/callback'],
  });
  const url = await api.start();
  t.after(async () => {
    dispose();
    await api.stop();
    await tools.close();
  });
  const headers = {
    authorization: 'Bearer owner.jwt.token',
    'x-merv-project-id': f.project.id,
    'content-type': 'application/json',
  };
  assert.equal((await fetch(`${url}/sandboxes/connection`)).status, 401);
  assert.equal(
    (
      await fetch(`${url}/sandboxes/connection/start`, {
        method: 'POST',
        headers,
        body: '{"token":"injected"}',
      })
    ).status,
    400,
  );
  const started = await fetch(`${url}/sandboxes/connection/start`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  assert.equal(started.status, 200);
  const cookie = started.headers.get('set-cookie')!.split(';')[0]!;
  const result = (await started.json()) as { url: string };
  assert.deepEqual(Object.keys(result), ['url']);
  const state = f.starts[0]!.state!;
  const callback = `${url}/sandboxes/connection/callback?code=0&state=${encodeURIComponent(state)}`;
  assert.equal((await fetch(callback, { redirect: 'manual' })).status, 409);
  const invalid = await fetch(callback + '&code=other', {
    headers: { cookie },
    redirect: 'manual',
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(
    (await fetch(`${url}/sandboxes/connection/callback/start`, { headers: { cookie } })).status,
    404,
  );
  const returned = await fetch(callback, { headers: { cookie }, redirect: 'manual' });
  assert.equal(returned.status, 303);
  assert.equal(f.roots.size, 0);
  const finished = await fetch(`${url}/sandboxes/connection/finish`, {
    method: 'POST',
    headers: { ...headers, cookie },
    body: '{}',
  });
  assert.equal(finished.status, 200);
  assert.equal(((await finished.json()) as { connected: boolean }).connected, true);
  assert.equal(
    (await fetch(`${url}/sandboxes/connection`, { method: 'DELETE', headers })).status,
    200,
  );
  assert.equal([...f.roots.values()][0]!.revoked, true);
});

test('browser state and duplicate-cookie substitution never admit an exchange', async (t) => {
  const f = await foundation(t);
  const started = await f.service.begin(f.caller);
  await assert.rejects(
    f.service.callbackReady(started.cookie, '0', 'other-state'),
    /does not match/,
  );
  await assert.rejects(
    f.service.callbackReady(started.cookie + '; ' + started.cookie, '0', f.starts[0]!.state!),
    /Start Sandboxes sign-in again/,
  );
  await assert.rejects(
    f.service.finish(f.caller, started.cookie),
    /Finish Sandboxes sign-in first/,
  );
  assert.equal(f.roots.size, 0);
});
