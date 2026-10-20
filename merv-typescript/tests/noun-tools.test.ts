/**
 * The noun-tool mechanism: one read and one write tool per noun, each taking `action` and the
 * argument object named after it; tiers that MCP and Pi both read; retired names kept as hidden
 * executable aliases; the outside-agent call log; per-action openWorld and declared outputs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Context } from 'cordis';
import { z } from 'zod';
import type { Caller, Data, SessionToolPolicy } from '@merv/contracts';
import { noun, nounOutputs } from '../packages/api/src/noun.js';
import { AgentCallLog } from '../packages/api/src/call-log.js';
import { describeTool, ToolRegistry } from '../packages/api/src/registry.js';
import type { AgentToolCall, NounDefinition, ToolDefinition } from '../packages/api/src/types.js';
import { codeToolsPlugin } from '../packages/code-work/src/tools.js';
import { taskToolsPlugin } from '../packages/tasks/src/tools.js';
import { conversationRules } from '../packages/pi/src/conversation-rules.js';
import { PiProfiles } from '../packages/pi/src/profiles.js';
import { profileGrants, requireGranted } from '../packages/pi/src/profile-tools.js';
import { declaration } from '../packages/scripts/src/declare.js';
import { code, fixture } from './fixtures/pi.js';

const owner: Caller = { projectId: 'project_1', actorId: 'owner' };
const reader: Caller = { projectId: 'project_1', actorId: 'reader' };
const conversation: Caller = {
  ...owner,
  conversation: {
    id: 'conversation_1',
    commandId: 'command_1',
    ownerActorId: 'owner',
    ownerUserId: null,
  } as never,
};
const worker: Caller = { ...owner, actorId: 'worker', session: { id: 'session_1' } };
/** Scope as callers' roles would answer it: the reader reads, everyone else operates. */
const scope = {
  require: async (caller: Caller) => ({
    role: caller.actorId === 'reader' ? 'reader' : 'operator',
  }),
};

/** A leased session granted `granted` by its frozen policy; it records how each call is known. */
function sessionPolicy(granted: string[]) {
  const seen: { name: string; identity?: { as: string; args: Data } }[] = [];
  const policy: SessionToolPolicy = {
    allowsTool: async (_caller, name, read) => !!read || granted.includes(name),
    prepare: async (caller, name, input, _read, identity) => {
      seen.push({ name, identity });
      return { caller, tool: name, input };
    },
    validate: async () => {},
    cancel: () => {},
    run: async (invocation, handler) => await handler(invocation.caller, invocation.input),
  };
  return { policy, seen };
}

/** The Code nouns over a Code Work that echoes what each call reached it with. */
function registry(log?: (call: AgentToolCall) => void) {
  let snapshots = 0;
  const tools = new ToolRegistry(
    scope as never,
    undefined,
    async (fn) => {
      snapshots++;
      return await fn();
    },
    log,
  );
  // An operation is read as a worker reads its command (attached), so it answers one.
  const reached = (method: string) => async (_caller: Caller, input?: unknown) => ({
    method,
    input: input ?? null,
    ...(method === 'operation' && { command: { workspace: {} } }),
  });
  const codeWork = new Proxy({}, { get: (_target, method: string) => reached(method) });
  codeToolsPlugin.apply({ codeWork, tools, effect: (fn: () => unknown) => fn() } as never);
  tools.registerCallerRules('conversation', conversationRules);
  return {
    tools,
    get snapshots() {
      return snapshots;
    },
  };
}
const refusal = (call: Promise<unknown>) =>
  call.then(
    () => assert.fail('the call was not refused'),
    (error: { code: string; message: string; status: number; details?: unknown }) => error,
  );

