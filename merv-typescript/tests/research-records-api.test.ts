import { waitForManagedCode } from './fixtures/managed-code.js';
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
import { createApp } from './fixtures/app.js';
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
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Research records transport',
    actorName: 'Owner',
  });
  const operator: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const producer = await app.ctx.scope.credentials.issueActor(operator, {
    name: 'Producer',
    role: 'producer',
  });
  const reader = await app.ctx.scope.credentials.issueActor(operator, {
    name: 'Reader',
    role: 'reader',
  });
  const reviewer = await app.ctx.scope.credentials.issueActor(operator, {
    name: 'Reviewer',
    role: 'reviewer',
  });
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

test('Scope holds no Introduction: project.get carries none and no tool writes one', async (t) => {
  const f = await fixture(t),
    client = await f.connect(f.producer.token);
  const project = (await f.http('project.get', {}, f.reader.token)).body.result;
  assert.deepEqual(Object.keys(project).sort(), ['createdAt', 'id', 'name']);
  const input = { summary: 'A second writer.', expectedSummary: '', requestId: 'intro' };
  const written = await f.http('project.context.update', input);
  assert.equal(written.status, 404);
  assert.equal(written.body.error.code, 'unknown_tool');
  assert.equal(
    (await client.listTools()).tools.some((tool) => tool.name === 'project.context.update'),
    false,
  );
});

test('Knowledge transport reads complete scoped metadata, exposes unresolved states and withdraws with its provider', async (t) => {
  const f = await fixture(t);
  const project = await f.app.ctx.scope.project(f.caller);
  await waitForManagedCode(f.app.ctx.codeWork, f.caller);
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
  const foreign = await f.app.ctx.scope.credentials.bootstrap({
    projectName: 'Other project',
    actorName: 'Other owner',
  });
  const foreignCaller = { actorId: foreign.actor.id, projectId: foreign.project.id };
  const foreignArtifact = await f.app.ctx.artifacts.create(foreignCaller, {
    title: 'Private input',
    content: 'private bytes',
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
  assert.deepEqual(records.value.project, project);
  assert.equal(Object.hasOwn(records.value, 'archivedClaims'), false);
  assert.equal(records.value.tasks[0].workflow.state, 'failed');
  assert.equal(Object.hasOwn(records.value.tasks[0], 'guidance'), false);
  assert.equal(records.value.experiments[0].id, experiment.id);
  assert.equal(Object.hasOwn(records.value, 'publication'), false);
  const refs = [
    `task:${task.id}`,
    experiment.id,
    artifact.id,
    foreignArtifact.id,
    // Research claims are retired; the kind is unknown like any other.
    'claim:claim_retired',
    'paper:arxiv-1234',
  ];
  const resolved = (await f.http('project.references', { refs }, f.reader.token)).body.result;
  assert.deepEqual(
    resolved.map((item: any) => item.ref),
    refs,
  );
  assert.deepEqual(
    resolved.map((item: any) => item.status),
    ['resolved', 'resolved', 'resolved', 'missing', 'unsupported', 'unsupported'],
  );
  assert.equal(resolved[2].hash, artifact.hash);
  assert.equal(JSON.stringify(resolved).includes(foreignArtifact.title), false);
  assert.equal(await f.app.ctx.state.eventHead(), head);
  assert.equal((await f.http('project.records', { invented: true })).status, 400);
  assert.equal(
    (await f.http('project.references', { refs: Array(201).fill(artifact.id) })).status,
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
  assert.equal(
    (await f.http('ui.shell', {}, f.reader.token)).body.result.rows.some(
      (row: any) => row.id === 'knowledge',
    ),
    false,
    'restoring the Knowledge service does not restore its retired UI row',
  );
});
