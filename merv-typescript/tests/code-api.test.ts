import { createService } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { Context } from 'cordis';
import { SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import {
  MervError,
  type Caller,
  type CodeCommandCompletion,
  type CodeCommandControl,
  type CodeCommandRecord,
  type CodeCommitCommand,
  type CodeCommitReceipt,
} from '@merv/contracts';
import { ApiServer } from '../packages/api/src/http.js';
import { ToolRegistry } from '../packages/api/src/registry.js';
import type { CodeApiProvider } from '../packages/api/src/types.js';
import codeApiPlugin from '../packages/code/src/api.js';

const control: CodeCommandControl = {
  sessionId: 'session_fixture',
  runnerId: 'runner_fixture',
  hostRef: 'launch_fixture',
};
const receipt: CodeCommitReceipt = {
  commandId: 'command_fixture',
  repositoryId: 'repository_fixture',
  workspaceId: 'workspace_fixture',
  baseOid: '1'.repeat(40),
  parentOid: '1'.repeat(40),
  headOid: '2'.repeat(40),
  treeOid: '3'.repeat(40),
  stats: { commitCount: 1, filesChanged: 1, insertions: 1, deletions: 1 },
};

async function fixture(t: TestContext, maxBodyBytes?: number) {
  const state = new SqliteState(':memory:');
  const scope = await createService(new ProjectScope(state));
  const boot = await scope.bootstrap({ projectName: 'Code controls', actorName: 'Controller' });
  const caller = await scope.caller({ kind: 'actor', actor: await scope.authenticate(boot.token) });
  const tools = new ToolRegistry(scope);
  const api = new ApiServer(scope, tools, { port: 0, maxBodyBytes });
  const url = await api.start();
  t.after(async () => {
    await api.stop();
    await tools.close();
    await state.close();
  });
  const command: CodeCommitCommand = {
    id: receipt.commandId,
    projectId: caller.projectId,
    actorId: 'worker_fixture',
    instanceId: 'workflow_fixture',
    expectedRevision: 0,
    ...control,
    expectedHead: receipt.parentOid,
    message: 'Capture the code proposal',
    createdAt: '2026-09-15T00:00:00.000Z',
    workspace: {
      repositoryId: receipt.repositoryId,
      workspaceId: receipt.workspaceId,
      mode: 'persistent',
      branch: 'codex/work',
      baseOid: receipt.baseOid,
      headOid: receipt.parentOid,
      stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
    },
  };
  const calls: { method: 'next' | 'complete'; caller: Caller; input: unknown }[] = [];
  const provider: CodeApiProvider = {
    async nextCommand(caller, input) {
      calls.push({ method: 'next', caller: structuredClone(caller), input });
      return command;
    },
    async completeCommand(caller, input) {
      calls.push({ method: 'complete', caller: structuredClone(caller), input });
      return {
        command,
        status: input.receipt ? 'succeeded' : 'failed',
        receipt: input.receipt ?? null,
        error: input.error ?? null,
      };
    },
  };
  async function request(
    route: 'next' | 'complete' | string,
    body: unknown = control,
    options: {
      token?: string | null;
      method?: string;
      projectId?: string;
      raw?: string;
      contentType?: string;
    } = {},
  ) {
    const response = await fetch(`${url}/code/commands/${route}`, {
      method: options.method ?? 'POST',
      headers: {
        ...(options.token === null
          ? {}
          : { authorization: `Bearer ${options.token ?? boot.token}` }),
        'content-type': options.contentType ?? 'application/json',
        ...(options.projectId === undefined ? {} : { 'x-merv-project-id': options.projectId }),
      },
      ...(['GET', 'HEAD'].includes(options.method ?? '')
        ? {}
        : { body: options.raw ?? JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: (await response.json()) as any,
      allow: response.headers.get('allow'),
    };
  }
  return { state, scope, boot, caller, tools, api, url, command, provider, calls, request };
}

test('Code controls pass the authenticated source and exact command envelope, including null and failure results', async (t) => {
  const f = await fixture(t);
  const dispose = f.api.registerCode(f.provider);
  t.after(dispose);
  assert.deepEqual(await f.request('next'), {
    status: 200,
    body: { command: f.command },
    allow: null,
  });
  const completion: CodeCommandCompletion = { ...control, commandId: receipt.commandId, receipt };
  const completed = await f.request('complete', completion);
  assert.equal(completed.status, 200);
  assert.equal(completed.body.operation.status, 'succeeded');
  assert.deepEqual(completed.body.operation.receipt, receipt);
  const failed = await f.request('complete', {
    ...control,
    commandId: receipt.commandId,
    error: 'git_conflict',
  });
  assert.equal(failed.status, 200);
  assert.equal(failed.body.operation.status, 'failed');
  assert.equal(failed.body.operation.error, 'git_conflict');
  assert.deepEqual(
    f.calls.map((call) => call.caller),
    [f.caller, f.caller, f.caller],
  );
  assert.deepEqual(f.calls[0]!.input, control);
  assert.deepEqual(f.calls[1]!.input, completion);
  f.provider.nextCommand = async () => null;
  assert.deepEqual((await f.request('next')).body, { command: null });
});

test('Code source selection uses real machine-key membership and rejects body/project/auth substitutions', async (t) => {
  const f = await fixture(t);
  f.api.registerCode(f.provider);
  const owner = await f.scope.acceptVerifiedIdentity({
    issuer: 'https://identity.example/auth/v1',
    subject: 'code-owner',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  const first = await f.scope.createProject(owner, { name: 'First', requestId: 'first' });
  const second = await f.scope.createProject(owner, { name: 'Second', requestId: 'second' });
  const issued = await f.scope.createKey(owner, { projectId: first.id, grantScope: 'account' });
  const key = await f.scope.authenticateKey(issued.token);
  assert.equal((await f.request('next', control, { token: issued.token })).status, 400);
  for (const project of [first, second]) {
    assert.equal(
      (await f.request('next', control, { token: issued.token, projectId: project.id })).status,
      200,
    );
    assert.deepEqual(
      f.calls.at(-1)!.caller,
      await f.scope.caller({ kind: 'key', key }, project.id),
    );
  }
  const before = f.calls.length;
  for (const [body, options] of [
    [
      { ...control, actorId: f.caller.actorId },
      { token: issued.token, projectId: first.id },
    ],
    [
      { ...control, projectId: second.id },
      { token: issued.token, projectId: first.id },
    ],
    [control, { projectId: second.id }],
    [control, { token: null }],
    [control, { token: 'not-a-credential' }],
  ] as const)
    assert.ok((await f.request('next', body, options)).status >= 400);
  assert.equal(f.calls.length, before);
  await f.scope.revokeKey(owner, key.id);
  assert.equal(
    (await f.request('next', control, { token: issued.token, projectId: first.id })).status,
    401,
  );
  assert.equal(f.calls.length, before);
});

test('Code controls remain unavailable without the optional provider and cannot be replaced by an unauthenticated mount', async (t) => {
  const f = await fixture(t);
  assert.throws(
    () =>
      f.api.mount('/code', async (_req, res) => {
        res.end('wrong');
      }),
    {
      code: 'invalid_mount',
    },
  );
  assert.equal((await f.request('next')).body.error.code, 'code_unavailable');
  const first = f.api.registerCode(f.provider);
  assert.throws(() => f.api.registerCode(f.provider), { code: 'code_provider_conflict' });
  first();
  assert.equal(
    (await f.request('complete', { ...control, commandId: receipt.commandId, receipt })).status,
    503,
  );
  const second = f.api.registerCode(f.provider);
  first();
  assert.equal(
    (await f.request('next')).status,
    200,
    'A stale disposer cannot remove a later registration of the same provider',
  );
  second();
  assert.throws(
    () =>
      f.api.mount('/code', async (_req, res) => {
        res.end();
      }),
    { code: 'invalid_mount' },
  );
  for (const token of [`ms_${'s'.repeat(43)}`, 'ms_reserved']) {
    const denied = await f.request('next', control, { token });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'session_transport_forbidden');
  }
  assert.equal(f.calls.length, 1);
});

test('Code routes enforce strict schemas, bounded JSON, POST-only methods and provider errors', async (t) => {
  const f = await fixture(t, 2048);
  f.api.registerCode(f.provider);
  for (const body of [
    null,
    [],
    { sessionId: control.sessionId },
    { ...control, argv: [] },
    { ...control, hostRef: '/tmp/escape' },
  ])
    assert.equal((await f.request('next', body)).body.error.code, 'invalid_input');
  for (const body of [
    { ...control, commandId: receipt.commandId },
    { ...control, commandId: receipt.commandId, receipt, error: 'ambiguous' },
    { ...control, commandId: receipt.commandId, error: 'raw error message' },
    { ...control, commandId: receipt.commandId, receipt: { ...receipt, executable: '/bin/sh' } },
    { ...control, commandId: receipt.commandId, receipt: { ...receipt, headOid: '2'.repeat(64) } },
  ])
    assert.equal((await f.request('complete', body)).body.error.code, 'invalid_input');
  assert.equal((await f.request('next?projectId=elsewhere')).status, 400);
  assert.equal(
    (await f.request('next', control, { raw: '{invalid' })).body.error.code,
    'invalid_json',
  );
  assert.equal((await f.request('next', control, { contentType: 'text/plain' })).status, 415);
  assert.equal(
    (await f.request('next', control, { raw: JSON.stringify({ extra: 'x'.repeat(2048) }) })).status,
    413,
  );
  const get = await f.request('next', undefined, { method: 'GET' });
  assert.equal(get.status, 405);
  assert.equal(get.allow, 'POST');
  assert.equal(f.calls.length, 0);
  f.provider.nextCommand = async (_caller, input) => {
    if (input.sessionId !== control.sessionId)
      throw new MervError('code_session_mismatch', 'Command belongs to another session', 403);
    return f.command;
  };
  const wrongSession = await f.request('next', { ...control, sessionId: 'another_session' });
  assert.equal(wrongSession.status, 403);
  assert.equal(wrongSession.body.error.code, 'code_session_mismatch');
});

async function bodyWait(f: Awaited<ReturnType<typeof fixture>>) {
  let admitted!: () => void;
  const started = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  const original = f.scope.require.bind(f.scope);
  f.scope.require = async (...args) => {
    const result = await original(...args);
    admitted();
    return result;
  };
  const body = JSON.stringify(control);
  let request!: Awaited<ReturnType<typeof httpRequest>>;
  const response = new Promise<{ status: number; body: any }>((resolve, reject) => {
    request = httpRequest(
      `${f.url}/code/commands/next`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${f.boot.token}`, 'content-type': 'application/json' },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode!,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          }),
        );
      },
    );
    request.on('error', reject);
    request.write(body.slice(0, 1));
  });
  await started;
  return { finish: () => request.end(body.slice(1)), response };
}

test(
  'Code adapter unload withdraws controls while a request body is still arriving',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    const ctx = new Context();
    ctx.provide('api', f.api);
    ctx.provide('code', {
      ...f.provider,
      commit: () => {
        throw new Error('Not a transport operation');
      },
      operation: (): CodeCommandRecord => ({
        command: f.command,
        status: 'queued',
        receipt: null,
        error: null,
      }),
      close() {},
    });
    t.after(() => ctx.fiber.dispose());
    const adapter = await ctx.plugin(codeApiPlugin);
    await adapter.await();
    assert.equal((await f.request('next')).status, 200);
    const waiting = await bodyWait(f);
    await adapter.dispose();
    waiting.finish();
    const result = await waiting.response;
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'code_unavailable');
    assert.equal(f.calls.length, 1, 'A withdrawn provider must not receive the delayed request');
  },
);

test(
  'Code controls recheck source credentials after an awaited request body',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    f.api.registerCode(f.provider);
    const admin = await f.scope.issueActor(f.caller, { name: 'Second operator', role: 'operator' });
    const adminCaller = await f.scope.caller({
      kind: 'actor',
      actor: await f.scope.authenticate(admin.token),
    });
    const waiting = await bodyWait(f);
    await f.scope.revokeCredential(adminCaller, f.caller.credentialId!);
    waiting.finish();
    const result = await waiting.response;
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, 'forbidden');
    assert.equal(f.calls.length, 0);
  },
);

test('GitHub publication and transport HTTP routes enforce authentication, project scope, closed inputs and adapter withdrawal', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  f.provider.publications = async (caller) => {
    assert.equal(caller.projectId, f.caller.projectId);
    calls++;
    return [];
  };
  f.provider.syncPublications = async () => {
    calls++;
    return [];
  };
  f.provider.publicationDetails = async () => {
    throw new Error('unused');
  };
  f.provider.mergePublication = async () => {
    throw new Error('unused');
  };
  f.provider.transportGrant = async () => {
    throw new Error('unused');
  };
  f.provider.verifyTransport = async () => {
    throw new Error('unused');
  };
  const dispose = f.api.registerCode(f.provider);
  t.after(dispose);
  const headers = { authorization: `Bearer ${f.boot.token}`, 'content-type': 'application/json' };
  assert.equal((await fetch(`${f.url}/code/publications`)).status, 401);
  assert.equal((await fetch(`${f.url}/code/publications`, { headers })).status, 200);
  assert.equal(
    (
      await fetch(`${f.url}/code/publications`, {
        headers: { ...headers, 'x-merv-project-id': 'other' },
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(`${f.url}/code/publications/sync`, { method: 'POST', headers, body: '{}' }))
      .status,
    200,
  );
  assert.equal(
    (
      await fetch(`${f.url}/code/publications/sync`, {
        method: 'POST',
        headers,
        body: '{"repository":"evil/other"}',
      })
    ).status,
    400,
  );
  assert.equal(
    (await fetch(`${f.url}/code/publications/merge`, { method: 'POST', headers, body: '{}' }))
      .status,
    400,
  );
  assert.equal(
    (await fetch(`${f.url}/code/transport/grant`, { method: 'POST', headers, body: '{}' })).status,
    400,
  );
  assert.equal(
    (await fetch(`${f.url}/code/transport/grant`, { method: 'POST', body: '{}' })).status,
    401,
  );
  assert.equal(calls, 2);
  dispose();
  assert.equal((await fetch(`${f.url}/code/publications`, { headers })).status, 503);
  assert.equal(
    (
      await fetch(`${f.url}/code/transport/grant`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...control, operation: 'fetch' }),
      })
    ).status,
    503,
  );
  assert.equal(calls, 2);
});