test('a noun call takes its action and that action’s object, and names what it got wrong', async () => {
  const { tools } = registry();
  const files = await tools.call('code.read', owner, { action: 'files', files: { path: 'a' } });
  assert.deepEqual(files, { method: 'files', input: { path: 'a' } });
  // The chosen action's object is required, and its error names the fields it holds.
  const missing = await refusal(
    tools.call('code.write', owner, { action: 'unit_fence', base_retry: {} }),
  );
  assert.equal(missing.code, 'invalid_input');
  const issues = (missing.details ?? []) as { path: string[]; message: string }[];
  assert.deepEqual(
    issues.map(({ path, message }) => [path.join('.'), message]),
    [
      ['base_retry', '"base_retry" belongs to action base_retry; this call is action unit_fence'],
      [
        'unit_fence',
        'action unit_fence takes its arguments under "unit_fence": {unitId, requestId}',
      ],
    ],
  );
  // A string under the action's own key (an inner field of the same name, like transition's)
  // with the arguments left flat is told where they go, not that a string is no object.
  const misplaced = await refusal(
    tools.call('code.write', owner, {
      action: 'unit_fence',
      unit_fence: 'abandon',
      unitId: 'u',
      requestId: 'r',
    }),
  );
  assert.deepEqual(
    (misplaced.details as { path: string[]; message: string }[]).map(({ path, message }) => [
      path.join('.'),
      message,
    ]),
    [
      [
        'unit_fence',
        'action unit_fence takes its arguments under "unit_fence": {unitId, requestId}',
      ],
    ],
  );
  // An unknown action is the enum's own error, which lists the actions.
  const unknown = await refusal(tools.call('code.read', owner, { action: 'grep', grep: {} }));
  assert.match(JSON.stringify(unknown.details), /files.*log.*status.*unit.*operation/);
  // An action whose fields are all optional may leave its object out.
  assert.deepEqual(await tools.call('code.read', owner, { action: 'status' }), {
    method: 'status',
    input: null,
  });
  // Inner issues keep their nested paths; an inner field named action is the action's own.
  const inner = await refusal(
    tools.call('code.write', owner, {
      action: 'publication_control',
      publication_control: { action: 'reopen', reason: 'x', requestId: 'r' },
    }),
  );
  assert.deepEqual(
    (inner.details as { path: string[] }[]).map(({ path }) => path.join('.')),
    ['publication_control.action'],
  );
  assert.deepEqual(
    await tools.call('code.write', owner, {
      action: 'publication_control',
      publication_control: { action: 'clear', reason: 'Canary passed', requestId: 'r' },
    }),
    {
      method: 'controlPublication',
      input: { action: 'clear', reason: 'Canary passed', requestId: 'r' },
    },
  );
  // A refined input is unwrapped only to describe it: its refinement still refuses.
  const refined = await refusal(
    tools.call('code.write', owner, {
      action: 'repository_import',
      repository_import: { source: 'github', requestId: 'import' },
    }),
  );
  assert.match(refined.message, /failed validation/);
  assert.deepEqual(
    (refined.details as { path: string[]; message: string }[]).map(({ path, message }) => [
      path.join('.'),
      message,
    ]),
    [['repository_import', 'A bundle import names tip and bundle; a GitHub import names ref']],
  );
  const missingImport = await refusal(
    tools.call('code.write', owner, { action: 'repository_import' }),
  );
  assert.match(
    JSON.stringify(missingImport.details),
    /takes its arguments under \\"repository_import\\": \{source, tip, bundle, ref, …\}/,
  );
  // A base control keeps its retired name's flat body, so request digests match in both forms.
  const key = 'a'.repeat(64);
  const body = { key, reason: 'Flaky machine', requestId: 'retry-1' };
  const flat = await tools.call('code.base.retry', owner, body);
  const nouned = await tools.call('code.write', owner, { action: 'base_retry', base_retry: body });
  assert.deepEqual(flat, nouned);
  assert.deepEqual(nouned, { method: 'controlBase', input: { ...body, action: 'retry' } });
  // An address takes the action's own arguments.
  assert.deepEqual(await tools.call('code.write:base_retry', owner, body), nouned);
});

