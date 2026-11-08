import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createApp } from './fixtures/app.js';
import { currentTask } from './fixtures/current-work.js';
import { storedContext } from './fixtures/state.js';

async function client(url: string, token: string) {
  const result = new Client({ name: 'merv-integration', version: '1.0.0' });
  await result.connect(
    new StreamableHTTPClientTransport(new URL(url + '/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return result;
}
async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await c.callTool({ name, arguments: args });
  const contents = result.content as { type: string; text: string }[];
  assert.equal(result.isError, undefined, JSON.stringify(contents));
  return JSON.parse(contents[0].text);
}
test('assembled Cordis application preserves current MCP task closure across two full restarts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-app-'));
  let app = await createApp({ directory, api: true, port: 0 });
  let producer: Client | undefined, reviewer: Client | undefined;
  try {
    const credentials = await app.ctx.scope.credentials.bootstrap({
      projectName: 'Integration',
      actorName: 'Operator',
    });
    const caller = { actorId: credentials.actor.id, projectId: credentials.project.id };
    const p = await app.ctx.scope.credentials.issueActor(caller, {
        name: 'Producer',
        role: 'producer',
      }),
      r = await app.ctx.scope.credentials.issueActor(caller, {
        name: 'Reviewer',
        role: 'reviewer',
      });
    producer = await client(app.ctx.api.url!, p.token);
    const catalog = (await producer.listTools()).tools;
    assert.equal(catalog.length, 27);
    assert.equal(
      catalog.some((tool) => tool.name === 'code.backup.run'),
      false,
    );
    for (const name of ['project.read', 'session.read', 'session.write', 'code.git_credential'])
      assert.ok(
        catalog.some((tool) => tool.name === name),
        `${name} must be discoverable`,
      );
    // A worker's queue refuses every person, so a person's agent is not offered it.
    assert.ok(!catalog.some((tool) => tool.name === 'session.messages'));
    for (const name of ['paper.begin_update', 'paper.publish', 'paper.cancel'])
      assert.ok(!catalog.some((tool) => tool.name === name));
    // Long-lived credential administration stays on Merv's pages; short-lived Git access is listed.
    // Nor what it cannot use: a leased worker's writes, a Pi responder's answer, retiring waves.
    for (const name of [
      'actor.credentials',
      'actor.issue_token',
      'actor.rotate_token',
      'actor.revoke_token',
      ...['open', 'write', 'clear', 'render', 'review_visual', 'approve_visual'].map(
        (v) => `report.${v}`,
      ),
      ...['context', 'checkpoint', 'submit_delivery'].map((v) => `task.${v}`),
      'session.question.resolve',
      ...['create', 'list', 'get', 'lens', 'submit_lens', 'submit', 'end'].map(
        (v) => `reflection.${v}`,
      ),
    ])
      assert.ok(
        !catalog.some((tool) => tool.name === name),
        `${name} must not be offered to an agent`,
      );
    for (const name of [
      'report.read',
      'reflection.read',
      'task.write',
      'task.read',
      'project.read',
    ])
      assert.ok(
        catalog.some((tool) => tool.name === name),
        name,
      );
    // The brief is what Pi's turn is told: who, where, today, and the project's paper now.
    const told = await call(producer, 'project.read', { action: 'brief' });
    assert.deepEqual(told.actor, { id: p.actor.id, name: 'Producer', role: 'producer' });
    assert.deepEqual(told.project, { id: credentials.project.id, name: 'Integration' });
    assert.equal(told.today, new Date().toISOString().slice(0, 10));
    assert.equal(told.context, await app.ctx.tools.context({ ...caller, actorId: p.actor.id }));
    assert.ok(catalog.find((tool) => tool.name === 'project.read')!.description!.length <= 600);
    assert.deepEqual(
      catalog.filter((tool) => tool.name.startsWith('workflow.')).map((tool) => tool.name),
      ['workflow.read', 'workflow.write'],
    );
    // Record listings stay out of the catalog; workflow.catalog is the machine's shape only.
    for (const name of ['workflow.list', 'workflow.get', 'workflow.history']) {
      const result = await producer.callTool({ name, arguments: {} });
      assert.equal(result.isError, true);
      assert.equal(
        JSON.parse((result.content as { text: string }[])[0].text).error.code,
        'unknown_tool',
      );
      const response = await fetch(`${app.ctx.api.url}/tools/${name}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${p.token}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(response.status, 404);
      assert.equal((await response.json()).error.code, 'unknown_tool');
    }
    const brief = await call(producer, 'artifact.create', {
      title: 'Brief',
      content: 'Goal: Verify arithmetic.\nDone when: Sum is 20.',
    });
    const task = await currentTask(
      app.ctx,
      { ...caller, actorId: p.actor.id, credentialId: p.credential.id },
      {
        title: 'Arithmetic',
        goal: 'Verify arithmetic.',
        checks: ['Sum is 20.'],
        briefId: brief.id,
        requestId: 'create',
      },
    );
    const guidance = await call(producer, 'workflow.status_and_next', { instanceId: task.id });
    // Both legacy endpoints keep flat guidance for callers already using those names.
    const read = await call(producer, 'task.get', { taskId: task.id, full: true });
    assert.deepEqual(guidance, read.guidance);
    assert.ok(guidance.nextAction);
    // The old name keeps its flat guidance; the noun read tells the noun, its arguments under
    // the action's own name.
    assert.equal(guidance.nextAction.tool, 'workflow.begin');
    assert.equal(guidance.nextAction.status, 'ready');
    const noun = await call(producer, 'workflow.read', {
      action: 'status',
      status: { instanceId: task.id },
    });
    assert.equal(noun.nextAction.tool, 'workflow.write');
    assert.equal(noun.nextAction.arguments.action, 'begin');
    const httpGuidance = await fetch(`${app.ctx.api.url}/tools/workflow.status_and_next`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${p.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId: task.id }),
    });
    assert.equal(httpGuidance.status, 200);
    assert.deepEqual((await httpGuidance.json()).result, guidance);
    assert.deepEqual((await call(producer, 'workflow.status_and_next')).ready, [task.id]);
    const assignment = await call(producer, 'workflow.begin', {
      instanceId: task.id,
      expectedRevision: 0,
    });
    assert.equal(assignment.workStart.actorId, p.actor.id);
    const workGuidance = await call(producer, 'workflow.status_and_next', {
      instanceId: task.id,
    });
    assert.equal(workGuidance.nextAction.tool, 'task.submit_delivery');
    // A worker's own writes, which a person's agent over MCP is not offered; Merv runs them here.
    const worker = { ...caller, actorId: p.actor.id };
    await app.ctx.tools.call('task.checkpoint', worker, {
      taskId: task.id,
      purpose: 'work',
      expectedRevision: 0,
      notes: 'Inputs are 2, 4, 6, 8; calculation remains.',
      requestId: 'checkpoint',
    });
    const workContext = (await app.ctx.tools.call('task.context', worker, {
      taskId: task.id,
      purpose: 'work',
      expectedRevision: 0,
      requestId: 'work-context',
    })) as { id: string; prompt: string; type: string };
    assert.match(workContext.prompt, /calculation remains/);
    // The compact context retains the output contract; full guidance remains separately readable.
    assert.match(workContext.prompt, /task\.submit_delivery/);
    assert.ok(!workContext.prompt.includes(JSON.stringify(workGuidance)));
    assert.doesNotMatch(workContext.prompt, /\b[a-z_]+\.[a-z_]+:[a-z_]+\b/);
    assert.deepEqual(await storedContext(app.ctx.state, workContext.id), workContext);
    assert.equal(workContext.type, 'task.work');
    const delivery = await call(producer, 'artifact.create', {
      title: 'Delivery',
      content: 'Sum is 20. Calculation: 2+4+6+8=20.',
    });
    const closure = {
      taskId: task.id,
      expectedRevision: 0,
      reason: 'This bounded check is finished.',
      requestId: 'close',
    };
    const failed = await call(producer, 'task.mark_failed', closure);
    assert.equal(failed.workflow.state, 'failed');
    assert.equal(
      (await call(producer, 'workflow.status_and_next', { instanceId: task.id })).currentGate,
      'terminal',
    );
    await producer.close();
    producer = undefined;
    await app.stop();
    app = await createApp({ directory, api: true, port: 0 });
    producer = await client(app.ctx.api.url!, p.token);
    assert.deepEqual(await call(producer, 'task.mark_failed', closure), failed);
    assert.deepEqual(await storedContext(app.ctx.state, workContext.id), workContext);
    assert.equal(
      (await call(producer, 'artifact.read', { artifactId: delivery.id })).content,
      'Sum is 20. Calculation: 2+4+6+8=20.',
    );
    await producer.close();
    producer = undefined;
    await app.stop();
    app = await createApp({ directory, api: true, port: 0 });
    assert.equal((await app.ctx.tasks.get(caller, task.id)).workflow.revision, 1);
    assert.equal(
      (await app.ctx.state.events(caller.projectId)).filter((event) => event.type === 'task.failed')
        .length,
      1,
    );
  } finally {
    await producer?.close();
    await reviewer?.close();
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
