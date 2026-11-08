import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Caller } from '@merv/contracts';
import { httpApp } from './fixtures/app.js';
import { waitForManagedCode } from './fixtures/managed-code.js';

test('an operator MCP caller can still open reports by name and legacy task reads keep flat guidance', async (t) => {
  const { app, tool } = await httpApp(t, 'merv-cached-research-');
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Compatibility',
    actorName: 'Owner',
  });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  await waitForManagedCode(app.ctx.codeWork, owner);
  const client = new Client({ name: 'compat', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${app.ctx.api.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${boot.token}` } },
    }),
  );
  t.after(() => client.close());
  const experiment = (
    await tool('experiment.create', boot.token, {
      name: 'Report',
      intent: 'Check the report.',
      requestId: 'experiment',
    })
  ).body.result;
  // The operator's cached report.open still reaches Reports, though MCP no longer lists it.
  const subject = { subjectKind: 'experiment', subjectId: experiment.id };
  const opens: unknown[] = [];
  app.ctx.reports.open = async (caller, input) => {
    assert.equal(caller.actorId, owner.actorId);
    opens.push(input);
    return { reportId: 'compat_report' } as never;
  };
  const opened = await client.callTool({ name: 'report.open', arguments: subject });
  assert.ok(!opened.isError);
  assert.deepEqual(opens, [subject]);
  assert.ok(!(await client.listTools()).tools.some(({ name }) => name === 'report.open'));

  const created = await tool('task.create', boot.token, {
    title: 'Stop',
    goal: 'Check guidance.',
    checks: ['Checked.'],
    requestId: 'task',
  });
  const task = created.body.result;
  const marking = (value: any) =>
    value.guidance.actions.find((step: any) => step.action === 'mark_failed');
  assert.equal(marking(task).tool, 'task.mark_failed');
  const legacy = await tool('task.get', boot.token, { taskId: task.id, full: true });
  assert.deepEqual(marking(legacy.body.result).arguments, {
    taskId: task.id,
    expectedRevision: task.workflow.revision,
  });
  const modern = await client.callTool({
    name: 'task.read',
    arguments: { action: 'get', get: { taskId: task.id, full: true } },
  });
  assert.ok(!modern.isError);
  const value = JSON.parse((modern.content as { text: string }[])[0]!.text);
  assert.deepEqual(marking(value).arguments, {
    action: 'mark_failed',
    mark_failed: marking(task).arguments,
  });
  assert.equal(marking(value).tool, 'task.write');
});