test('a noun tool is described as one object root, every action object whole, core loaded up front', async () => {
  const { tools } = registry();
  const described = new Map((await tools.describe(owner, true)).map((tool) => [tool.name, tool]));
  assert.deepEqual([...described.keys()], ['code.read', 'code.write']);
  for (const tool of described.values()) {
    const schema = tool.inputSchema as Record<string, any>;
    assert.equal(schema.type, 'object');
    assert.equal(schema.anyOf, undefined, `${tool.name} has no top-level anyOf`);
    assert.deepEqual(schema.required, ['action']);
    for (const action of schema.properties.action.enum as string[]) {
      const object = schema.properties[action];
      assert.equal(object.type, 'object', `${tool.name} ${action}`);
      assert.match(object.description, new RegExp(`^Required when action is "${action}"; omit`));
    }
    assert.ok(tool.description!.length <= 600, `${tool.name}'s summary is at most 600 characters`);
    assert.match(tool.description!, /\{"action":"x","x":\{…\}\}/);
    // A noun's requestId is inside its actions, so it claims no idempotence.
    assert.equal(tool.annotations?.idempotentHint, undefined);
  }
  const write = described.get('code.write')!.inputSchema as Record<string, any>;
  // Its own required list, nested enums and the refined input's fields.
  assert.deepEqual(write.properties.base_retry.required, ['key', 'reason', 'requestId']);
  assert.deepEqual(write.properties.repository_import.properties.source.enum, ['bundle', 'github']);
  assert.deepEqual(write.properties.publication_sync.properties, {});
  // alwaysLoad is Claude Code's: a core tool's whole schema loads into every context.
  assert.deepEqual(described.get('code.read')!._meta, { 'anthropic/alwaysLoad': true });
  assert.equal(described.get('code.write')!._meta, undefined);
  // Budgets per supported client (Claude Code, Codex CLI over MCP, Cursor, Pi's adapter): the
  // emitted payload in bytes and its nesting depth, pinned where they stand now.
  const depth = (value: unknown): number =>
    value && typeof value === 'object'
      ? 1 + Math.max(0, ...Object.values(value).map((entry) => depth(entry)))
      : 0;
  for (const [name, bytes, nesting] of [
    ['code.read', 8_000, 6],
    ['code.write', 20_000, 13],
  ] as const) {
    const tool = described.get(name)!;
    assert.ok(JSON.stringify(tool).length <= bytes, `${name} within ${bytes} bytes`);
    assert.ok(depth(tool.inputSchema) <= nesting, `${name} nests at most ${nesting} deep`);
  }
});

test('a retired name runs its noun action for every caller for one release, then tells all but a worker the noun', async () => {
  const { tools } = registry();
  const { policy } = sessionPolicy(['code.operation', 'code.commit']);
  tools.registerSessionPolicy(policy);
  const input = { commandId: 'codecmd_1' };
  const expected = { method: 'operation', input: 'codecmd_1' };
  const operation = (result: unknown) => {
    const { method, input } = result as { method: string; input: unknown };
    return { method, input };
  };
  // The page, an MCP agent, a Pi conversation and a leased worker all run it.
  assert.deepEqual(operation(await tools.call('code.operation', owner, input)), expected);
  assert.deepEqual(
    operation((await tools.invoke('code.operation', owner, input, true)).value),
    expected,
  );
  assert.deepEqual(operation(await tools.call('code.operation', conversation, input)), expected);
  assert.deepEqual(operation(await tools.call('code.operation', worker, input)), expected);
  // Listed to no agent or Pi conversation; a leased session is listed it as the old tool was.
  const names = async (caller: Caller, agent = false) =>
    (await tools.describe(caller, agent)).map(({ name }) => name);
  assert.ok(!(await names(owner, true)).includes('code.operation'));
  assert.ok(!(await names(conversation)).includes('code.operation'));
  assert.ok(!(await names(owner)).includes('code.operation'), 'nor to a page');
  const listed = await names(worker, true);
  assert.deepEqual(
    listed.filter((name) => name.startsWith('code.')),
    [
      'code.commit',
      'code.files',
      'code.log',
      'code.operation',
      'code.publication.read',
      'code.status',
      'code.unit.get',
    ],
    'a leased worker is listed exactly the old names it was listed, and no noun tool',
  );
  assert.equal(
    (await tools.describe(worker, true)).find(({ name }) => name === 'code.files')!.inputSchema
      .properties?.ref !== undefined,
    true,
    'with the old flat schema',
  );
  // After the window every caller but a leased session is told the noun, with its input wrapped.
  tools.aliasesOpen = false;
  for (const caller of [owner, conversation]) {
    const renamed = await refusal(tools.call('code.operation', caller, input));
    assert.deepEqual([renamed.code, renamed.status], ['tool_renamed', 404]);
    assert.equal(
      renamed.message,
      'code.operation is now code.read with action operation: {"action":"operation","operation":{"commandId":"codecmd_1"}}',
    );
    assert.deepEqual(renamed.details, {
      tool: 'code.read',
      action: 'operation',
      arguments: { action: 'operation', operation: input },
    });
  }
  assert.deepEqual(operation(await tools.call('code.operation', worker, input)), expected);
  // A name with no executable path answers at once, with nothing to retry.
  tools.aliasesOpen = true;
  const removed = await refusal(tools.call('code.local.bind', owner, {}));
  assert.deepEqual(
    [removed.code, removed.details],
    ['tool_renamed', { tool: 'code.write', action: 'repository_prepare' }],
  );
});

