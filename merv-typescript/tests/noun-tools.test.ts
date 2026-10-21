/**
 * The noun-tool mechanism: one read and one write tool per noun, each taking `action` and the
 * argument object named after it; tiers that MCP and Pi both read; retired names kept as hidden
 * executable aliases; the outside-agent call log; per-action openWorld and declared outputs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from 'cordis';
import { z } from 'zod';
import { MervError, type Caller, type Data, type SessionToolPolicy } from '@merv/contracts';
import { noun, nounActions } from '../packages/api/src/noun.js';
import { AgentCallLog, callLogMigrations } from '../packages/api/src/call-log.js';
import { toolsPlugin } from '../packages/api/src/index.js';
import { describeTool, ToolRegistry } from '../packages/api/src/registry.js';
import type { AgentToolCall, NounDefinition, ToolDefinition } from '../packages/api/src/types.js';
import { codeToolsPlugin } from '../packages/code-work/src/tools.js';
import { taskToolsPlugin } from '../packages/tasks/src/tools.js';
import { scopeToolsPlugin } from '../packages/scope/src/tools.js';
import { sessionsToolsPlugin } from '../packages/sessions/src/tools.js';
import { knowledgeToolsPlugin } from '../packages/knowledge/src/tools.js';
import { conversationRules } from '../packages/pi/src/conversation-rules.js';
import { PiProfiles } from '../packages/pi/src/profiles.js';
import { profileGrants, requireGranted } from '../packages/pi/src/profile-tools.js';
import { declaration } from '../packages/scripts/src/declare.js';
import { code, fixture } from './fixtures/pi.js';
import { fixtureAccess } from './fixtures/access.js';
import { deferred } from './fixtures/deferred.js';
import { openState } from './fixtures/state.js';
import { expanded } from './fixtures/tool-schema.js';

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
  // Retired external actions are not advertised or accepted.
  for (const action of ['publication_control', 'publication_merge', 'mirror_retry'])
    await refusal(tools.call('code.write', owner, { action, [action]: {} }));
  await assert.rejects(
    tools.call('code.write', owner, {
      action: 'repository_import',
      repository_import: { source: 'github', requestId: 'import' },
    }),
    { code: 'invalid_input' },
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

test('a noun tool describes every action through lossless schemas, core loaded up front', async () => {
  const { tools } = registry();
  const described = new Map((await tools.describe(owner, true)).map((tool) => [tool.name, tool]));
  assert.deepEqual([...described.keys()], ['code.git_credential', 'code.read', 'code.write']);
  const gitCredential = described.get('code.git_credential')!;
  assert.equal(gitCredential.annotations?.readOnlyHint, false);
  described.delete('code.git_credential');
  for (const tool of described.values()) {
    const schema = expanded(tool.inputSchema);
    assert.equal(schema.type, 'object');
    assert.equal(schema.anyOf, undefined, `${tool.name} has no top-level anyOf`);
    assert.deepEqual(schema.required, ['action']);
    for (const action of schema.properties.action.enum as string[]) {
      const object = schema.properties[action];
      assert.equal(object.type, 'object', `${tool.name} ${action}`);
      assert.ok(object.description.length > 0);
      assert.doesNotMatch(object.description, /Required when action/);
    }
    assert.ok(tool.description!.length <= 600, `${tool.name}'s summary is at most 600 characters`);
    assert.match(tool.description!, /\{"action":"x","x":\{…\}\}/);
    // A noun's requestId is inside its actions, so it claims no idempotence.
    assert.equal(tool.annotations?.idempotentHint, undefined);
  }
  const write = expanded(described.get('code.write')!.inputSchema);
  // Its own required list, nested enums and the refined input's fields.
  assert.deepEqual(write.properties.base_retry.required, ['key', 'reason', 'requestId']);
  assert.equal(write.properties.repository_import, undefined);
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
    ['code.read', 3_500, 8],
    ['code.write', 10_500, 13],
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

/** Runs `fn` with stderr kept, returning what it said. */
async function quiet(fn: () => Promise<unknown>): Promise<string> {
  const said: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((line: string) => said.push(line)) as never;
  try {
    await fn();
  } finally {
    process.stderr.write = write;
  }
  return said.join('');
}
const call = (overrides: Partial<AgentToolCall> = {}): AgentToolCall => ({
  ...owner,
  tool: 'code.read',
  outcome: 'succeeded',
  startedAt: new Date().toISOString(),
  durationMs: 1,
  ...overrides,
});

