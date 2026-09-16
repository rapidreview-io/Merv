import { mapAsync } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Caller } from '@merv/contracts';
import type {} from '@merv/knowledge/types';
import { createApp } from '../src/app.js';
import type { ApplicationConfig } from '../src/config.js';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-records-api-'));
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as ApplicationConfig;
  config.plugins.find((entry) => entry.id === 'ui')!.config = {
    assets: join(directory, 'unused-assets'),
  };
  const app = await createApp({ directory, config, port: 0 });
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({
    projectName: 'Research records transport',
    actorName: 'Owner',
  });
  const operator: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const producer = await app.ctx.scope.issueActor(operator, { name: 'Producer', role: 'producer' });
  const reader = await app.ctx.scope.issueActor(operator, { name: 'Reader', role: 'reader' });
  const reviewer = await app.ctx.scope.issueActor(operator, { name: 'Reviewer', role: 'reviewer' });
  const caller: Caller = {
    actorId: producer.actor.id,
    projectId: boot.project.id,
    credentialId: producer.credential.id,
  };
  const http = async (
    tool: string,
    input: unknown = {},
    token: string | null = producer.token,
    projectId?: string,
  ) => {
    const response = await fetch(`${app.ctx.api.url}/tools/${tool}`, {
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
    const client = new Client({ name: 'Research records acceptance', version: '1' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${app.ctx.api.url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  };
  const call = async (client: Client, name: string, input: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: input });
    return { result, value: JSON.parse((result.content as { text: string }[])[0].text) };
  };
  return { app, boot, operator, producer, reader, reviewer, caller, http, connect, call };
}

test('Introduction HTTP and MCP preserve exact baseline, original replay result and current write authority', async (t) => {
  const f = await fixture(t),
    client = await f.connect(f.producer.token);
  const initial = (await f.http('project.get', {}, f.reader.token)).body.result;
  assert.equal(initial.summary, '');
  assert.equal(initial.contextRevision, 0);
  const input = {
    summary: '  Compare two fixed estimators.  ',
    expectedSummary: '',
    requestId: 'intro',
  };
  const saved = await f.call(client, 'project.context.update', input);
  assert.notEqual(saved.result.isError, true, JSON.stringify(saved.value));
  assert.equal(saved.value.summary, 'Compare two fixed estimators.');
  assert.equal(saved.value.contextRevision, 1);
  const next = await f.http(
    'project.context.update',
    {
      summary: 'Retain all held-out predictions.',
      expectedSummary: saved.value.summary,
      requestId: 'next',
    },
    f.boot.token,
  );
  assert.equal(next.status, 200);
  assert.deepEqual((await f.http('project.context.update', input)).body.result, saved.value);
  assert.equal((await f.http('project.get')).body.result.contextRevision, 2);
  const stale = await f.http('project.context.update', { ...input, requestId: 'stale' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'project_context_conflict');
  assert.equal(
    (await f.http('project.context.update', { ...input, summary: 'Changed payload' })).body.error
      .code,
    'request_conflict',
  );
  for (const token of [f.reader.token, f.reviewer.token])
    assert.equal((await f.http('project.context.update', input, token)).status, 403);
  assert.equal((await f.http('project.context.update', input, null)).status, 401);
  for (const invalid of [
    { ...input, name: 'Cannot rename' },
    { ...input, summary: '😀'.repeat(4001) },
    { summary: 'Missing baseline', requestId: 'invalid' },
  ])
    assert.equal((await f.http('project.context.update', invalid)).status, 400);
  const other = await f.app.ctx.scope.bootstrap({ projectName: 'Other', actorName: 'Other owner' });
  assert.equal(
    (await f.http('project.context.update', input, f.producer.token, other.project.id)).status,
    403,
  );
  assert.equal(
    (await f.app.ctx.scope.project({ actorId: other.actor.id, projectId: other.project.id }))
      .summary,
    '',
  );
  await f.app.ctx.scope.revokeCredential(f.operator, f.producer.credential.id);
  assert.equal((await f.http('project.context.update', input)).status, 401);
  assert.equal(
    (await f.app.ctx.state.events(f.boot.project.id)).filter(
      (event) => event.type === 'project.context.updated',
    ).length,
    2,
  );
});

test('Knowledge transport reads complete scoped metadata, exposes unresolved states and withdraws with its provider', async (t) => {
  const f = await fixture(t);
  const intro = await f.app.ctx.scope.updateProjectContext(f.caller, {
    summary: 'Preserve all research inputs.',
    expectedSummary: '',
    requestId: 'intro',
  });
  const claim = await f.app.ctx.claims.create(f.caller, {
    statement: 'The fixed estimator is more accurate.',
    requestId: 'claim',
  });
  const task = await f.app.ctx.tasks.create(f.caller, {
    title: 'Retain source data',
    goal: 'Keep the exact input.',
    checks: ['Input bytes are retained.'],
    requestId: 'task',
  });
  await f.app.ctx.tasks.markFailed(f.caller, {
    taskId: task.id,
    expectedRevision: 0,
    reason: 'This source is no longer available.',
    requestId: 'close',
  });
  const experiment = await f.app.ctx.experiments.create(f.caller, {
    name: 'retained-inputs',
    intent: 'Compare exact records.',
    requestId: 'experiment',
  });
  const artifact = await f.app.ctx.artifacts.create(f.caller, {
    title: 'Exact input',
    content: 'retained bytes',
  });
  const foreign = await f.app.ctx.scope.bootstrap({
    projectName: 'Other project',
    actorName: 'Other owner',
  });
  const foreignCaller = { actorId: foreign.actor.id, projectId: foreign.project.id };
  const foreignClaim = await f.app.ctx.claims.create(foreignCaller, {
    statement: 'Private claim.',
    requestId: 'foreign',
  });
  const head = await f.app.ctx.state.eventHead();
  t.mock.method(f.app.ctx.artifacts, 'read', () =>
    assert.fail('Metadata transport must not read bytes'),
  );
  t.mock.method(f.app.ctx.workflows, 'evaluate', () =>
    assert.fail('Metadata transport must not evaluate gates'),
  );
  const client = await f.connect(f.reader.token);
  const names = (await client.listTools()).tools;
  for (const name of ['project.records', 'project.references'])
    assert.equal(names.find((tool) => tool.name === name)?.annotations?.readOnlyHint, true);
  assert.equal(
    names.some((tool) => /^(knowledge|project)\.(capture|snapshot)/.test(tool.name)),
    false,
  );
  const records = await f.call(client, 'project.records');
  assert.notEqual(records.result.isError, true);
  assert.deepEqual(records.value.project, intro);
  assert.deepEqual(
    records.value.claims.map((record: any) => record.id),
    [claim.id],
  );
  assert.equal(records.value.tasks[0].workflow.state, 'failed');
  assert.equal(Object.hasOwn(records.value.tasks[0], 'guidance'), false);
  assert.equal(records.value.experiments[0].id, experiment.id);
  assert.equal(records.value.publication.status, 'none');
  const refs = [
    claim.id,
    `task:${task.id}`,
    experiment.id,
    artifact.id,
    foreignClaim.id,
    'claim:claim_missing',
    'paper:arxiv-1234',
  ];
  const resolved = (await f.http('project.references', { refs }, f.reader.token)).body.result;
  assert.deepEqual(
    resolved.map((item: any) => item.ref),
    refs,
  );
  assert.deepEqual(
    resolved.map((item: any) => item.status),
    ['resolved', 'resolved', 'resolved', 'resolved', 'missing', 'missing', 'unsupported'],
  );
  assert.equal(resolved[3].hash, artifact.hash);
  assert.equal(JSON.stringify(resolved).includes(foreignClaim.statement), false);
  assert.equal(await f.app.ctx.state.eventHead(), head);
  assert.equal((await f.http('project.records', { invented: true })).status, 400);
  assert.equal(
    (await f.http('project.references', { refs: Array(201).fill(claim.id) })).status,
    400,
  );
  assert.equal((await f.http('project.records', {}, null)).status, 401);
  const old = f.app.ctx.knowledge;
  await f.app.setEnabled('knowledge', false);
  assert.equal(
    (await client.listTools()).tools.some((tool) => tool.name === 'project.records'),
    false,
  );
  assert.equal(
    (await f.http('ui.shell', {}, f.reader.token)).body.result.rows.some(
      (row: any) => row.id === 'knowledge',
    ),
    false,
  );
  await assert.rejects(async () => await old.records(f.caller), { status: 503 });
  assert.equal((await f.http('project.get', {}, f.reader.token)).status, 200);
  await f.app.setEnabled('knowledge', true);
  assert.deepEqual((await f.call(client, 'project.records')).value, records.value);
  assert.deepEqual(
    (await f.http('ui.shell', {}, f.reader.token)).body.result.rows.find(
      (row: any) => row.id === 'knowledge',
    ).status,
    {},
    'a record inventory is consulted, not worked, so it carries no count',
  );
});

test('A real Task worker cannot edit project intent through HTTP or MCP, even by guessing the tool name', async (t) => {
  const f = await fixture(t);
  const task = await f.app.ctx.tasks.create(f.caller, {
    title: 'Check retained input',
    goal: 'Check input.',
    checks: ['The input is checked.'],
    requestId: 'task',
  });
  const secret = 'ms_' + randomBytes(32).toString('base64url');
  await f.app.ctx.sessions.offer(f.caller, {
    instanceId: task.id,
    expectedRevision: 0,
    runnerId: 'acceptance-runner',
    requestId: 'offer',
    secret,
  });
  const client = await f.connect(secret);
  assert.equal(
    (await client.listTools()).tools.some((tool) => tool.name === 'project.context.update'),
    false,
  );
  const input = {
    summary: 'Worker cannot redefine the project.',
    expectedSummary: '',
    requestId: 'worker',
  };
  assert.equal((await f.call(client, 'project.context.update', input)).result.isError, true);
  assert.equal((await f.http('project.context.update', input, secret)).status, 403);
  assert.equal((await f.http('project.get', {}, f.reader.token)).body.result.summary, '');
});