test('Sessions knows a retired name and its noun action as one call', async () => {
  const { tools } = registry();
  const { policy, seen } = sessionPolicy([]);
  tools.registerSessionPolicy(policy);
  await tools.call('code.operation', worker, { commandId: 'codecmd_1' });
  await tools.call('code.read', worker, {
    action: 'operation',
    operation: { commandId: 'codecmd_1' },
  });
  await tools.call('code.read:operation', worker, { commandId: 'codecmd_1' });
  await tools.call('code.read', worker, { action: 'status' });
  // Grants see the name as called; the rules keyed on a name see one identity.
  assert.deepEqual(
    seen.map(({ name, identity }) => [name, identity]),
    [
      ['code.operation', { as: 'code.operation', args: { commandId: 'codecmd_1' } }],
      ['code.read', { as: 'code.operation', args: { commandId: 'codecmd_1' } }],
      ['code.read', { as: 'code.operation', args: { commandId: 'codecmd_1' } }],
      ['code.read', { as: 'code.status', args: {} }],
    ],
  );
  assert.deepEqual(tools.identity('code.operation', { commandId: 'c' }), {
    tool: 'code.read',
    action: 'operation',
    as: 'code.operation',
    args: { commandId: 'c' },
  });
});

test('tiers: core and deferred reach every agent, worker only a profile that names it, ui only pages', async () => {
  const tools = new ToolRegistry(scope as never);
  tools.registerCallerRules('conversation', conversationRules);
  const input = z.object({}).strict();
  for (const [name, tier] of [
    ['x.core', 'core'],
    ['x.deferred', 'deferred'],
    ['x.worker', 'worker'],
    ['x.ui', 'ui'],
  ] as const)
    tools.register({ name, description: name, inputSchema: input, tier, handler: () => name });
  tools.register({
    name: 'x.chat',
    description: 'Pi conversations only',
    inputSchema: input,
    for: 'conversations',
    handler: () => 'chat',
  });
  const names = async (caller: Caller, agent = false) =>
    (await tools.describe(caller, agent)).map(({ name }) => name);
  assert.deepEqual(await names(owner, true), ['x.core', 'x.deferred']);
  assert.deepEqual(await names(reader, true), [], "a reader's agent is listed reads alone");
  // A conversation reaches every tier but ui; Pi's own offer leaves tier worker to profiles.
  assert.deepEqual(await names(conversation), ['x.chat', 'x.core', 'x.deferred', 'x.worker']);
  await assert.rejects(tools.call('x.ui', conversation, {}), { code: 'tool_forbidden' });
  for (const name of ['x.worker', 'x.ui', 'x.chat'])
    await assert.rejects(tools.invoke(name, owner, {}, true), { code: 'tool_forbidden' });
  assert.equal(await tools.call('x.ui', owner, {}), 'x.ui');
  // The vendored Sandboxes host's page-only mark reads as tier ui.
  tools.register({
    name: 'x.legacy',
    description: 'Legacy',
    inputSchema: input,
    conversation: 'never',
    handler: () => 1,
  } as ToolDefinition);
  assert.equal(tools.tool('x.legacy')?.tier, 'ui');
});

