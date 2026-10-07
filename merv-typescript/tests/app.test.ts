import { currentTask } from './fixtures/current-work.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from './fixtures/app.js';
import { storedContext } from './fixtures/state.js';
import { describeTool, isRemoteTool } from '../packages/api/src/registry.js';
import { conversationUse } from '../packages/pi/src/conversation-rules.js';
import { fit } from '../packages/pi/src/fit.js';
import type { ToolDefinition } from '../packages/api/src/types.js';
import { piTool } from '../packages/pi/src/relay-schema.js';
import { fetchesContent } from '../packages/fleet/src/model-requests.js';
import { piModelToolName } from '../packages/pi/src/tool-names.js';
import { piInstructions, turnNotes } from '../packages/pi/src/prompt.js';
import { researchGuide } from '../packages/research/src/guide.js';
import { toolsGuide } from '../packages/api/src/guide.js';

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
    assert.equal(catalog.length, 86);
    assert.equal(
      catalog.some((tool) => tool.name === 'code.backup.run'),
      false,
    );
    for (const name of [
      'system.status',
      'session.dispatch',
      'session.halt',
      'session.observe',
      'session.threads',
      'session.find',
      'session.message',
      'session.messages',
    ])
      assert.ok(
        catalog.some((tool) => tool.name === name),
        `${name} must be discoverable`,
      );
    for (const name of ['paper.begin_update', 'paper.publish', 'paper.cancel'])
      assert.ok(!catalog.some((tool) => tool.name === name));
    // Credentials are managed from Merv's own pages: an agent over MCP is not offered them.
    for (const name of [
      'actor.credentials',
      'actor.issue_token',
      'actor.rotate_token',
      'actor.revoke_token',
    ])
      assert.ok(
        !catalog.some((tool) => tool.name === name),
        `${name} must not be offered to an agent`,
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
    assert.deepEqual(guidance, task.guidance);
    assert.ok(guidance.nextAction);
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
test('application stop disposes Cordis and the state store after API shutdown rejects', async () => {
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
test('a paper too long to show the agent whole reads on section by section', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-app-'));
  const app = await createApp({ directory, api: true, port: 0 });
  try {
    const boot = await app.ctx.scope.credentials.bootstrap({
      projectName: 'Paper',
      actorName: 'Owner',
    });
    const caller = { actorId: boot.actor.id, projectId: boot.project.id };
    const read = async (input: object) =>
      fit('paper.read', await app.ctx.tools.call('paper.read', caller, input)) as {
        index?: { current: { sections: { id: string; content: string }[] } };
        note: string;
        content: string;
      };
    const long = (letter: string, length: number) =>
      Array.from({ length }, (_, n) => (n % 80 === 79 ? '\n' : letter)).join('');
    const sections = ['a', 'b', 'c'].map((id) => ({ id, title: id, content: long(id, 12_000) }));
    sections.push({ id: 'd', title: 'd', content: long('d', 70_000) });
    await app.ctx.tools.call('paper.patch', caller, {
      kind: 'methods',
      expectedRevision: 0,
      requestId: 'methods',
      changes: sections,
    });
    // The document comes back as its sections' ids and openings, and says how to read one.
    const document = await read({ kind: 'methods' });
    assert.deepEqual(
      document.index!.current.sections.map(({ id }) => id),
      ['a', 'b', 'c', 'd'],
    );
    assert.equal(document.index!.current.sections[0].content.length, 301);
    assert.equal(
      document.note,
      'Shown as an index: read one record with its get tool, or one part with a narrower paper.read call',
    );
    // One section comes back whole; one too long for that, in slices that read on.
    assert.equal((await read({ kind: 'methods', section: 'b' })).content, sections[1].content);
    const first = await read({ kind: 'methods', section: 'd' });
    const end = first.content.length;
    assert.ok(end > 20_000 && end < 32_000);
    assert.equal(first.note, `Characters 0–${end} of 70000 are shown; read on with offset ${end}`);
    const next = await read({ kind: 'methods', section: 'd', offset: end });
    assert.equal(
      first.content + next.content,
      sections[3].content.slice(0, end + next.content.length),
    );
    // A later revision changes d; the earlier one still reads on, section by section.
    await app.ctx.tools.call('paper.patch', caller, {
      kind: 'methods',
      expectedRevision: 1,
      requestId: 'methods-2',
      changes: [{ id: 'd', content: long('e', 70_000) }],
    });
    const old = await read({ kind: 'methods', revision: 1, section: 'd' });
    assert.equal(old.content.length, end);
    assert.equal(old.note, first.note);
    const rest = await read({ kind: 'methods', revision: 1, section: 'd', offset: end });
    assert.equal(old.content + rest.content, first.content + next.content);
    assert.equal(
      (await read({ kind: 'methods', section: 'd' })).content,
      long('e', 70_000).slice(0, end),
    );
    await assert.rejects(
      app.ctx.tools.call('paper.read', caller, { kind: 'methods', revision: 3, section: 'd' }),
      { code: 'not_found' },
    );
    await assert.rejects(app.ctx.tools.call('paper.read', caller, { section: 'd' }), {
      code: 'invalid_paper_input',
    });
    await assert.rejects(app.ctx.tools.call('paper.read', caller, { revision: 1 }), {
      code: 'invalid_paper_input',
    });
    await assert.rejects(
      app.ctx.tools.call('paper.read', caller, { kind: 'results', section: 'd' }),
      { code: 'not_found' },
    );
  } finally {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
test('a call an agent proposes is titled in the words of the plugin that owns its tool', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-app-'));
  const app = await createApp({ directory, api: true, port: 0 });
  try {
    const tools = new Map((await app.ctx.tools.list()).map((tool) => [tool.name, tool]));
    const act = (name: string, input: Record<string, unknown> = {}) => {
      const declared = (tools.get(name) as ToolDefinition).act!;
      const title = typeof declared.title === 'string' ? declared.title : declared.title(input);
      return declared.says ? [title, declared.says] : [title];
    };
    const titles: [string, Record<string, unknown>, string[]][] = [
      ['session.dispatch', { enabled: false, ownMachines: true }, ['Pause dispatch', 'enabled']],
      ['session.dispatch', { enabled: true }, ['Start dispatch', 'enabled']],
      ['session.halt', { sessionId: 'session_1' }, ['Halt lease']],
      ['session.halt', {}, ['Halt all leases']],
      ['research.advance', { researchId: 'research_1' }, ['Start next step']],
      ['review.start', {}, ['Claim review']],
      ['review.submit', {}, ['Submit verdict']],
      ['task.submit_delivery', {}, ['Submit delivery']],
      ['task.mark_failed', {}, ['Mark task failed']],
      ['experiment.transition', { transition: 'abandon' }, ['Abandon experiment', 'transition']],
      [
        'experiment.transition',
        { transition: 'mark_failed' },
        ['Mark experiment failed', 'transition'],
      ],
      ['experiment.transition', { transition: 'submit_design' }, ['Submit design', 'transition']],
      ['code.publication.control', { action: 'clear' }, ['Clear publication', 'action']],
      ['code.local.bind', {}, ['Bind repository']],
      ['artifact.read', {}, ['Read file', 'mode']],
      ['artifact.read', { mode: 'download' }, ['Download file', 'mode']],
    ];
    for (const [name, input, said] of titles) assert.deepEqual(act(name, input), said, name);
    // A tool whose owner names no act is said in its own words, on the page.
    assert.equal((tools.get('task.create') as ToolDefinition).act, undefined);
  } finally {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('each paper-keeping review owner tells its reviewers exactly what it told them before', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-app-'));
  const app = await createApp({ directory, api: true, port: 0 });
  try {
    const owners = (app.ctx.reviews as unknown as { owners: Map<string, { guidance?: string }> })
      .owners;
    assert.equal(
      owners.get('experiments')?.guidance,
      'Pass rejects returnTo. A rejected design returns only to planned. A rejected results review must choose returnTo planned for a new design/attempt, or running for repair under the same approved plan. Experiment design and results reviewers own Methods/Results updates: include your own paperChanges: {documents: [{kind: methods or results, expectedRevision, changes: [{id, title, content}]}]}. Cite experiments as [Experiment name](/experiments/EXPERIMENT_ID), using the actual name as the visible label and keeping IDs in link destinations. Read the current paper first, distinguish planned work from established findings, and integrate the evidence into the project narrative. Keep design-review paper updates brief, usually one or two sentences. Results reviewers may add comprehensive detail when it helps explain the project’s trajectory and informs what comes next. Edits save with any verdict; if none are needed, explain why in notes.',
    );
    assert.equal(
      owners.get('reflections')?.guidance,
      'Pass rejects returnTo; a rejection returns to synthesizing (the default) or reflecting. Reflection reviewers own Methods/Results updates: include your own paperChanges: {documents: [{kind: methods or results, expectedRevision, changes: [{id, title, content}]}]}. Cite experiments as [Experiment name](/experiments/EXPERIMENT_ID), using the actual name as the visible label and keeping IDs in link destinations. Read the current paper first, distinguish planned work from established findings, and integrate the evidence into the project narrative. You may add comprehensive detail when it helps explain the project’s trajectory and informs what comes next. Edits save with any verdict; if none are needed, explain why in notes.',
    );
  } finally {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('every tool reaches an agent conversation as the relay accepts it, under its own model name', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-app-'));
  const app = await createApp({ directory, api: true, port: 0 });
  try {
    const offered = (await app.ctx.tools.list()).filter(
      (tool): tool is ToolDefinition =>
        !isRemoteTool(tool) && tool.conversation !== 'never' && !tool.name.startsWith('pi.'),
    );
    // A tool the relay would refuse is dropped from every turn: none may be.
    assert.deepEqual(
      offered
        .filter((tool) => !piTool(describeTool(tool), tool.conversation))
        .map(({ name }) => name),
      [],
    );
    // Hosted Codex sees each MCP tool's schema whole, its dialect included, under the same rule.
    const native = (await app.ctx.tools.list()).filter(
      (tool): tool is ToolDefinition => !isRemoteTool(tool),
    );
    assert.deepEqual(
      native
        .filter((tool) =>
          fetchesContent({
            tools: [{ type: 'function', parameters: describeTool(tool).inputSchema }],
          }),
        )
        .map(({ name }) => name),
      [],
    );
    const models = ['machine.switch', ...offered.map(({ name }) => name)].map(piModelToolName);
    assert.equal(new Set(models).size, models.length);
    assert.ok(models.length <= 128, `${models.length} tools`);
    // The full composition gives every main agent what each plugin adds about its own tools (the
    // research guide; Tasks, Paper, Sessions and Workflows), then the registry's own, which names
    // no tool, and every tool the agent's instructions and notes name is registered.
    assert.doesNotMatch(toolsGuide, /\b[a-z]+\.[a-z_]+\b/);
    for (const part of [
      researchGuide,
      toolsGuide,
      'leave production to a Fleet worker',
      'task.get returns',
      'paper.patch (kind problem)',
      'change the Problem to change it',
      'session.find with',
      'session.stuck says',
      'workflow.status_and_next and workflow.assignment',
    ])
      assert.ok(app.ctx.tools.instructions().includes(part), part);
    const named = [
      piInstructions(app.ctx.tools.instructions()),
      ...turnNotes({
        role: 'producer',
        actorId: 'actor_1',
        projectId: 'project_1',
        model: { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
        today: '2026-09-25',
      }),
    ].join('\n');
    const names = [...named.matchAll(/\b[a-z]+(?:\.[a-z_]+)+\b/g)].map(([name]) => name);
    assert.ok(names.length > 10);
    for (const name of names)
      assert.ok(
        offered.some((tool) => tool.name === name),
        name,
      );
    // Whatever fails work, claims or decides a review, starts or ends a reflection wave, or
    // moves or ends a cycle is proposed, by every tool that reaches it.
    for (const name of [
      'task.mark_failed',
      'review.start',
      'review.submit',
      'reflection.create',
      'reflection.end',
      'research.advance',
      'research.end',
    ])
      for (const verdict of ['pass', 'needs_changes', 'fail'])
        assert.equal(
          conversationUse(
            offered.find((tool) => tool.name === name)!,
            { verdict },
          ),
          'propose',
          `${name} ${verdict}`,
        );
    // MCP clients working with a person get the same guide.
    const credentials = await app.ctx.scope.credentials.bootstrap({
      projectName: 'Guide',
      actorName: 'Owner',
    });
    const mcp = await client(app.ctx.api.url!, credentials.token);
    assert.ok(mcp.getInstructions()?.startsWith(app.ctx.tools.instructions()));
    // The Sessions page's controls, as tools.
    assert.equal((await call(mcp, 'session.dispatch', { enabled: true })).enabled, true);
    assert.deepEqual(await call(mcp, 'session.halt', { reason: 'pause' }), { halted: 0 });
    const observed = await mcp.callTool({ name: 'session.observe', arguments: { agentId: 'x' } });
    assert.match(JSON.stringify(observed.content), /agent_not_found/);
    await mcp.close();
  } finally {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
