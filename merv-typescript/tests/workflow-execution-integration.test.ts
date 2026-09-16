import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller, Data, WorkflowExecution } from '@merv/contracts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';

const dispatch = (execution: WorkflowExecution, tool: string, input: Data = {}) => ({
  instanceId: execution.instanceId,
  expectedRevision: execution.revision,
  policyHash: execution.policyHash,
  registrationId: execution.registrationId,
  tool,
  input,
});

test('HTTP and MCP assignments expose the fixed declaration without narrowing ordinary credentials', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-execution-transports-'));
  const app = await createApp({ directory, api: true, port: 0 });
  const client = new Client({ name: 'execution-foundation', version: '1' });
  try {
    const boot = await app.ctx.scope.bootstrap({ projectName: 'Transport', actorName: 'Operator' });
    const caller = { projectId: boot.project.id, actorId: boot.actor.id };
    const task = await app.ctx.tasks.create(caller, {
      title: 'Public declaration',
      goal: 'Expose fixed policy through the existing assignment tool.',
      checks: ['Both HTTP and MCP include the same policy hash.'],
      requestId: 'create',
    });
    const expected = await app.ctx.workflows.execution(caller, {
      instanceId: task.id,
      expectedRevision: task.workflow.revision,
    });
    const headers = { authorization: `Bearer ${boot.token}`, 'content-type': 'application/json' };
    const http = await fetch(`${app.ctx.api.url}/tools/workflow.assignment`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ instanceId: task.id }),
    });
    assert.equal(http.status, 200);
    const body = (await http.json()) as {
      result: { execution: { policyHash: string; policy: unknown } };
    };
    assert.equal(body.result.execution.policyHash, expected.policyHash);
    assert.deepEqual(body.result.execution.policy, expected.policy);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${app.ctx.api.url}/mcp`), {
        requestInit: { headers },
      }),
    );
    const result = await client.callTool({
      name: 'workflow.assignment',
      arguments: { instanceId: task.id },
    });
    assert.equal(result.isError, undefined);
    const mcp = JSON.parse((result.content as { text: string }[])[0].text);
    assert.deepEqual(mcp.execution, body.result.execution);
    const catalog = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(catalog.includes('task.create'), 'Ordinary credential keeps its existing catalog');
    assert.ok(!expected.policy.tools.some((tool) => tool.name === 'task.create'));
    const outside = await app.ctx.artifacts.create(caller, {
      title: 'Ordinary project access',
      content: 'No session authority is being claimed for this account.',
    });
    const read = await client.callTool({
      name: 'artifact.read',
      arguments: { artifactId: outside.id },
    });
    assert.equal(
      read.isError,
      undefined,
      'Existing account access must not be replaced by assignment hints',
    );
  } finally {
    await client.close();
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('real Cordis program reload and application restart fence old execution handles', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-execution-lifecycle-'));
  let app = await createApp({ directory });
  try {
    const boot = await app.ctx.scope.bootstrap({ projectName: 'Execution', actorName: 'Operator' });
    const caller: Caller = {
      projectId: boot.project.id,
      actorId: boot.actor.id,
      credentialId: boot.credential.id,
    };
    const task = await app.ctx.tasks.create(caller, {
      title: 'Durable policy',
      goal: 'Keep the policy stable across restarts.',
      checks: ['An old registration handle cannot regain authority.'],
      requestId: 'create',
    });
    const target = { instanceId: task.id, expectedRevision: task.workflow.revision };
    const original = await app.ctx.workflows.execution(caller, target);
    assert.deepEqual(
      (await app.ctx.workflows.authorizeDispatch(caller, dispatch(original, 'task.get'))).input,
      { taskId: task.id },
    );

    const workflows = app.ctx.workflows;
    await app.setEnabled('tasks', false);
    assert.equal(app.ctx.workflows, workflows, 'Only the program should have been withdrawn');
    await assert.rejects(
      async () => await workflows.authorizeDispatch(caller, dispatch(original, 'task.get')),
    );
    assert.equal((await app.ctx.scope.require(caller, 'read')).id, caller.actorId);
    await app.setEnabled('tasks', true);
    const reloaded = await workflows.execution(caller, target);
    assert.equal(reloaded.policyHash, original.policyHash);
    assert.notEqual(reloaded.registrationId, original.registrationId);
    await assert.rejects(
      async () => await workflows.authorizeDispatch(caller, dispatch(original, 'task.get')),
    );
    assert.equal(
      (await workflows.authorizeDispatch(caller, dispatch(reloaded, 'task.get'))).input.taskId,
      task.id,
    );

    await app.stop();
    app = await createApp({ directory });
    const restarted = await app.ctx.workflows.execution(caller, target);
    assert.equal(restarted.policyHash, original.policyHash);
    assert.deepEqual(restarted.policy, original.policy);
    assert.notEqual(restarted.registrationId, reloaded.registrationId);
    await assert.rejects(
      async () => await app.ctx.workflows.authorizeDispatch(caller, dispatch(reloaded, 'task.get')),
    );
    assert.equal(
      (await app.ctx.workflows.authorizeDispatch(caller, dispatch(restarted, 'task.get'))).input
        .taskId,
      task.id,
    );
    const replacement = await app.ctx.scope.issueActorCredential(caller, {
      actorId: caller.actorId,
    });
    await app.ctx.scope.revokeCredential(
      { ...caller, credentialId: replacement.credential.id },
      boot.credential.id,
    );
    await assert.rejects(
      async () =>
        await app.ctx.workflows.authorizeDispatch(caller, dispatch(restarted, 'task.get')),
    );
  } finally {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('execution admission remains usable when assignment document bytes are unavailable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-execution-metadata-'));
  const app = await createApp({ directory });
  try {
    const boot = await app.ctx.scope.bootstrap({ projectName: 'Metadata', actorName: 'Operator' });
    const caller = { projectId: boot.project.id, actorId: boot.actor.id };
    const task = await app.ctx.tasks.create(caller, {
      title: 'Separate rendering',
      goal: 'Keep admission independent of document rendering.',
      checks: ['Metadata admission does not fetch the brief bytes.'],
      requestId: 'create',
    });
    const target = { instanceId: task.id, expectedRevision: task.workflow.revision };
    const before = await app.ctx.workflows.execution(caller, target);
    const brief = await app.ctx.artifacts.get(caller, task.briefId);
    unlinkSync(join(directory, 'blobs', caller.projectId, brief.hash.slice(0, 2), brief.hash));
    await assert.rejects(async () => await app.ctx.workflows.assignment(caller, task.id), {
      code: 'blob_not_found',
    });
    assert.deepEqual(await app.ctx.workflows.execution(caller, target), before);
    const head = (await app.ctx.state.events(caller.projectId)).at(-1)!.id;
    await app.ctx.state.transaction(async (tx) => {
      const admitted = await app.ctx.workflows.authorizeDispatch(
        caller,
        dispatch(before, 'artifact.create', {
          title: 'Execution result',
          content: 'The metadata path remains available.',
        }),
        tx,
      );
      const artifact = await app.ctx.artifacts.create(
        caller,
        { title: String(admitted.input.title), content: String(admitted.input.content) },
        tx,
      );
      assert.equal(artifact.createdBy, caller.actorId);
    });
    assert.deepEqual(
      (await app.ctx.state.events(caller.projectId, head)).map((event) => event.type),
      ['artifact.created'],
      'Admission must not create a start marker, context package or guidance receipt',
    );
  } finally {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('policy permission is stable across begin and cannot be expanded by checkpoint evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-execution-checkpoints-'));
  const app = await createApp({ directory });
  try {
    const boot = await app.ctx.scope.bootstrap({
      projectName: 'Pinned authority',
      actorName: 'Operator',
    });
    const caller = { projectId: boot.project.id, actorId: boot.actor.id };
    const task = await app.ctx.tasks.create(caller, {
      title: 'Stable declarations',
      goal: 'Keep checkpoint text from granting document access.',
      checks: ['Checkpoint documents remain context, without adding execution grants.'],
      requestId: 'create',
    });
    const target = { instanceId: task.id, expectedRevision: task.workflow.revision };
    const original = await app.ctx.workflows.execution(caller, target);
    const before = await app.ctx.workflows.assignment(caller, task.id);
    assert.ok(original.policy.tools.some((tool) => tool.name === 'artifact.create'));
    assert.ok(original.policy.tools.some((tool) => tool.name === 'task.submit_delivery'));
    assert.equal(task.guidance.nextAction?.tool, 'workflow.begin');
    const begun = await app.ctx.workflows.begin(caller, target);
    assert.deepEqual(begun.execution, before.execution);
    assert.equal(
      (await app.ctx.tasks.get(caller, task.id)).guidance.nextAction?.tool,
      'task.submit_delivery',
    );

    const unrelated = await app.ctx.artifacts.create(caller, {
      title: 'Checkpoint attachment',
      content: 'This document is readable by this ordinary account.',
    });
    await app.ctx.tasks.checkpoint(caller, {
      taskId: task.id,
      purpose: 'work',
      expectedRevision: target.expectedRevision,
      notes: 'Useful continuity information.',
      artifactIds: [unrelated.id],
      requestId: 'checkpoint',
    });
    const current = await app.ctx.workflows.execution(caller, target);
    assert.deepEqual(current.policy, original.policy);
    assert.equal(current.policyHash, original.policyHash);
    await assert.rejects(
      async () =>
        await app.ctx.workflows.authorizeDispatch(
          caller,
          dispatch(current, 'artifact.read', { artifactId: unrelated.id }),
        ),
    );
    assert.equal(
      (
        await app.ctx.workflows.authorizeDispatch(
          caller,
          dispatch(current, 'artifact.read', { artifactId: task.briefId }),
        )
      ).input.artifactId,
      task.briefId,
    );
    assert.equal((await app.ctx.artifacts.read(caller, unrelated.id)).artifact.id, unrelated.id);
    await assert.rejects(
      async () =>
        await app.ctx.workflows.authorizeDispatch(caller, dispatch(current, 'task.create')),
    );
    await app.ctx.tasks.markFailed(caller, {
      taskId: task.id,
      expectedRevision: target.expectedRevision,
      reason: 'End the fixture assignment.',
      requestId: 'finish',
    });
    await assert.rejects(
      async () =>
        await app.ctx.workflows.authorizeDispatch(caller, dispatch(current, 'artifact.create')),
    );
  } finally {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