test('Pi keeps the task tools it was offered before tiers; MCP agents are still listed none', async () => {
  const tools = new ToolRegistry(scope as never);
  tools.registerCallerRules('conversation', conversationRules);
  taskToolsPlugin.apply({ tools, tasks: {}, effect: (fn: () => unknown) => fn() } as never);
  const kept = ['task.checkpoint', 'task.context', 'task.submit_delivery'];
  // Pi's turn offer leaves tier worker to the profiles that name it.
  for (const name of kept) assert.notEqual(tools.tool(name)?.tier, 'worker', name);
  const chat = (await tools.describe(conversation)).map(({ name }) => name);
  for (const name of kept) assert.ok(chat.includes(name), name);
  const agent = (await tools.describe(owner, true)).map(({ name }) => name);
  for (const name of kept) assert.ok(!agent.includes(name), name);
});

test('Pi offers a tier worker tool only to a profile that names it, cut to the actions it names', async (t) => {
  const f = await fixture(t);
  f.tools.register({
    name: 'report.write',
    description: 'A worker’s report',
    tier: 'worker',
    inputSchema: z.object({}).strict(),
    handler: () => 'written',
  });
  let looked = 0;
  f.tools.register(
    noun('probe.read', {
      tier: 'core',
      readOnly: true,
      description: 'Read probes: get one, list them.',
      actions: {
        get: {
          description: 'One probe.',
          input: z.object({ id: z.string() }).strict(),
          was: ['probe.get'],
          handler: (_caller, { id }) => ({ id }),
        },
        list: {
          description: 'Every probe.',
          input: z.object({}).strict(),
          handler: () => {
            looked++;
            return [];
          },
        },
      },
    }),
  );
  // A profile may name a tool or one action of one; its stored hash is over what it names.
  const profile = {
    id: 'probe-role',
    version: 1,
    model: { id: 'gpt-6-sol', effort: 'none' as const },
    instructions: 'Read the probe you are given.',
    tools: ['probe.read:get', 'report.write'],
    authorizeTool: async ({
      name,
      action,
      input,
    }: {
      name: string;
      action?: string;
      input: object;
    }) => {
      authorized.push([name, action, input]);
    },
  };
  const authorized: unknown[] = [];
  f.pi.registerProfile(profile);
  const conversation = await f.pi.createProfiled(f.operator, {
    requestId: 'probe-open',
    title: 'Probe',
    profile: { id: profile.id, version: 1, requestId: 'probe_1' },
  });
  const bound = await f.claimed(await f.send(conversation));
  const offered = new Map(bound.work.tools.map((tool) => [tool.name, tool]));
  assert.deepEqual([...offered.keys()].sort(), ['probe.read', 'report.write']);
  const schema = offered.get('probe.read')!.inputSchema as Record<string, any>;
  assert.deepEqual(schema.properties.action.enum, ['get']);
  assert.equal(schema.properties.list, undefined);
  await f.pi.begin(bound.token, bound.input);
  const call = (name: string, input: object) =>
    f.pi.tool(bound.token, { ...bound.input, name, input });
  assert.deepEqual(await call('probe.read', { action: 'get', get: { id: 'p1' } }), { id: 'p1' });
  await assert.rejects(call('probe.read', { action: 'list' }), code('pi_profile_action_forbidden'));
  assert.equal(looked, 0);
  // The profile's own check sees the call as rules know it: by its retired name, flat.
  assert.deepEqual(authorized, [['probe.get', 'get', { id: 'p1' }]]);
  await f.pi.complete(bound.token, f.completion(bound.input));
  const plain = (await f.begun(f.operator)).work.tools.map(({ name }) => name);
  assert.ok(plain.includes('probe.read'));
  assert.ok(!plain.includes('report.write'), 'a worker’s report is not the chat’s');
  assert.ok(!plain.includes('probe.get'), 'a retired name is offered to no conversation');
});