test('a call log writes the names an agent sent as PostgreSQL can hold them', async () => {
  const state = await openState();
  await state.migrate('agent_tool_calls', callLogMigrations);
  const log = new AgentCallLog(state);
  log.push(call({ tool: 'code.re\0ad', client: `a\0${'b'.repeat(500)}` }));
  log.push(call());
  await log.flush();
  const rows = await state.read((sql) =>
    sql.all<{ tool: string; client: string | null }>(
      'SELECT tool, client FROM agent_tool_calls ORDER BY client NULLS LAST',
    ),
  );
  assert.deepEqual(
    rows.map(({ tool, client }) => [tool, client?.length ?? null]),
    [
      ['code.read', 200],
      ['code.read', null],
    ],
  );
});

test('a row PostgreSQL refuses for good is dropped and counted; the rest of its batch is written', async () => {
  const written: unknown[][] = [];
  let transactions = 0;
  const state = {
    transaction: async (fn: (tx: { run: (...args: unknown[]) => void }) => Promise<void>) => {
      transactions++;
      const rows: unknown[][] = [];
      await fn({
        run: (...args: unknown[]) => {
          if (args.includes('poison'))
            throw new MervError('state_constraint', 'Database constraint rejected the operation');
          rows.push(args);
        },
      });
      written.push(...rows);
    },
  };
  const log = new AgentCallLog(state as never);
  log.push(call({ actorId: 'a' }));
  log.push(call({ actorId: 'poison' }));
  log.push(call({ actorId: 'b' }));
  assert.match(await quiet(() => log.flush()), /flush_failed/);
  const actors = () =>
    written.filter(([sql]) => String(sql).startsWith('INSERT')).map((args) => args[2]);
  assert.deepEqual(actors(), ['a', 'b']);
  // The next flush writes nothing again and says what was dropped.
  const before = transactions;
  assert.match(await quiet(() => log.flush()), /"event":"agent_tool_calls\.dropped","rows":1/);
  assert.deepEqual(actors(), ['a', 'b']);
  assert.ok(transactions - before <= 1);
});

test('a call log flushes one at a time, and what is being written counts against its bound', async () => {
  const gate = deferred<void>();
  let transactions = 0;
  let inserted = 0;
  const state = {
    transaction: async (fn: (tx: { run: (sql: string) => void }) => Promise<void>) => {
      transactions++;
      if (transactions === 1) await gate.promise;
      await fn({ run: (sql: string) => void (sql.startsWith('INSERT') && inserted++) });
    },
  };
  const log = new AgentCallLog(state as never);
  for (let i = 0; i < 6000; i++) log.push(call());
  const flushes = [log.flush(), log.flush(), log.flush()];
  for (let i = 0; i < 6000; i++) log.push(call());
  gate.resolve();
  await Promise.all(flushes);
  assert.equal(transactions, 1, 'a flush asked for while one runs is that one');
  await quiet(() => log.flush());
  assert.equal(inserted, 10_000);
});

test('a mounted tool that answers isError is logged as failed', async () => {
  const calls: AgentToolCall[] = [];
  const tools = new ToolRegistry(scope as never, fixtureAccess, undefined, (row) =>
    calls.push(row),
  );
  await tools.createCatalog('mount').replace([
    {
      kind: 'mcp',
      name: 'echo',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => ({ content: [{ type: 'text', text: 'no' }], isError: true }),
    },
  ]);
  const [mounted] = await tools.describe(owner, true);
  await tools.invoke(mounted!.name, owner, {}, true);
  assert.deepEqual(
    calls.map(({ outcome, errorCode }) => [outcome, errorCode]),
    [['failed', 'tool_error']],
  );
});

