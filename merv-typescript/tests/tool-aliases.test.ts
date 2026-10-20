import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from 'cordis';
import type { Actor, Caller, Transaction, WorkflowExecutionPolicy } from '@merv/contracts';
import { ToolRegistry } from '../packages/api/src/registry.js';
import { SessionInvocations, type InvocationHost } from '../packages/sessions/src/invocations.js';
import type { Session } from '../packages/sessions/src/types.js';
import { fleetToolsPlugin } from '../packages/fleet/src/tools.js';

/** A leased worker whose frozen policy grants these tools, its lease always valid. */
function leased(grants: WorkflowExecutionPolicy['tools']) {
  const worker: Caller = { projectId: 'p', actorId: 'w', session: { id: 'ses_1' } };
  const session = {
    id: 'ses_1',
    kind: 'work',
    projectId: 'p',
    actorId: 'w',
    execution: { policy: { tools: grants }, references: {} },
  } as unknown as Session;
  const tx = {} as Transaction;
  const host: InvocationHost = {
    open: () => {},
    closed: () => false,
    reading: async (fn) => await fn(tx),
    readFirst: async (fn) => await fn(tx),
    session: async () => session,
    callSession: async () => session,
    registration: () => 'reg',
    held: async () => {},
    valid: async () => ({ registrationId: 'reg', references: {} }),
    acknowledged: async () => {},
    awaits: async () => false,
  };
  const observations = { start: async () => {}, finish: async () => {} };
  const tools = new ToolRegistry({ require: async () => ({ role: 'member' }) as unknown as Actor });
  tools.registerSessionPolicy(new SessionInvocations(observations as never, Date.now, host));
  return { worker, tools };
}

test('a leased worker keeps the retired Fleet names its grants name, and reads a tool they name', async (t) => {
  const at = new Date(0).toISOString();
  const allocation = {
    id: 'fa_1',
    owner: { kind: 'workflow', id: 'work_1' },
    phase: 'running',
    intent: 'run',
    failures: 0,
    error: null,
    runtime: null,
    createdAt: at,
    updatedAt: at,
    deadlineAt: at,
  };
  const done: string[] = [];
  const fleet = {
    list: async () => [allocation],
    inspect: async () => allocation,
    drain: async () => (done.push('drain'), { ...allocation, intent: 'drain' }),
    cancel: async () => (done.push('halt'), { ...allocation, intent: 'stop' }),
  };
  const view = (intent: string) => ({
    id: 'fa_1',
    title: 'Workflow agent',
    owner: allocation.owner,
    status: { run: 'running', drain: 'finishing', stop: 'stopping' }[intent],
    phase: 'running',
    intent,
    createdAt: at,
    updatedAt: at,
    deadlineAt: at,
    attention: null,
    runtime: null,
  });
  const load = async (grants: WorkflowExecutionPolicy['tools']) => {
    const { worker, tools } = leased(grants);
    const ctx = new Context();
    ctx.provide('fleet', fleet);
    ctx.provide('tools', tools);
    await ctx.plugin(fleetToolsPlugin);
    t.after(() => ctx.fiber.dispose());
    return {
      call: (name: string, input: object) => tools.call(name, worker, input),
      tools,
      worker,
    };
  };

  // Grants written before the 2026-10-20 consolidation name the old tools, which still run.
  const old = await load(['fleet.list', 'fleet.get', 'fleet.drain'].map(grant));
  assert.deepEqual(await old.call('fleet.list', {}), [view('run')]);
  assert.deepEqual(await old.call('fleet.get', { id: 'fa_1' }), view('run'));
  assert.deepEqual(await old.call('fleet.drain', { id: 'fa_1' }), view('drain'));
  // Unlisted, and the tool they became is no grant of theirs, its reads included.
  assert.deepEqual(
    (await old.tools.describe(old.worker)).map(({ name }) => name),
    [],
  );
  await assert.rejects(old.call('fleet', { action: 'list' }), { code: 'execution_tool_forbidden' });
  await assert.rejects(old.call('fleet.halt', { id: 'fa_1' }), {
    code: 'execution_tool_forbidden',
  });

  // A grant of the new tool bound to one write: its reads are reads, its other writes refused.
  const bound = await load([
    { name: 'fleet', alternatives: [{ action: { kind: 'literal', value: 'drain' } }] },
  ]);
  assert.deepEqual(await bound.call('fleet', { action: 'list' }), [view('run')]);
  assert.deepEqual(await bound.call('fleet', { action: 'get', id: 'fa_1' }), view('run'));
  assert.deepEqual(await bound.call('fleet', { action: 'drain', id: 'fa_1' }), view('drain'));
  await assert.rejects(bound.call('fleet', { action: 'halt', id: 'fa_1' }), {
    code: 'execution_arguments_forbidden',
  });
  assert.deepEqual(done, ['drain', 'drain']);
});

const grant = (name: string) => ({ name, alternatives: [{}] });
