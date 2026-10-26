import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { MervError, type Caller, type Scope, type SessionToolPolicy } from '@merv/contracts';
import { ToolRegistry } from '../packages/api/src/registry.js';
import { isAgentAudience } from '../packages/api/src/audience.js';
import { agentOperations } from '../packages/api/src/agent-status.js';

const caller: Caller = { projectId: 'project', actorId: 'owner' };
const scope = { require: async () => ({ role: 'operator' }) } as unknown as Scope;

test('agent discovery and all invocation spellings exclude administrative accounting', async () => {
  const tools = new ToolRegistry(scope);
  tools.registerCallerRules('conversation', {
    offers: () => true,
    forbidden: new MervError('tool_forbidden', 'forbidden', 403),
  });
  tools.noun('project.read', {
    tier: 'core',
    readOnly: true,
    description: 'Read project.',
    actions: {
      status: {
        input: z.object({}),
        description: 'Operational status.',
        was: ['system.status'],
        handler: (c) => ({ agent: isAgentAudience(c) }),
      },
      usage: {
        uiOnly: true,
        input: z.object({}),
        description: 'Secret token ceiling.',
        was: ['usage.read'],
        handler: () => ({ maxTokens: 123 }),
      },
    },
  });
  for (const compact of [false, true]) {
    const shown = JSON.stringify(await tools.describe(caller, true, { compact }));
    assert.doesNotMatch(shown, /usage|Secret token/);
  }
  assert.match(JSON.stringify(await tools.describe(caller, false)), /Secret token/);
  for (const [name, input] of [
    ['project.read', { action: 'usage' }],
    ['usage.read', {}],
    ['project.read:usage', {}],
  ] as const)
    await assert.rejects(tools.invoke(name, caller, input, true), { code: 'tool_forbidden' });
  assert.deepEqual(await tools.call('project.read', caller, { action: 'usage' }), {
    maxTokens: 123,
  });
  assert.deepEqual((await tools.invoke('project.read', caller, { action: 'status' }, true)).value, {
    agent: true,
  });
  assert.deepEqual(await tools.call('project.read', caller, { action: 'status' }), {
    agent: false,
  });
  // Pi has server-owned conversation identity even when called through the internal helper.
  await assert.rejects(
    tools.call(
      'project.read',
      { ...caller, conversation: { id: 'pi' } as never },
      { action: 'usage' },
    ),
    { code: 'tool_forbidden' },
  );
  tools.registerSessionPolicy({
    allowsTool: async () => true,
    prepare: async (c, name, input) => ({ caller: c, tool: name, input }),
    validate: async () => {},
    cancel: async () => {},
    run: async (invocation, handler) => handler(invocation.caller, invocation.input),
  } as SessionToolPolicy);
  const worker = { ...caller, session: { id: 'lease' } };
  const workerTools = await tools.describe(worker, true);
  assert.doesNotMatch(JSON.stringify(workerTools), /usage|Secret token/);
  assert.equal(
    workerTools.find((t) => t.name === 'system.status')?.inputSchema.properties?.action,
    undefined,
  );
  assert.deepEqual(await tools.call('system.status', worker, {}), { agent: true });
  await assert.rejects(tools.call('usage.read', worker, {}), { code: 'tool_forbidden' });
  await tools.close();
});

test('operational view preserves blockers but removes internal accounting without mutating it', () => {
  const raw = {
    budgets: [{ maxTokens: 30 }],
    fleet: { modelBudget: { blocked: true, resetsAt: 'tomorrow' }, available: true },
    blockers: {
      items: [
        {
          code: 'budget_exceeded',
          budgets: [1],
          why: 'tokens used',
          next: 'raise token cap',
          instanceId: 'work',
        },
        { code: 'agent_question', why: 'missing data', next: 'answer' },
      ],
    },
  };
  const shown = agentOperations(raw);
  assert.doesNotMatch(JSON.stringify(shown), /budget|token|tomorrow/i);
  assert.equal(shown.blockers.items[0]!.instanceId, 'work');
  assert.equal(shown.blockers.items[0]!.code, 'service_unavailable');
  assert.equal(shown.blockers.items[1]!.code, 'agent_question');
  assert.equal(raw.budgets[0]!.maxTokens, 30);
});