test('the call log depends on state: its last rows are written before state closes', async () => {
  const ctx = new Context();
  const events: string[] = [];
  const state = {
    migrate: async () => {},
    transaction: async (fn: (tx: { run: (sql: string) => void }) => Promise<void>) =>
      await fn({ run: (sql) => void (sql.startsWith('INSERT') && events.push('insert')) }),
    snapshot: async <T>(fn: () => Promise<T>) => await fn(),
  };
  await ctx.plugin({
    name: 'test-scope',
    apply: (ctx: Context) => ctx.effect(() => ctx.provide('scope', scope as never)),
  });
  const provider = await ctx.plugin({
    name: 'test-state',
    apply: (ctx: Context) =>
      ctx.effect(function* () {
        yield () => void events.push('closed');
        yield ctx.provide('state', state as never);
      }),
  });
  await ctx.plugin(toolsPlugin);
  const tools = ctx.get('tools') as unknown as ToolRegistry;
  while (!tools.log) await new Promise((resolve) => setImmediate(resolve));
  tools.register({
    name: 'probe.ping',
    description: 'Ping.',
    tier: 'core',
    readOnly: true,
    inputSchema: z.object({}).strict(),
    handler: () => 'pong',
  });
  await tools.invoke('probe.ping', owner, {}, true);
  await provider.dispose();
  assert.deepEqual(events, ['insert', 'closed']);
  await ctx.fiber.dispose();
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
  const lines = declaration(describeTool(read), true, nounActions(read.actions!)).split('\n');
  assert.match(lines[0]!, /^\/\*\* Read the project's code/);
  assert.equal(
    lines[1],
    'tools.code.read(input: { action: "files"; files?: { ref?: string; path?: string } }): Promise<{ ref: string; commit: string; path: string; kind: "folder" | "file"; entries?: ({ name: string; kind: string; size?: number })[]; text?: string; withheld?: "too_large" | "binary" }>',
  );
  assert.equal(lines.length, 6);
  assert.match(
    lines[5]!,
    /^tools\.code\.read\(input: \{ action: "operation"; operation: \{ commandId: string \} \}\): Promise<\{ status: string; error: string \| null; command: /,
  );
  // Only a noun is declared per action: any other tool's action is one more of its arguments.
  const fleet = {
    name: 'fleet',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['list', 'get'] }, id: { type: 'string' } },
      required: ['id'],
    },
  };
  assert.equal(
    declaration(fleet),
    'tools.fleet(input: { action?: "list" | "get"; id: string }): Promise<unknown>',
  );
});

test('a profile naming a retired name is listed that name, its texts read as the noun action', async () => {
  const { tools } = registry();
  const listed = await tools.describe(conversation, false, { names: ['code.status'] });
  const status = listed.find(({ name }) => name === 'code.status');
  assert.ok(status, 'the retired name keeps its own name');
  assert.match(status.description!, /code\.write base_retry/);
  assert.ok(!listed.some(({ name }) => / /.test(name)), 'no name is rewritten');
});

test('recovery guidance names each action by its address and says it as its caller calls it', async () => {
  const tools = new ToolRegistry(scope as never);
  const said = {
    next: 'An administrator uses code.write:base_resume and a reason.',
    publication: { next: 'Reconcile it with code.write:publication_sync; read code.read:status.' },
  };
  // Code's reads say their guidance through the registry it is bound to (CodeService.said).
  const codeWork = new Proxy(
    {},
    { get: () => async (caller: Caller) => tools.guidance(caller, said) },
  );
  codeToolsPlugin.apply({ codeWork, tools, effect: (fn: () => unknown) => fn() } as never);
  tools.registerSessionPolicy(sessionPolicy(['code.status']).policy);
  assert.deepEqual(await tools.call('code.read', owner, { action: 'status' }), {
    next: 'An administrator uses code.write base_resume and a reason.',
    publication: { next: 'Reconcile it with code.write publication_sync; read code.read status.' },
  });
  // A leased worker is told the retired name its frozen policy grants.
  assert.deepEqual(await tools.call('code.status', worker, {}), {
    next: 'An administrator uses code.base.resume and a reason.',
    publication: { next: 'Reconcile it with code.publication.sync; read code.status.' },
  });
  // Concurrent reads of the same service retain their own endpoint vocabulary.
  const [legacy, modern] = (await Promise.all([
    tools.call('code.status', owner, {}),
    tools.call('code.read', owner, { action: 'status' }),
  ])) as { next: string }[];
  assert.equal(legacy!.next, 'An administrator uses code.base.resume and a reason.');
  assert.equal(modern!.next, 'An administrator uses code.write base_resume and a reason.');
  // A task's guidance carries the blockers Code published on it, said the same way.
  const tasks = { get: async () => ({ guidance: { blockers: [said] } }) };
  taskToolsPlugin.apply({ tools, tasks, effect: (fn: () => unknown) => fn() } as never);
  assert.deepEqual(await tools.call('task.get', owner, { taskId: 't', full: true }), {
    guidance: {
      blockers: [
        {
          next: 'An administrator uses code.base.resume and a reason.',
          publication: {
            next: 'Reconcile it with code.publication.sync; read code.status.',
          },
        },
      ],
    },
  });
});

