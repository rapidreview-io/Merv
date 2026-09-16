import { mapAsync } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Caller, WorkflowPolicy } from '@merv/contracts';
import { createApp } from '../src/app.js';
import type { ApplicationConfig } from '../src/config.js';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-claims-api-'));
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as ApplicationConfig;
  config.plugins.find((e) => e.id === 'ui')!.config = { assets: join(directory, 'unused-assets') };
  const app = await createApp({ directory, config, port: 0 });
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.allSettled(clients.map((c) => c.close()));
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({
    projectName: 'Claims HTTP integration',
    actorName: 'Owner',
  });
  const source: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const producer = await app.ctx.scope.issueActor(source, { name: 'Producer', role: 'producer' });
  const reader = await app.ctx.scope.issueActor(source, { name: 'Reader', role: 'reader' });
  const http = async (
    tool: string,
    input: unknown = {},
    token: string | null = producer.token,
    projectId?: string,
  ) => {
    const response = await fetch(app.ctx.api.url + '/tools/' + tool, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(projectId ? { 'x-merv-project-id': projectId } : {}),
      },
      body: JSON.stringify(input),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const connect = async (token: string) => {
    const client = new Client({ name: 'Claims acceptance', version: '1' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(app.ctx.api.url + '/mcp'), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  };
  const mcp = async (client: Client, name: string, input: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: input });
    return {
      result,
      value: JSON.parse((result.content as { type: string; text: string }[])[0].text),
    };
  };
  return { directory, app, boot, source, producer, reader, http, connect, mcp };
}

