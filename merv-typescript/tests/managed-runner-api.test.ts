import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MervError, type Caller, type Scope } from '@merv/contracts';
import type { IdentityProvider } from '@merv/identity/types';
import { createApp } from './fixtures/app.js';
import type { ApplicationConfig } from '../src/config.js';
import { ApiServer } from '../packages/api/src/http.js';
import type { CodeApiProvider, SessionApiProvider, Tools } from '../packages/api/src/types.js';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-managed-api-'));
  const env = `MERV_MANAGED_API_${randomUUID().replaceAll('-', '')}`;
  process.env[env] = randomBytes(48).toString('hex');
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as ApplicationConfig;
  config.plugins.find((entry) => entry.id === 'sessions')!.config = { managedSecretEnv: env };
  const app = await createApp({ directory, port: 0, config });
  t.after(async () => {
    await app.stop();
    delete process.env[env];
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Managed API', actorName: 'Owner' });
  const owner: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const source = await app.ctx.scope.delegationSource(owner);
  app.ctx.sessions.registerManagedValidator({
    current: async (binding) =>
      binding.allocationId === 'allocation-api' &&
      binding.epoch === 1 &&
      binding.source.actorId === owner.actorId,
    admits: async () => true,
  });
  const enrollment = await app.ctx.sessions.ensureManagedEnrollment({
    allocationId: 'allocation-api',
    epoch: 1,
    source,
    runtimeProfileId: 'codex-profile',
    platform: {
      name: 'codex',
      harness: 'codex',
      model: 'gpt-6-luna',
      enabled: true,
      parallelism: 1,
    },
    capabilities: [],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const request = async (
    path: string,
    token: string,
    method = 'GET',
    body?: unknown,
    projectId?: string,
  ) => {
    const response = await fetch(`${app.ctx.api.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(projectId ? { 'x-merv-project-id': projectId } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  return {
    app,
    owner,
    actorToken: boot.token,
    enrollmentToken: enrollment.enrollmentToken,
    workerNonce: randomBytes(32).toString('hex'),
    projectId: boot.project.id,
    request,
  };
}

test('managed HTTP credentials stay on enrollment and control routes', async (t) => {
  const f = await fixture(t);
  assert.match(f.enrollmentToken, /^me_[0-9a-f]{64}$/);
  const missing = await f.request(
    '/sessions/runners/enroll',
    f.enrollmentToken,
    'POST',
    {},
    f.projectId,
  );
  assert.equal(missing.status, 400);
  const enrolled = await f.request(
    '/sessions/runners/enroll',
    f.enrollmentToken,
    'POST',
    { workerNonce: f.workerNonce },
    f.projectId,
  );
  assert.equal(enrolled.status, 200, JSON.stringify(enrolled));
  const token: string = enrolled.body.controlToken;
  assert.match(token, /^mr_[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(enrolled.body), ['controlToken']);
  const replay = await f.request(
    '/sessions/runners/enroll',
    f.enrollmentToken,
    'POST',
    { workerNonce: f.workerNonce },
    f.projectId,
  );
  assert.equal(replay.status, 200);
  assert.equal(replay.body.controlToken, token);
  const conflict = await f.request(
    '/sessions/runners/enroll',
    f.enrollmentToken,
    'POST',
    { workerNonce: randomBytes(32).toString('hex') },
    f.projectId,
  );
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error?.code, 'managed_binding_conflict');
  const heartbeat = {
    runnerId: 'managed-api-runner',
    machine: { hostname: 'api-host', system: 'Linux', architecture: 'x64' },
    platforms: [
      { name: 'codex', harness: 'codex', model: 'gpt-6-luna', enabled: true, parallelism: 1 },
    ],
    capacity: 1,
    capabilities: [],
  };
  const active = await f.request(
    '/sessions/runners/heartbeat',
    token,
    'POST',
    heartbeat,
    f.projectId,
  );
  assert.equal(active.status, 200, JSON.stringify(active));
  for (const path of ['/sessions/self', '/tools', '/projects', '/account', '/probe', '/mcp']) {
    const result = await f.request(path, token, 'GET', undefined, f.projectId);
    assert.equal(result.status, 403, `${path}: ${JSON.stringify(result)}`);
    assert.equal(result.body.error?.code, 'managed_runner_forbidden');
  }
  for (const path of ['/sessions/self/assignment', '/tools/task.create', '/mcp']) {
    const result = await f.request(path, token, 'POST', {}, f.projectId);
    assert.equal(result.status, 403, `${path}: ${JSON.stringify(result)}`);
    assert.equal(result.body.error?.code, 'managed_runner_forbidden');
  }
  const mounted = f.app.ctx.api.mount('/probe', (_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ reached: true }));
  });
  t.after(mounted);
  assert.equal((await f.request('/probe', token, 'GET')).status, 403);
  assert.equal((await f.request('/probe', f.actorToken, 'GET')).status, 200);
  assert.equal(
    (await f.request('/sessions/status', f.actorToken, 'GET', undefined, f.projectId)).status,
    200,
  );
  assert.equal(
    (await f.request('/sessions/runners/heartbeat', token, 'POST', heartbeat, 'project_other'))
      .status,
    400,
  );
  assert.equal(
    (
      await f.request(
        '/sessions/runners/heartbeat',
        token,
        'POST',
        { ...heartbeat, actorId: f.owner.actorId },
        f.projectId,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        '/sessions/runners/heartbeat',
        token,
        'POST',
        { ...heartbeat, managed: { allocationId: 'other' } },
        f.projectId,
      )
    ).status,
    400,
  );
});

test('enrollment rejects spoofed fields and managed caller cannot reach registry or general Scope authority', async (t) => {
  const f = await fixture(t);
  for (const workerNonce of ['', 'A'.repeat(64), randomBytes(32).toString('base64url')]) {
    assert.equal(
      (
        await f.request(
          '/sessions/runners/enroll',
          f.enrollmentToken,
          'POST',
          { workerNonce },
          f.projectId,
        )
      ).status,
      400,
    );
  }
  assert.equal(
    (
      await f.request(
        '/sessions/runners/enroll',
        f.enrollmentToken,
        'POST',
        { actorId: f.owner.actorId },
        f.projectId,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        '/sessions/runners/enroll',
        f.enrollmentToken,
        'POST',
        { projectId: f.projectId },
        f.projectId,
      )
    ).status,
    400,
  );
  assert.equal(
    (await f.request('/sessions/runners/enroll', f.enrollmentToken, 'POST', {}, 'project_other'))
      .status,
    400,
  );
  assert.equal((await f.request('/projects', f.enrollmentToken, 'GET')).status, 403);
  const enrolled = await f.request(
    '/sessions/runners/enroll',
    f.enrollmentToken,
    'POST',
    { workerNonce: f.workerNonce },
    f.projectId,
  );
  assert.equal(enrolled.status, 200);
  const caller = await f.app.ctx.sessions.authenticateManaged(enrolled.body.controlToken);
  await assert.rejects(f.app.ctx.scope.delegationSource(caller), {
    code: 'managed_runner_forbidden',
  });
  await assert.rejects(f.app.ctx.tools.describe(caller), { code: 'managed_runner_forbidden' });
  await assert.rejects(f.app.ctx.tools.invoke('task.create', caller, {}), {
    code: 'managed_runner_forbidden',
  });
});

/**
 * The API's credential gate over stand-in owners that accept every well-formed token: which
 * owner each bearer reaches, and what is refused before any owner is asked. `changes` names the
 * step of the API plan that changes a row on purpose; every other row must hold.
 */
async function credentialGate(t: TestContext) {
  const reached: string[] = [];
  const reach =
    (name: string, value: unknown = {}) =>
    async () => {
      reached.push(name);
      return value;
    };
  const managed: Caller = {
    actorId: 'runner',
    projectId: 'project',
    managed: { allocationId: 'allocation', epoch: 1, credentialHash: 'hash' },
  };
  const session: Caller = { actorId: 'worker', projectId: 'project', session: { id: 'session_1' } };
  const actor = { id: 'owner', projectId: 'project', name: 'Owner', role: 'owner', active: true };
  const scope = {
    require: async () => actor,
    caller: async () => ({ actorId: actor.id, projectId: actor.projectId }),
    authenticate: async (token: string) => {
      if (token !== 'actor-token') throw new MervError('unauthorized', 'Invalid token', 401);
      return actor;
    },
    authenticateKey: async () => {
      throw new MervError('unauthorized', 'Invalid key', 401);
    },
    projects: async () => [],
  } as unknown as Scope;
  const tools = {
    describe: reach('tools.describe', []),
    invoke: reach('tools.invoke', { format: 'json', value: null }),
  } as unknown as Tools;
  const identity: IdentityProvider = {
    verify: async () => {
      reached.push('identity.verify');
      throw new MervError('unauthorized', 'Invalid token', 401);
    },
    configuration: () => ({ enabled: false }) as ReturnType<IdentityProvider['configuration']>,
  };
  const sessions = {
    ...Object.fromEntries(
      [
        'describe',
        'lease',
        'heartbeatRunner',
        'get',
        'attach',
        'heartbeat',
        'release',
        'workspaceResult',
        'projectStatus',
        'assignAgent',
        'releaseAgentAssignment',
        'resetAgentContext',
      ].map((name) => [name, reach(`sessions.${name}`)]),
    ),
    authenticate: reach('sessions.authenticate', session),
    authenticateManaged: reach('sessions.authenticateManaged', managed),
    enrollManaged: reach('sessions.enrollManaged', { controlToken: 'mr_new', caller: managed }),
    agentSelf: async (token: string) => {
      reached.push('sessions.agentSelf');
      if (!token.startsWith('ms_')) throw new MervError('unauthorized', 'Invalid agent key', 401);
      return {};
    },
  } as unknown as SessionApiProvider;
  const code = {
    nextCommand: reach('code.nextCommand', null),
    completeCommand: reach('code.completeCommand'),
    github: { callback: reach('code.github.callback', '/') },
    v2: { call: reach('code.v2.call'), putPart: reach('code.v2.putPart') },
  } as unknown as CodeApiProvider;
  let snapshots = 0;
  const api = new ApiServer(
    scope,
    tools,
    {
      snapshot: (fn) => {
        snapshots++;
        return fn();
      },
    },
    identity,
  );
  for (const prefix of ['/ui', '/pi-worker', '/pi-model', '/codex-model'])
    api.mount(prefix, (_req, res) => {
      reached.push(prefix);
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
  const withdraw = { sessions: api.registerSessions(sessions), code: api.registerCode(code) };
  const url = await api.start();
  t.after(() => api.stop());
  const request = async (method: string, path: string, token: string, body?: unknown) => {
    reached.length = 0;
    const octets = Buffer.isBuffer(body);
    const response = await fetch(`${url}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
        ...(body === undefined
          ? {}
          : { 'content-type': octets ? 'application/octet-stream' : 'application/json' }),
      },
      ...(body === undefined ? {} : { body: octets ? new Uint8Array(body) : JSON.stringify(body) }),
    });
    const text = await response.text();
    let code: string | undefined;
    try {
      code = JSON.parse(text).error?.code;
    } catch {}
    return { status: response.status, code, reached: [...reached] };
  };
  return { request, withdraw, snapshots: () => snapshots };
}

type GateRow = {
  bearer: 'mr_' | 'me_' | 'ms_' | 'ms_bad.jwt.token';
  method: string;
  path: string;
  body?: unknown;
  /** The owner the request reaches, or the status and code it is refused with first. */
  reaches?: string;
  refused?: [number, string];
  changes?: 'step 8' | 'step 12' | 'step 13';
};

const bearers = {
  mr_: `mr_${'a'.repeat(64)}`,
  me_: `me_${'b'.repeat(64)}`,
  ms_: `ms_${'c'.repeat(50)}`,
  'ms_bad.jwt.token': 'ms_bad.jwt.token',
};
const control = { sessionId: 'session_1', runnerId: 'runner', hostRef: 'host' };
const listTools = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
const managedForbidden: [number, string] = [403, 'managed_runner_forbidden'];
const sessionForbidden: [number, string] = [403, 'session_transport_forbidden'];

const ownersPresent: GateRow[] = [
  // A managed runner reaches exactly its control routes.
  ...(
    [
      ['POST', '/sessions/runners/heartbeat', 'sessions.heartbeatRunner'],
      ['POST', '/sessions/lease', 'sessions.lease'],
      ['GET', '/sessions/session_1', 'sessions.get'],
      ['POST', '/sessions/session_1/attach', 'sessions.attach'],
      ['POST', '/sessions/session_1/heartbeat', 'sessions.heartbeat'],
      ['POST', '/sessions/session_1/release', 'sessions.release'],
      ['POST', '/sessions/session_1/workspace-result', 'sessions.workspaceResult'],
      ['POST', '/code/v2/uploads/begin', 'code.v2.call'],
    ] as const
  ).map(([method, path, reaches]): GateRow => ({
    bearer: 'mr_',
    method,
    path,
    ...(method === 'POST' && { body: {} }),
    reaches,
  })),
  {
    bearer: 'mr_',
    method: 'POST',
    path: '/code/commands/next',
    body: control,
    reaches: 'code.nextCommand',
  },
  {
    bearer: 'mr_',
    method: 'POST',
    path: '/code/commands/complete',
    body: { ...control, commandId: 'command', error: 'failed' },
    reaches: 'code.completeCommand',
  },
  {
    bearer: 'mr_',
    method: 'PUT',
    path: '/code/v2/uploads/operation_1/parts/0',
    body: Buffer.from('part'),
    reaches: 'code.v2.putPart',
  },
  // Every other authenticated route, and any query, is refused before authentication.
  ...(
    [
      ['GET', '/tools'],
      ['POST', '/tools/echo'],
      ['POST', '/mcp'],
      ['GET', '/account'],
      ['GET', '/projects'],
      ['GET', '/sessions'],
      ['GET', '/sessions/status'],
      ['POST', '/sessions/halt'],
      ['POST', '/sessions/lease?probe=1'],
      ['POST', '/code/transport/grant'],
      ['GET', '/nowhere'],
    ] as const
  ).map(([method, path]): GateRow => ({ bearer: 'mr_', method, path, refused: managedForbidden })),
  // Routes that authenticate themselves refuse a managed bearer in the API today.
  ...(
    [
      ['GET', '/ui'],
      ['GET', '/pi-worker/claim'],
      ['POST', '/pi-model/responses'],
      ['POST', '/codex-model/responses'],
      ['GET', '/sessions/self'],
      ['POST', '/sessions/runners/enroll'],
    ] as const
  ).map(([method, path]): GateRow => ({
    bearer: 'mr_',
    method,
    path,
    refused: managedForbidden,
    changes: 'step 8',
  })),
  // GitHub's callback is served before any credential is looked at.
  { bearer: 'mr_', method: 'GET', path: '/code/github/callback', reaches: 'code.github.callback' },
  // An enrollment credential only enrolls.
  {
    bearer: 'me_',
    method: 'POST',
    path: '/sessions/runners/enroll',
    body: {},
    reaches: 'sessions.enrollManaged',
  },
  ...(
    [
      ['GET', '/tools'],
      ['POST', '/mcp'],
      ['GET', '/projects'],
      ['POST', '/sessions/lease'],
      ['GET', '/sessions/runners/enroll'],
    ] as const
  ).map(([method, path]): GateRow => ({ bearer: 'me_', method, path, refused: managedForbidden })),
  ...(
    [
      ['GET', '/ui'],
      ['GET', '/sessions/self'],
    ] as const
  ).map(([method, path]): GateRow => ({
    bearer: 'me_',
    method,
    path,
    refused: managedForbidden,
    changes: 'step 8',
  })),
  { bearer: 'me_', method: 'GET', path: '/code/github/callback', reaches: 'code.github.callback' },
  // A session credential uses only POST /mcp; an agent key its own routes.
  { bearer: 'ms_', method: 'POST', path: '/mcp', body: listTools, reaches: 'tools.describe' },
  ...(
    [
      ['GET', '/tools'],
      ['POST', '/tools/echo'],
      ['GET', '/mcp'],
      ['GET', '/account'],
      ['GET', '/sessions/status'],
      ['POST', '/sessions/lease'],
    ] as const
  ).map(([method, path]): GateRow => ({ bearer: 'ms_', method, path, refused: sessionForbidden })),
  { bearer: 'ms_', method: 'GET', path: '/sessions/self', reaches: 'sessions.agentSelf' },
  {
    bearer: 'ms_',
    method: 'POST',
    path: '/sessions/self/assignment',
    body: {},
    reaches: 'sessions.assignAgent',
  },
  {
    bearer: 'ms_',
    method: 'POST',
    path: '/sessions/self/release',
    body: { executionId: 'execution' },
    reaches: 'sessions.releaseAgentAssignment',
  },
  {
    bearer: 'ms_',
    method: 'POST',
    path: '/sessions/self/context-reset',
    body: { reason: 'fresh start' },
    reaches: 'sessions.resetAgentContext',
  },
  // A worker's model relay authenticates the session secret itself.
  {
    bearer: 'ms_',
    method: 'POST',
    path: '/codex-model/responses',
    body: {},
    reaches: '/codex-model',
  },
  { bearer: 'ms_', method: 'GET', path: '/ui', reaches: '/ui' },
];

// A runner treats 401 and 403 as final, so an absent owner must answer 503.
const sessionsAbsent: GateRow[] = [
  {
    bearer: 'ms_',
    method: 'POST',
    path: '/mcp',
    body: listTools,
    refused: [503, 'session_unavailable'],
    changes: 'step 13',
  },
  {
    bearer: 'mr_',
    method: 'POST',
    path: '/sessions/lease',
    body: {},
    refused: [503, 'session_unavailable'],
    changes: 'step 13',
  },
  {
    bearer: 'me_',
    method: 'POST',
    path: '/sessions/runners/enroll',
    body: {},
    refused: [503, 'session_unavailable'],
    changes: 'step 13',
  },
  // Never JWT verification.
  {
    bearer: 'ms_bad.jwt.token',
    method: 'POST',
    path: '/mcp',
    body: listTools,
    refused: [503, 'session_unavailable'],
    changes: 'step 13',
  },
];
const codeAbsent: GateRow[] = [
  {
    bearer: 'mr_',
    method: 'POST',
    path: '/code/commands/next',
    body: control,
    refused: [503, 'code_unavailable'],
    changes: 'step 12',
  },
];

async function checkRows(
  request: Awaited<ReturnType<typeof credentialGate>>['request'],
  rows: GateRow[],
) {
  for (const row of rows) {
    const label = `${row.bearer} ${row.method} ${row.path}`;
    const result = await request(row.method, row.path, bearers[row.bearer], row.body);
    if (row.reaches) {
      assert.ok(result.status < 400, `${label}: ${JSON.stringify(result)}`);
      assert.ok(result.reached.includes(row.reaches), `${label}: ${JSON.stringify(result)}`);
    } else {
      assert.deepEqual([result.status, result.code], row.refused, label);
      // A 403 comes before authentication, so it reaches nothing.
      if (row.refused![0] === 403) assert.deepEqual(result.reached, [], label);
      // An absent owner is never asked; authentication may have run first.
      else
        assert.ok(
          result.reached.every((owner) => owner === 'sessions.authenticateManaged'),
          `${label} reached ${result.reached}`,
        );
    }
  }
}

test('credential confinement: each bearer reaches only its owner, and an absent owner answers 503', async (t) => {
  const gate = await credentialGate(t);
  await checkRows(gate.request, ownersPresent);
  gate.withdraw.code();
  await checkRows(gate.request, codeAbsent);
  gate.withdraw.sessions();
  await checkRows(gate.request, sessionsAbsent);
});

test('agent routes match before authenticating, and authenticate before any body', async (t) => {
  const gate = await credentialGate(t);
  const unknown = await gate.request('POST', '/sessions/self/nope', bearers.ms_, {});
  assert.deepEqual([unknown.status, unknown.code, unknown.reached], [404, 'not_found', []]);
  const wrongMethod = await gate.request('GET', '/sessions/self/release', bearers.ms_);
  assert.deepEqual([wrongMethod.status, wrongMethod.reached], [404, []]);
  // A bad key is refused before its body is read: this body would otherwise be a 415.
  const bad = await gate.request(
    'POST',
    '/sessions/self/release',
    'not-an-agent',
    Buffer.from('x'),
  );
  assert.deepEqual(
    [bad.status, bad.code, bad.reached],
    [401, 'unauthorized', ['sessions.agentSelf']],
  );
  // Only the agent's own routes skip API authentication and the read snapshot.
  assert.equal((await gate.request('GET', '/sessions/self', bearers.ms_)).status, 200);
  assert.equal(gate.snapshots(), 0);
  const selfish = await gate.request('GET', '/sessions/selfish', 'not-a-credential');
  assert.deepEqual([selfish.status, selfish.reached], [401, []]);
  assert.equal((await gate.request('GET', '/sessions/selfish', 'actor-token')).status, 404);
  assert.equal(gate.snapshots(), 1);
});
