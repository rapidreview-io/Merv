import { currentWork } from './fixtures/current-work.js';
import { waitForManagedCode } from './fixtures/managed-code.js';
import { randomBytes } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from './fixtures/app.js';
import type { ApplicationConfig } from '../src/config.js';
import type { Caller } from '@merv/contracts';
import { feasibilityStatement } from './feasibility-fixture.js';
import { EXHIBIT_SHOWN_BYTES, exhibitPreview } from '@merv/experiments/tools';
import type { ExperimentEvidence } from '@merv/experiments/types';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-experiments-api-'));
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as ApplicationConfig;
  config.plugins.find((entry) => entry.id === 'ui')!.config = {
    assets: join(directory, 'unused-assets'),
  };
  const app = await createApp({ directory, config, port: 0, feed: true });
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Experiment transport acceptance',
    actorName: 'Operator',
  });
  const source: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  await waitForManagedCode(app.ctx.codeWork, source);
  const work = currentWork(app.ctx, { directory, source });
  t.after(() => work.close());
  const producer = await app.ctx.scope.credentials.issueActor(source, {
    name: 'Experiment producer',
    role: 'producer',
  });
  const reviewer = await app.ctx.scope.credentials.issueActor(source, {
    name: 'Independent reviewer',
    role: 'reviewer',
  });
  const reader = await app.ctx.scope.credentials.issueActor(source, {
    name: 'Project reader',
    role: 'reader',
  });
  const http = async (tool: string, input: unknown = {}, token: string | null = producer.token) => {
    const response = await fetch(`${app.ctx.api.url}/tools/${tool}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(input),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const connect = async (token: string) => {
    const client = new Client({ name: 'Experiments acceptance', version: '1' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${app.ctx.api.url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  };
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, `${name}: ${JSON.stringify(response.content)}`);
    return JSON.parse((response.content as { text: string }[])[0].text);
  };
  return { app, source, boot, producer, reviewer, reader, http, connect, call, work };
}

test('compact experiment lists expose callable paginated recovery references over MCP', async (t) => {
  const f = await fixture(t);
  const client = await f.connect(f.producer.token);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const e = await f.call(client, 'experiment.write', {
      action: 'create',
      create: {
        name: `reminder-${i}`,
        intent: `Question ${i}`,
        details: `Use baseline ${i}; check experiment.read:get`,
        requestId: `reminder-${i}`,
      },
    });
    ids.push(e.id);
  }
  let next: { tool: string; arguments: Record<string, unknown> } | null = {
    tool: 'experiment.read',
    arguments: { action: 'list', list: { limit: 1 } },
  };
  const seen: string[] = [];
  while (next) {
    const page = await f.call(client, next.tool, next.arguments);
    assert.equal(page.items.length, 1);
    const item = page.items[0];
    seen.push(item.id);
    assert.ok(!('details' in item));
    const reminder = await f.call(client, item.reference.tool, item.reference.arguments);
    assert.equal(reminder.intent, `Question ${seen.length - 1}`);
    assert.equal(reminder.details, `Use baseline ${seen.length - 1}; check experiment.read:get`);
    const ref = reminder.references.find((r: any) => r.arguments?.get?.history === 'attempts');
    assert.ok(ref);
    const history = await f.call(client, ref.tool, ref.arguments);
    assert.equal(history.items[0].index, 1);
    const assignment = await f.call(client, 'workflow.read', {
      action: 'assignment',
      assignment: { instanceId: item.id },
    });
    assert.ok(!('policy' in assignment.execution));
    assert.ok(!('sources' in assignment.context));
    assert.ok(assignment.context.prompt.includes(reminder.intent));
    assert.ok(assignment.context.prompt.includes(reminder.details));
    assert.ok(assignment.references.some((r: any) => r.id === item.id));
    next = page.next;
  }
  assert.deepEqual(seen, ids);
});
