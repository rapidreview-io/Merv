import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';

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
test('assembled Cordis application completes MCP task review across two full restarts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-app-'));
  let app = await createApp({ directory, api: true, port: 0 });
  let producer: Client | undefined, reviewer: Client | undefined;
  try {
    const credentials = await app.ctx.scope.bootstrap({
      projectName: 'Integration',
      actorName: 'Operator',
    });
    const caller = { actorId: credentials.actor.id, projectId: credentials.project.id };
    const p = await app.ctx.scope.issueActor(caller, { name: 'Producer', role: 'producer' }),
      r = await app.ctx.scope.issueActor(caller, { name: 'Reviewer', role: 'reviewer' });
    producer = await client(app.ctx.api.url!, p.token);
    const catalog = (await producer.listTools()).tools;
    assert.equal(catalog.length, 87);
    for (const name of ['paper.begin_update', 'paper.publish', 'paper.cancel'])
      assert.ok(!catalog.some((tool) => tool.name === name));
    for (const name of [
      'actor.credentials',
      'actor.issue_token',
      'actor.rotate_token',
      'actor.revoke_token',
    ])
      assert.ok(
        catalog.some((tool) => tool.name === name),
        `${name} must be discoverable`,
      );
    assert.deepEqual(
      catalog.filter((tool) => tool.name.startsWith('workflow.')).map((tool) => tool.name),
      [
        'workflow.assignment',
        'workflow.begin',
        'workflow.catalog',
        'workflow.extend_limit',
        'workflow.process',
        'workflow.status_and_next',
      ],
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
    const task = await call(producer, 'task.create', {
      title: 'Arithmetic',
      goal: 'Verify arithmetic.',
      checks: ['Sum is 20.'],
      briefId: brief.id,
      requestId: 'create',
    });
    const guidance = await call(producer, 'workflow.status_and_next', { instanceId: task.id });
    assert.deepEqual(guidance, task.guidance);
    assert.equal(guidance.nextAction.tool, 'workflow.begin');
    assert.equal(guidance.nextAction.status, 'ready');
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
    await call(producer, 'task.checkpoint', {
      taskId: task.id,
      purpose: 'work',
      expectedRevision: 0,
      notes: 'Inputs are 2, 4, 6, 8; calculation remains.',
      requestId: 'checkpoint',
    });
    const workContext = await call(producer, 'task.context', {
      taskId: task.id,
      purpose: 'work',
      expectedRevision: 0,
      requestId: 'work-context',
    });
    assert.match(workContext.prompt, /calculation remains/);
    assert.ok(workContext.prompt.includes(JSON.stringify(workGuidance)));
    assert.equal(workContext.type, 'task.work');
    const delivery = await call(producer, 'artifact.create', {
      title: 'Delivery',
      content: 'Sum is 20. Calculation: 2+4+6+8=20.',
    });
    const submitted = await call(
      producer,
      'task.submit_delivery',
      confirmedDelivery({
        taskId: task.id,
        artifactIds: [delivery.id],
        expectedRevision: 0,
        requestId: 'submit',
      }),
    );
    assert.equal(submitted.workflow.state, 'in_review');
    assert.equal(
      (await call(producer, 'workflow.status_and_next', { instanceId: task.id })).nextAction,
      null,
    );
    const rejected = await producer.callTool({
      name: 'review.start',
      arguments: { reviewId: submitted.reviewId },
    });
    assert.equal(rejected.isError, true);
    await producer.close();
    producer = undefined;
    await app.stop();
    app = await createApp({ directory, api: true, port: 0 });
    reviewer = await client(app.ctx.api.url!, r.token);
    const pin = await call(reviewer, 'review.get', { reviewId: submitted.reviewId });
    assert.deepEqual(pin.artifactIds, [brief.id, ...submitted.deliveryIds]);
    assert.equal(submitted.deliveryIds[0], delivery.id);
    assert.equal(submitted.deliveryIds.at(-1), submitted.deliveryAssessmentId);
    assert.equal(submitted.deliveryIds.length, 2);
    assert.equal(
      (await call(reviewer, 'artifact.read', { artifactId: delivery.id })).content,
      'Sum is 20. Calculation: 2+4+6+8=20.',
    );
    const claim = await call(reviewer, 'review.start', { reviewId: pin.id });
    await call(reviewer, 'workflow.begin', { instanceId: task.id, expectedRevision: 1 });
    const reviewGuidance = await call(reviewer, 'workflow.status_and_next', {
      instanceId: task.id,
    });
    assert.equal(reviewGuidance.nextAction.tool, 'review.submit');
    assert.equal(reviewGuidance.nextAction.arguments.claimId, claim.claimId);
    const contextArgs = {
      taskId: task.id,
      purpose: 'review',
      expectedRevision: 1,
      claimId: claim.claimId,
      requestId: 'review-context',
    };
    const reviewContext = await call(reviewer, 'task.context', contextArgs);
    assert.equal(reviewContext.type, 'task.review');
    assert.equal(reviewContext.subject.claimId, claim.claimId);
    const httpContext = await fetch(`${app.ctx.api.url}/tools/task.context`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${r.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(contextArgs),
    });
    assert.equal(httpContext.status, 200);
    assert.deepEqual((await httpContext.json()).result, reviewContext);
    const missingClaim = await reviewer.callTool({
      name: 'review.submit',
      arguments: {
        ...reviewedFindings(pin),
        reviewId: pin.id,
        verdict: 'pass',
        notes: 'Missing assignment identity.',
        expectedRevision: 1,
        requestId: 'missing-claim',
      },
    });
    assert.equal(missingClaim.isError, true);
    const verdictArgs = {
      ...reviewedFindings(claim),
      reviewId: pin.id,
      claimId: claim.claimId,
      verdict: 'pass',
      notes: 'Read the immutable delivery and independently verified 2+4+6+8=20.',
      expectedRevision: 1,
      requestId: 'verdict',
    };
    const done = await call(reviewer, 'review.submit', verdictArgs);
    assert.equal(done.workflow.state, 'done');
    assert.equal(
      (await call(reviewer, 'workflow.status_and_next', { instanceId: task.id })).currentGate,
      'terminal',
    );
    assert.deepEqual(await call(reviewer, 'review.submit', verdictArgs), done);
    await reviewer.close();
    reviewer = undefined;
    await app.stop();
    app = await createApp({ directory, api: true, port: 0 });
    assert.equal((await app.ctx.tasks.get(caller, task.id)).workflow.revision, 2);
    assert.deepEqual(await app.ctx.contextBuilder.get(caller, workContext.id), workContext);
    assert.deepEqual(await app.ctx.contextBuilder.get(caller, reviewContext.id), reviewContext);
    assert.equal((await app.ctx.reviews.get(caller, pin.id)).reviewerId, r.actor.id);
    assert.equal(
      (await app.ctx.state.events(caller.projectId)).filter((e) => e.type === 'task.review_applied')
        .length,
      1,
    );
    assert.equal(
      (await app.ctx.artifacts.read(caller, delivery.id)).content,
      'Sum is 20. Calculation: 2+4+6+8=20.',
    );
  } finally {
    await producer?.close();
    await reviewer?.close();
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
test('invalid composition fails without leaving an active application', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-invalid-'));
  try {
    await assert.rejects(
      createApp({ directory, components: ['artifacts'] }),
      /missing dependencies/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('application stop disposes Cordis and SQLite after API shutdown rejects', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-stop-failure-'));
  const app = await createApp({ directory, api: true, port: 0 });
  const state = app.ctx.state,
    api = app.ctx.api;
  const originalStop = api.stop.bind(api);
  const failure = new Error('Injected transport shutdown failure');
  let attempts = 0;
  api.stop = async () => {
    if (++attempts === 1) throw failure;
    await originalStop();
  };
  try {
    const stopped = app.stop();
    assert.equal(app.stop(), stopped, 'Concurrent stop requests must join the same shutdown');
    await assert.rejects(stopped, (error) => error === failure);
    assert.equal(attempts, 2, 'Cordis must run the API resource disposer after the first failure');
    assert.equal(app.ctx.get('state'), undefined);
    assert.equal(app.ctx.get('tasks'), undefined);
    assert.equal(app.ctx.get('api'), undefined);
    await assert.rejects(async () => await state.read(async (sql) => await sql.get('SELECT 1')), {
      code: 'state_closed',
    });
  } finally {
    await originalStop();
    await app.ctx.fiber.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