test('a profile naming an address registers, and one naming only tools keeps its hash', () => {
  const profiles = new PiProfiles();
  const base = {
    id: 'intake',
    version: 8,
    model: { id: 'gpt-6-astra', effort: 'medium' as const },
    instructions: 'Interview.',
    tools: ['customer_experiments.request', 'customer_experiments.plan'],
  };
  profiles.register(base);
  const stored = profiles.bind({ id: 'intake', version: 8, requestId: 'r' });
  // The digest of the definition as written, as before addresses: no stored hash moves.
  assert.equal(
    stored.definitionHash,
    '55bdd595066f8182716a8a759aff2db39394c059b74753045e44994719608133',
  );
  profiles.register({ ...base, version: 9, tools: ['intake.read:request', 'intake.write'] });
  assert.ok(profiles.bind({ id: 'intake', version: 9, requestId: 'r' }).definitionHash);
  assert.throws(() => profiles.register({ ...base, version: 10, tools: ['intake.read:Request'] }), {
    code: 'pi_profile_invalid',
  });
  // Resolution is separate from the hash: a retired name grants the old tool it names (which runs
  // as its noun action), an address only that action.
  const grants = profileGrants([
    'customer_experiments.request',
    'intake.read:request',
    'board.read',
  ]);
  assert.deepEqual(
    [...grants].map(([tool, actions]) => [tool, actions && [...actions]]),
    [
      ['customer_experiments.request', null],
      ['intake.read', ['request']],
      ['board.read', null],
    ],
  );
  requireGranted(grants, 'intake.read', {
    tool: 'intake.read',
    action: 'request',
    as: 'customer_experiments.request',
    args: {},
  });
  assert.throws(
    () =>
      requireGranted(grants, 'intake.read', {
        tool: 'intake.read',
        action: 'plan',
        as: 'customer_experiments.plan',
        args: {},
      }),
    { code: 'pi_profile_action_forbidden' },
  );
  assert.throws(() => requireGranted(grants, 'intake.write'), { code: 'pi_tool_forbidden' });
});

test('every outside agent’s call is logged per tool and action with its outcome; workers and Pi are not', async () => {
  const calls: AgentToolCall[] = [];
  const { tools } = registry((call) => calls.push(call));
  tools.registerSessionPolicy(sessionPolicy([]).policy);
  await tools.invoke('code.read', owner, { action: 'status' }, true, undefined, 'claude-code/2.1');
  await tools.invoke('code.status', owner, {}, true);
  await refusal(tools.invoke('code.write', owner, { action: 'unit_fence' }, true));
  await refusal(tools.invoke('code.local.bind', owner, {}, true));
  await tools.invoke('code.read', worker, { action: 'status' }, true);
  await tools.call('code.read', conversation, { action: 'status' });
  await tools.call('code.read', owner, { action: 'status' });
  assert.deepEqual(
    calls.map(({ tool, action, outcome, errorCode, client, projectId, actorId }) => ({
      tool,
      action,
      outcome,
      errorCode,
      client,
      projectId,
      actorId,
    })),
    [
      {
        tool: 'code.read',
        action: 'status',
        outcome: 'succeeded',
        errorCode: undefined,
        client: 'claude-code/2.1',
        ...owner,
      },
      // A retired name is logged as called, so its use after the release can be counted.
      {
        tool: 'code.status',
        action: 'status',
        outcome: 'succeeded',
        errorCode: undefined,
        client: undefined,
        ...owner,
      },
      {
        tool: 'code.write',
        action: 'unit_fence',
        outcome: 'failed',
        errorCode: 'invalid_input',
        client: undefined,
        ...owner,
      },
      {
        tool: 'code.local.bind',
        action: undefined,
        outcome: 'failed',
        errorCode: 'tool_renamed',
        client: undefined,
        ...owner,
      },
    ],
  );
  assert.ok(calls.every((call) => typeof call.durationMs === 'number' && call.startedAt));
});

