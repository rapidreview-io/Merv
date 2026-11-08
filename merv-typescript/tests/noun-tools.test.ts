/**
 * The noun-tool mechanism: one read and one write tool per noun, each taking `action` and the
 * argument object named after it; tiers that MCP and Pi both read; retired names kept as hidden
 * executable aliases; the outside-agent call log; per-action openWorld and declared outputs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';
import { type Caller } from '@merv/contracts';
import { noun } from '../packages/api/src/noun.js';

import { describeTool, ToolRegistry } from '../packages/api/src/registry.js';
import type { AgentToolCall, NounDefinition, ToolDefinition } from '../packages/api/src/types.js';
import { codeToolsPlugin } from '../packages/code-work/src/tools.js';

import { conversationRules } from '../packages/pi/src/conversation-rules.js';

import { code, fixture } from './fixtures/pi.js';

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
/** Scope as callers' roles would answer it: the reader reads, everyone else operates. */
const scope = {
  require: async (caller: Caller) => ({
    role: caller.actorId === 'reader' ? 'reader' : 'operator',
  }),
};

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
const call = (overrides: Partial<AgentToolCall> = {}): AgentToolCall => ({
  ...owner,
  tool: 'code.read',
  outcome: 'succeeded',
  startedAt: new Date().toISOString(),
  durationMs: 1,
  ...overrides,
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