test('Claims strict HTTP tools preserve tenant, permission, CAS and replay semantics', async (t) => {
  const f = await fixture(t);
  const created = await f.http('claim.create', {
    statement: '  The measured effect is positive.  ',
    requestId: 'claim',
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const claim = created.body.result;
  assert.equal(claim.statement, 'The measured effect is positive.');
  assert.equal(claim.scope, '');
  assert.equal(claim.status, 'active');
  assert.equal(claim.confidence, 'medium');
  assert.equal(claim.createdBy, f.producer.actor.id);
  assert.deepEqual((await f.http('claim.list', {}, f.reader.token)).body.result, [claim]);
  const changed = await f.http('claim.update', {
    claimId: claim.id,
    status: 'supported',
    confidence: 'high',
    expectedRevision: 0,
    requestId: 'support',
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.result.revision, 1);
  const stale = await f.http('claim.update', {
    claimId: claim.id,
    status: 'contradicted',
    expectedRevision: 0,
    requestId: 'stale',
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'claim_revision_conflict');
  assert.deepEqual(
    (
      await f.http('claim.create', {
        statement: claim.statement,
        scope: '',
        confidence: 'medium',
        requestId: 'claim',
      })
    ).body.result,
    claim,
  );
  assert.equal(
    (
      await f.http(
        'claim.create',
        { statement: 'Reader cannot write', requestId: 'reader' },
        f.reader.token,
      )
    ).status,
    403,
  );
  assert.equal((await f.http('claim.list', {}, null)).status, 401);
  for (const [tool, input] of [
    [
      'claim.create',
      { statement: 'Cannot set initial status', status: 'supported', requestId: 'strict' },
    ],
    [
      'claim.create',
      { statement: 'Cannot set provenance', createdBy: f.boot.actor.id, requestId: 'strict' },
    ],
    [
      'claim.update',
      { claimId: claim.id, statement: 'Cannot edit', expectedRevision: 1, requestId: 'strict' },
    ],
    ['claim.update', { claimId: claim.id, expectedRevision: 1, requestId: 'strict' }],
    [
      'claim.update',
      { claimId: claim.id, status: 'invented', expectedRevision: 1, requestId: 'strict' },
    ],
    ['claim.list', { status: 'active' }],
  ] as const)
    assert.equal((await f.http(tool, input)).status, 400);
  const other = await f.app.ctx.scope.bootstrap({
    projectName: 'Another tenant',
    actorName: 'Owner',
  });
  assert.deepEqual((await f.http('claim.list', {}, other.token)).body.result, []);
  assert.equal(
    (
      await f.http(
        'claim.update',
        { claimId: claim.id, status: 'abandoned', expectedRevision: 1, requestId: 'foreign' },
        other.token,
      )
    ).status,
    404,
  );
  assert.equal((await f.http('claim.list', {}, f.producer.token, other.project.id)).status, 403);
  await f.app.ctx.scope.revokeCredential(f.source, f.producer.credential.id);
  assert.equal(
    (await f.http('claim.create', { statement: claim.statement, requestId: 'claim' })).status,
    401,
  );
  assert.equal((await f.http('claim.list', {}, f.reader.token)).body.result[0].revision, 1);
});

test('Claims MCP and UI registrations withdraw with Cordis provider and restore durable data on reload', async (t) => {
  const f = await fixture(t),
    client = await f.connect(f.producer.token);
  const descriptions = (await client.listTools()).tools.filter((t) => t.name.startsWith('claim.'));
  assert.deepEqual(descriptions.map((t) => t.name).sort(), [
    'claim.create',
    'claim.list',
    'claim.update',
  ]);
  assert.equal(descriptions.find((t) => t.name === 'claim.list')!.annotations?.readOnlyHint, true);
  const made = await f.mcp(client, 'claim.create', {
    statement: 'A claim across hot reload.',
    requestId: 'hot-reload',
  });
  assert.notEqual(made.result.isError, true);
  const claim = made.value;
  const shell = (await f.http('ui.shell', {}, f.reader.token)).body.result;
  const row = shell.rows.find((r: any) => r.id === 'claims');
  assert.ok(row);
  assert.equal(row.view.kind, 'claims');
  assert.deepEqual(row.status, {}, 'a claim book is consulted, so its row carries no count');
  const old = f.app.ctx.claims;
  await f.app.setEnabled('claims', false);
  assert.equal(
    (await client.listTools()).tools.some((t) => t.name.startsWith('claim.')),
    false,
  );
  const unavailable = await f.mcp(client, 'claim.list');
  assert.equal(unavailable.result.isError, true);
  assert.equal(
    (await f.http('ui.shell', {}, f.reader.token)).body.result.rows.some(
      (r: any) => r.id === 'claims',
    ),
    false,
  );
  await assert.rejects(async () => await old.list(f.source), { status: 503 });
  assert.equal(
    (await f.http('actor.list', {}, f.boot.token)).status,
    200,
    'Unrelated provider remains available',
  );
  await f.app.setEnabled('claims', true);
  assert.deepEqual((await f.mcp(client, 'claim.list')).value, [claim]);
  assert.deepEqual(
    (
      await f.mcp(client, 'claim.create', {
        statement: 'A claim across hot reload.',
        requestId: 'hot-reload',
      })
    ).value,
    claim,
  );
  assert.deepEqual(
    (await f.http('ui.shell', {}, f.reader.token)).body.result.rows.find(
      (r: any) => r.id === 'claims',
    ).status,
    {},
  );
  assert.notEqual(f.app.ctx.claims, old);
});

test('real leased workers receive only fixed Claims tools, preserve worker provenance and lose access on source revocation', async (t) => {
  const f = await fixture(t);
  const claim = (await f.http('claim.create', { statement: 'Pinned target', requestId: 'target' }))
    .body.result;
  const rule: WorkflowPolicy = {
    actions: [
      {
        name: 'finish',
        states: ['work'],
        transitions: ['finish'],
        tool: 'fixture.finish',
        instruction: 'Finish the fixture.',
        check: async ({ caller, tx }) => {
          await f.app.ctx.scope.require(caller, 'write', tx);
        },
      },
    ],
    assignments: [
      {
        state: 'work',
        check: async ({ caller, tx }) => {
          await f.app.ctx.scope.require(caller, 'write', tx);
        },
        build: async () => ({
          role: 'producer',
          label: 'Update one assigned claim',
          brief: 'Use the fixed claim target.',
          references: [],
          handoff: { instruction: 'Stop.', tools: [] },
          execution: { readOnly: false, tools: [] },
          context: null,
        }),
        execution: {
          readOnly: false,
          tools: [
            { name: 'claim.list', alternatives: [{}] },
            {
              name: 'claim.update',
              alternatives: [{ claimId: { kind: 'reference', name: 'claimId' } }],
            },
          ],
        },
        references: () => ({ claimId: claim.id }),
        lease: {
          role: async (): Promise<'operator' | 'producer' | 'reviewer' | 'reader'> => 'producer',
          acquire: async () => ({}),
          check: async () => {},
          release: async () => {},
        },
      },
    ],
  };
  const handle = await f.app.ctx.workflows.register(
    {
      name: 'claims-session-fixture',
      version: 1,
      initial: 'work',
      states: ['work', 'done'],
      terminal: ['done'],
      edges: [{ from: 'work', action: 'finish', to: 'done' }],
    },
    rule,
  );
  const source = {
    actorId: f.producer.actor.id,
    projectId: f.source.projectId,
    credentialId: f.producer.credential.id,
  };
  const instance = await handle.start(source, {
    workflow: 'claims-session-fixture',
    requestId: 'start',
  });
  const secret = 'ms_' + randomBytes(32).toString('base64url');
  const session = await f.app.ctx.sessions.offer(source, {
    instanceId: instance.id,
    expectedRevision: 0,
    runnerId: 'fixture-runner',
    requestId: 'lease',
    secret,
  });
  const client = await f.connect(secret);
  assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), [
    'claim.list',
    'claim.update',
  ]);
  const changed = await f.mcp(client, 'claim.update', {
    status: 'weakened',
    expectedRevision: 0,
    requestId: 'worker-update',
  });
  assert.notEqual(changed.result.isError, true, JSON.stringify(changed.result));
  assert.equal(changed.value.id, claim.id);
  assert.equal(changed.value.createdBy, f.producer.actor.id);
  assert.equal(changed.value.updatedBy, session.actorId);
  const event = (await f.app.ctx.state.events(f.source.projectId)).find(
    (e) => e.type === 'claim.updated' && e.subjectId === claim.id,
  )!;
  assert.equal(event.actorId, session.actorId);
  assert.equal((event.data.source as any).sessionId, session.id);
  const conflict = await f.mcp(client, 'claim.update', {
    claimId: 'unrelated',
    status: 'supported',
    expectedRevision: 1,
    requestId: 'other',
  });
  assert.equal(conflict.result.isError, true);
  assert.equal(
    (await f.mcp(client, 'claim.create', { statement: 'Not granted', requestId: 'ungranted' }))
      .result.isError,
    true,
  );
  await f.app.ctx.scope.revokeCredential(f.source, f.producer.credential.id);
  const denied = await f.http('claim.list', {}, secret);
  assert.ok([401, 403].includes(denied.status));
  assert.equal((await f.http('claim.list', {}, f.reader.token)).body.result[0].revision, 1);
});