test('a retired name keeps its own text for workers; everyone else reads the noun action', async () => {
  const { tools } = registry();
  tools.registerSessionPolicy(sessionPolicy(['code.status', 'code.unit.get']).policy);
  const text = async (caller: Caller, agent: boolean) =>
    JSON.stringify(await tools.describe(caller, agent));
  const leased = await text(worker, true);
  assert.match(leased, /code\.unit\.fence resolves/);
  assert.doesNotMatch(leased, /code\.(read|write) /);
  // Listed as the old tool was: a retired name of a core noun is not loaded up front.
  const status = (await tools.describe(worker, true)).find(({ name }) => name === 'code.status');
  assert.equal(status?._meta, undefined);
  for (const listed of [await text(owner, true), await text(conversation, false)]) {
    assert.match(listed, /code\.write unit_fence resolves/);
    assert.match(listed, /code\.write base_retry/);
    assert.doesNotMatch(listed, /code\.(status|unit\.fence|base\.retry)\b/);
  }
});

test('a call log that cannot write keeps its rows for the next flush and says so', async () => {
  let failing = true;
  const written: unknown[][] = [];
  const state = {
    transaction: async (fn: (tx: { run: (...args: unknown[]) => void }) => Promise<void>) => {
      if (failing) throw new Error('down');
      await fn({ run: (...args: unknown[]) => void written.push(args) });
    },
  };
  const log = new AgentCallLog(state as never);
  const row = { ...owner, tool: 'code.read', outcome: 'succeeded' as const, startedAt: 'x' };
  log.push({ ...row, durationMs: 1 });
  const said: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((line: string) => said.push(line)) as never;
  try {
    await assert.rejects(log.flush(), /down/);
  } finally {
    process.stderr.write = write;
  }
  assert.match(said.join(''), /agent_tool_calls\.flush_failed/);
  failing = false;
  await log.flush();
  assert.equal(written.filter(([sql]) => String(sql).startsWith('INSERT')).length, 1);
});

test('openWorld is per action: a call that stays inside Merv reads on a snapshot', async () => {
  let snapshots = 0;
  const tools = new ToolRegistry(scope as never, undefined, async (fn) => {
    snapshots++;
    return await fn();
  });
  const definition = noun('probe.read', {
    readOnly: true,
    description: 'Read probes: local, remote.',
    actions: {
      local: { description: 'Here.', input: z.object({}).strict(), handler: () => 'here' },
      remote: {
        description: 'Elsewhere.',
        input: z.object({}).strict(),
        openWorld: true,
        handler: () => 'there',
      },
    },
  });
  tools.register(definition);
  // The tool's hint is true where any action's is.
  assert.equal(describeTool(definition).annotations?.openWorldHint, true);
  await tools.call('probe.read', owner, { action: 'local' });
  assert.equal(snapshots, 1);
  await tools.call('probe.read', owner, { action: 'remote' });
  assert.equal(snapshots, 1);
});

test('a script is declared one overload per action, typed by its declared output', () => {
  const definitions: ToolDefinition[] = [];
  codeToolsPlugin.apply({
    codeWork: {},
    tools: {
      noun: (name: string, definition: NounDefinition) => definitions.push(noun(name, definition)),
      register: (definition: ToolDefinition) => definitions.push(definition),
    },
    effect: (fn: () => unknown) => fn(),
  } as unknown as Context);
  const read = definitions.find(({ name }) => name === 'code.read')!;
  const lines = declaration(describeTool(read), true, nounOutputs(read.actions!)).split('\n');
  assert.match(lines[0]!, /^\/\*\* Read the project's code/);
  assert.equal(
    lines[1],
    'tools.code.read(input: { action: "files"; files?: { ref?: string; path?: string } }): Promise<{ ref: string; commit: string; path: string; kind: "folder" | "file"; entries?: ({ name: string; kind: string; size?: number })[]; text?: string; withheld?: "too_large" | "binary" }>',
  );
  assert.equal(lines.length, 6);
  assert.match(
    lines[5]!,
    /^tools\.code\.read\(input: \{ action: "operation"; operation\?: \{ commandId: string \} \}\): Promise<\{ status: string; error: string \| null; command: /,
  );
});
