import { mapAsync } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Caller, Role, WorkflowAssignment } from '@merv/contracts';
import { createApp } from './fixtures/app.js';
import { confirmedDelivery } from './fixtures/task-evidence.js';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-assignment-api-'));
  const app = await createApp({ directory, api: true, port: 0 });
  const clients: Client[] = [];
  t.after(async () => {
    try {
      await Promise.allSettled(clients.map((client) => client.close()));
      await app.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const initial = await app.ctx.scope.bootstrap({
    projectName: 'Assignment API',
    actorName: 'Operator',
  });
  const operator: Caller = { actorId: initial.actor.id, projectId: initial.project.id };
  const issue = async (role: Role) => {
    const credential = await app.ctx.scope.issueActor(operator, { name: role, role });
    return {
      ...credential,
      caller: { actorId: credential.actor.id, projectId: operator.projectId },
    };
  };
  const producer = await issue('producer');
  const task = await app.ctx.tasks.create(producer.caller, {
    title: 'Retain the result',
    goal: 'Retain a verified arithmetic result.',
    checks: ['The sum of 2 and 3 is 5.'],
    requestId: 'create',
  });
  const connect = async (token: string) => {
    const client = new Client({ name: 'workflow-assignment-api', version: '1' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${app.ctx.api.url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  };
  const http = async (name: string, input: object, token = producer.token) => {
    const response = await fetch(`${app.ctx.api.url}/tools/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return { status: response.status, body: await response.json() };
  };
  const durable = async () =>
    await app.ctx.state.read(async (sql) => ({
      starts: await sql.all('SELECT * FROM wf_work_starts ORDER BY event_id'),
      contexts: await sql.all('SELECT * FROM context_packages ORDER BY id'),
      events: await sql.all('SELECT * FROM events ORDER BY id'),
      history: await sql.all('SELECT * FROM wf_history ORDER BY instance_id,revision'),
    }));
  return { app, operator, producer, task, issue, connect, http, durable };
}

const parse = (result: Awaited<ReturnType<Client['callTool']>>) =>
  JSON.parse((result.content as { text: string }[])[0].text);
async function call(client: Client, name: string, input: object): Promise<WorkflowAssignment> {
  const result = await client.callTool({ name, arguments: { ...input } });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return parse(result);
}
async function rejected(client: Client, name: string, input: object, code: string) {
  const result = await client.callTool({ name, arguments: { ...input } });
  assert.equal(result.isError, true);
  assert.equal(parse(result).error.code, code);
}

test(
  'assignment and begin expose strict authenticated schemas and canonical full packets over HTTP and MCP',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const client = await f.connect(f.producer.token);
    const catalog = (await client.listTools()).tools;
    const assignmentTool = catalog.find((tool) => tool.name === 'workflow.assignment')!;
    const beginTool = catalog.find((tool) => tool.name === 'workflow.begin')!;
    assert.equal(assignmentTool.annotations?.readOnlyHint, true);
    assert.equal(beginTool.annotations?.readOnlyHint, false);
    assert.deepEqual(Object.keys(assignmentTool.inputSchema.properties!).sort(), [
      'instanceId',
      'projectId',
    ]);
    assert.deepEqual(Object.keys(beginTool.inputSchema.properties!).sort(), [
      'expectedRevision',
      'instanceId',
      'projectId',
    ]);
    assert.equal(assignmentTool.inputSchema.additionalProperties, false);
    assert.equal(beginTool.inputSchema.additionalProperties, false);
    const before = await f.durable();
    for (const [tool, base] of [
      ['workflow.assignment', { instanceId: f.task.id }],
      ['workflow.begin', { instanceId: f.task.id, expectedRevision: 0 }],
    ] as const) {
      for (const extra of [
        { actorId: f.operator.actorId },
        { role: 'operator' },
        { sessionId: 'spoofed' },
        { claimId: 'spoofed' },
        { requestId: 'not-accepted' },
      ]) {
        const input = { ...base, ...extra };
        assert.equal((await f.http(tool, input)).status, 400);
        await rejected(client, tool, input, 'invalid_input');
      }
    }
    for (const input of [
      { instanceId: f.task.id },
      { instanceId: f.task.id, expectedRevision: -1 },
      { instanceId: f.task.id, expectedRevision: 0.5 },
      { instanceId: f.task.id, expectedRevision: '0' },
      { instanceId: '', expectedRevision: 0 },
    ]) {
      assert.equal((await f.http('workflow.begin', input)).status, 400);
      await rejected(client, 'workflow.begin', input, 'invalid_input');
    }
    for (const tool of ['workflow.assignment', 'workflow.begin']) {
      const selected = {
        instanceId: f.task.id,
        ...(tool === 'workflow.begin' ? { expectedRevision: 0 } : {}),
        projectId: 'foreign',
      };
      assert.equal((await f.http(tool, selected)).status, 403);
      await rejected(client, tool, selected, 'forbidden');
    }
    assert.deepEqual(await f.durable(), before);
    const input = { instanceId: f.task.id };
    const packet = await call(client, 'workflow.assignment', input);
    const overHttp = await f.http('workflow.assignment', input);
    assert.equal(overHttp.status, 200);
    assert.deepEqual(overHttp.body.result, packet);
    assert.deepEqual(
      (await f.http('workflow.assignment', { ...input, projectId: f.operator.projectId })).body
        .result,
      packet,
    );
    assert.deepEqual(packet, await f.app.ctx.workflows.assignment(f.producer.caller, f.task.id));
    assert.equal(packet.actorId, f.producer.actor.id);
    assert.equal(packet.projectId, f.operator.projectId);
    assert.equal(packet.state, 'in_progress');
    assert.equal(packet.revision, 0);
    assert.equal(packet.workStart, null);
    assert.match(packet.brief, /Retain a verified arithmetic result/);
    assert.equal(packet.execution.readOnly, false);
    assert.ok(
      packet.execution.tools.some(
        (tool) => tool.name === 'task.submit_delivery' && tool.arguments.taskId === f.task.id,
      ),
    );
    assert.ok(packet.handoff.tools.includes('task.submit_delivery'));
    assert.ok(packet.context);
    assert.equal(packet.context.subject.id, f.task.id);
    assert.equal(packet.context.subject.revision, 0);
    assert.match(packet.context.prompt, /The sum of 2 and 3 is 5/);
    assert.ok(packet.context.sources.some((source) => source.id === f.task.briefId));
    assert.equal('id' in packet.context, false, 'A preview is not a saved package');
    assert.deepEqual(
      await f.durable(),
      before,
      'Assignment reads must not save context or start work',
    );

    const begin = { instanceId: f.task.id, expectedRevision: 0 };
    const [first, second, third] = await Promise.all([
      call(client, 'workflow.begin', begin),
      f.http('workflow.begin', begin),
      f.http('workflow.begin', begin),
    ]);
    assert.equal(second.status, 200);
    assert.equal(third.status, 200);
    assert.deepEqual(second.body.result, first);
    assert.deepEqual(third.body.result, first);
    assert.deepEqual(await call(client, 'workflow.assignment', input), first);
    assert.deepEqual((await f.http('workflow.begin', begin)).body.result, first);
    assert.ok(first.workStart);
    assert.equal(first.workStart.actorId, f.producer.actor.id);
    assert.equal(first.revision, 0);
    const after = await f.durable();
    assert.equal(after.starts.length, 1);
    assert.equal(after.events.length, before.events.length + 1);
    assert.deepEqual(after.contexts, before.contexts);
    assert.deepEqual(after.history, before.history);
    assert.equal(
      (await f.app.ctx.state.events(f.operator.projectId)).filter(
        (event) => event.type === 'workflow.work_started',
      ).length,
      1,
    );
    const retained = await f.app.ctx.tasks.get(f.producer.caller, f.task.id);
    assert.deepEqual(retained.workStarts, [first.workStart]);
    assert.deepEqual(retained.guidance.workStart, first.workStart);
  },
);

test(
  'assignment API fences caller permissions, project scope, stale revisions and ended nodes without recording starts',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const before = await f.durable();
    for (const actor of [
      await f.issue('reader'),
      await f.issue('reviewer'),
      await f.issue('producer'),
    ]) {
      const client = await f.connect(actor.token);
      const beforeDenied = await f.durable();
      for (const [tool, input] of [
        ['workflow.assignment', { instanceId: f.task.id }],
        ['workflow.begin', { instanceId: f.task.id, expectedRevision: 0 }],
      ] as const) {
        assert.equal((await f.http(tool, input, actor.token)).status, 403);
        await rejected(client, tool, input, 'forbidden');
      }
      assert.deepEqual(await f.durable(), beforeDenied);
    }
    // Credential issuance above is expected; every denied assignment itself is read-only.
    const beforeForeign = await f.durable();
    const foreign = await f.app.ctx.scope.bootstrap({
      projectName: 'Foreign project',
      actorName: 'Foreign operator',
    });
    const foreignClient = await f.connect(foreign.token);
    const beforeForeignDenied = await f.durable();
    for (const [tool, input] of [
      ['workflow.assignment', { instanceId: f.task.id }],
      ['workflow.begin', { instanceId: f.task.id, expectedRevision: 0 }],
    ] as const) {
      assert.equal((await f.http(tool, input, foreign.token)).status, 404);
      await rejected(foreignClient, tool, input, 'not_found');
    }
    assert.deepEqual(await f.durable(), beforeForeignDenied);
    assert.deepEqual((await f.durable()).starts, before.starts);
    assert.deepEqual((await f.durable()).contexts, beforeForeign.contexts);
    const client = await f.connect(f.producer.token);
    const beforeStale = await f.durable();
    const stale = { instanceId: f.task.id, expectedRevision: 1 };
    assert.equal((await f.http('workflow.begin', stale)).status, 409);
    await rejected(client, 'workflow.begin', stale, 'revision_conflict');
    assert.deepEqual(await f.durable(), beforeStale);
    await f.app.ctx.tasks.markFailed(f.producer.caller, {
      taskId: f.task.id,
      expectedRevision: 0,
      reason: 'Stop the API fixture.',
      requestId: 'end',
    });
    const ended = await f.durable();
    await rejected(
      client,
      'workflow.begin',
      { instanceId: f.task.id, expectedRevision: 0 },
      'revision_conflict',
    );
    for (const [tool, input] of [
      ['workflow.assignment', { instanceId: f.task.id }],
      ['workflow.begin', { instanceId: f.task.id, expectedRevision: 1 }],
    ] as const) {
      const response = await f.http(tool, input);
      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, 'workflow_ended');
      await rejected(client, tool, input, 'workflow_ended');
    }
    assert.deepEqual(await f.durable(), ended);
  },
);

test(
  'review assignment packets remain read-only and bind the current claim before their permitted handoff',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const evidence = await f.app.ctx.artifacts.create(f.producer.caller, {
      title: 'Calculation',
      content: '2 + 3 = 5.',
    });
    const pending = await f.app.ctx.tasks.submitDelivery(
      f.producer.caller,
      confirmedDelivery({
        taskId: f.task.id,
        expectedRevision: 0,
        artifactIds: [evidence.id],
        requestId: 'submit',
      }),
    );
    const reviewer = await f.issue('reviewer');
    const client = await f.connect(reviewer.token);
    const input = { instanceId: f.task.id };
    const before = await f.durable();
    const unclaimed = await call(client, 'workflow.assignment', input);
    assert.deepEqual(
      (await f.http('workflow.assignment', input, reviewer.token)).body.result,
      unclaimed,
    );
    assert.equal(unclaimed.execution.readOnly, true);
    assert.deepEqual(unclaimed.handoff.tools, ['review.start', 'workflow.assignment']);
    // Declared permissions stay fixed; the required claim binding is unavailable until claimed.
    for (const name of ['review.submit', 'task.context']) {
      assert.ok(unclaimed.execution.tools.some((tool) => tool.name === name));
      await assert.rejects(
        async () =>
          await f.app.ctx.workflows.authorizeDispatch(reviewer.caller, {
            instanceId: f.task.id,
            expectedRevision: 1,
            policyHash: unclaimed.execution.policyHash!,
            registrationId: unclaimed.execution.registrationId!,
            tool: name,
            input: {},
          }),
        { code: 'execution_reference_unavailable' },
      );
    }
    assert.deepEqual(await f.durable(), before);
    const begun = await call(client, 'workflow.begin', { ...input, expectedRevision: 1 });
    assert.equal(begun.workStart?.actorId, reviewer.actor.id);
    assert.equal(
      (await f.app.ctx.reviews.get(reviewer.caller, pending.reviewId!)).status,
      'requested',
    );
    const claimResult = await client.callTool({
      name: 'review.start',
      arguments: { reviewId: pending.reviewId! },
    });
    assert.equal(claimResult.isError, undefined);
    const claim = parse(claimResult);
    const assigned = await call(client, 'workflow.assignment', input);
    assert.deepEqual(
      (await f.http('workflow.assignment', input, reviewer.token)).body.result,
      assigned,
    );
    assert.deepEqual(assigned.context?.subject, {
      id: f.task.id,
      revision: 1,
      claimId: claim.claimId,
    });
    assert.deepEqual(assigned.handoff.tools, ['review.submit']);
    assert.equal(assigned.execution.policyHash, unclaimed.execution.policyHash);
    assert.deepEqual(assigned.execution.policy, unclaimed.execution.policy);
    const submission = assigned.execution.tools.find((tool) => tool.name === 'review.submit');
    assert.deepEqual(submission?.arguments, {
      reviewId: pending.reviewId,
      claimId: claim.claimId,
      expectedRevision: 1,
    });
    assert.ok(
      assigned.execution.tools.some(
        (tool) => tool.name === 'task.context' && tool.arguments.claimId === claim.claimId,
      ),
    );
    assert.ok(!assigned.execution.tools.some((tool) => tool.name === 'task.submit_delivery'));
    assert.equal((await f.durable()).contexts.length, 0);
    assert.equal((await f.durable()).starts.length, 1);
    const other = await f.issue('reviewer');
    assert.equal((await f.http('workflow.assignment', input, other.token)).status, 409);
    assert.equal(
      (await f.http('workflow.begin', { ...input, expectedRevision: 1 }, other.token)).status,
      409,
    );
  },
);