test('the assembled project.read contributors register within the shared description limit', async () => {
  const tools = new ToolRegistry(scope as never);
  const ctx = { scope, sessions: {}, knowledge: {}, tools, effect: (fn: () => unknown) => fn() };
  for (const plugin of [scopeToolsPlugin, sessionsToolsPlugin, knowledgeToolsPlugin])
    assert.doesNotThrow(
      () => plugin.apply(ctx as never),
      `${plugin.name} must register alongside every project.read contributor`,
    );
  const catalog = await tools.describe(owner, true);
  const registered = catalog.find(({ name }) => name === 'project.read')!;
  assert.ok(
    registered.description!.length <= 600,
    'combined description includes routing guidance',
  );
  const schema = expanded(registered.inputSchema);
  assert.deepEqual([...schema.properties.action.enum].sort(), [
    'actors',
    'brief',
    'get',
    'list',
    'records',
    'references',
    'status',
    'usage',
    'whoami',
  ]);
  assert.match(schema.properties.status.description, /cumulative project\/dependency limits/);
  assert.match(schema.properties.status.description, /withheld steps.*covering budgets/);
  // A later oversized contribution fails without withdrawing the working shared tool.
  assert.throws(
    () =>
      tools.noun('project.read', {
        tier: 'core',
        readOnly: true,
        description: 'x'.repeat(600),
        actions: { extra: { description: 'Extra.', input: z.object({}), handler: () => ({}) } },
      }),
    { code: 'invalid_tool', message: /project\.read.*600/ },
  );
  assert.deepEqual(await tools.describe(owner, true), catalog);
  await tools.close();
});

test('plugins contribute actions to one noun, which loses an action when its plugin unloads', async () => {
  const tools = new ToolRegistry(scope as never);
  const part = (actions: string[], readOnly = true): NounDefinition => ({
    tier: 'core',
    readOnly,
    description: `Reads ${actions.join(' and ')}.`,
    actions: Object.fromEntries(
      actions.map((action) => [
        action,
        { description: action, input: z.object({}).strict(), handler: () => ({ action }) },
      ]),
    ),
  });
  const actions = async () =>
    (await tools.describe(owner, true)).find(({ name }) => name === 'project.read')?.inputSchema
      .properties?.action as { enum: string[] } | undefined;
  tools.noun('project.read', part(['get', 'brief']));
  const sessions = tools.noun('project.read', part(['status', 'usage']));
  assert.deepEqual((await actions())?.enum, ['get', 'brief', 'status', 'usage']);
  const listed = (await tools.describe(owner, true)).find(({ name }) => name === 'project.read')!;
  assert.match(listed.description!, /^Reads get and brief\. Reads status and usage\./);
  assert.deepEqual(await tools.call('project.read:status', owner, {}), { action: 'status' });
  // Contributors agree on readOnly and bring each action once; one that does not changes nothing.
  assert.throws(() => tools.noun('project.read', part(['write'], false)), { code: 'invalid_tool' });
  assert.throws(() => tools.noun('project.read', part(['get'])), { code: 'invalid_tool' });
  assert.deepEqual((await actions())?.enum, ['get', 'brief', 'status', 'usage']);
  // Unloading one plugin takes its actions away; a call to one is refused, never a crash.
  await sessions();
  assert.deepEqual((await actions())?.enum, ['get', 'brief']);
  await assert.rejects(tools.call('project.read', owner, { action: 'status' }), {
    code: 'invalid_input',
  });
  assert.deepEqual(await tools.call('project.read', owner, { action: 'get' }), { action: 'get' });
});

test('task reminders and paginated lists retain executable recovery references', async () => {
  const { tools } = registry();
  const records = ['a', 'b'].map((id) => ({
    id,
    title: id,
    goal: 'Original goal',
    acceptanceChecks: [{ number: 1, text: 'Original check' }],
    workflow: { state: 'in_progress', revision: 2, data: { old: 'history' } },
    workStarts: [{ revision: 1 }],
    dependencies: [],
    dependents: [],
    contextInputs: {},
    checks: ['Original check'],
    deliveryConfirmations: [],
    guidance: { references: [] },
  }));
  const tasks = { get: async () => records[0], list: async () => records };
  taskToolsPlugin.apply({ tools, tasks, effect: (fn: () => unknown) => fn() } as never);
  const call = (tool: string, input: object) => tools.call(tool, owner, input) as Promise<any>;
  const reminder = await call('task.read', { action: 'get', get: { taskId: 'a' } });
  assert.equal(reminder.goal, 'Original goal');
  assert.deepEqual(reminder.acceptanceChecks, records[0]!.acceptanceChecks);
  assert.equal(reminder.workStarts, undefined);
  const full = reminder.references[0];
  assert.deepEqual(await call(full.tool, full.arguments), records[0]);
  const first = await call('task.read', { action: 'list', list: { limit: 1 } });
  const second = await call(first.next.tool, first.next.arguments);
  assert.deepEqual([first.items[0].id, second.items[0].id], ['a', 'b']);
  assert.equal(second.next, null);
});
