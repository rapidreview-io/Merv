import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from 'cordis';
import type { Actor, Caller, Transaction, WorkflowExecutionPolicy } from '@merv/contracts';
import { ToolRegistry } from '../packages/api/src/registry.js';
import { SessionInvocations, type InvocationHost } from '../packages/sessions/src/invocations.js';
import type { Session } from '../packages/sessions/src/types.js';
import { fleetToolsPlugin } from '../packages/fleet/src/tools.js';
import { retired } from '../packages/sandboxes/src/host.js';
import { z } from 'zod';

/** A leased worker whose frozen policy grants these tools, its lease always valid; an inquiry
 *  visit's policy names none. */
function leased(grants: WorkflowExecutionPolicy['tools'], kind = 'work') {
  const worker: Caller = { projectId: 'p', actorId: 'w', session: { id: 'ses_1' } };
  const session = {
    id: 'ses_1',
    kind,
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

/** sandboxes.sandbox as Sandboxes registers it, with the calls its handler ran. */
function sandboxes(tools: ToolRegistry) {
  const ran: object[] = [];
  tools.register({
    name: 'sandboxes.sandbox',
    description: 'Machines',
    inputSchema: z
      .object({
        action: z.enum(['list', 'get', 'renew', 'delete']).default('list'),
        sandbox_id: z.string().optional(),
        extend_seconds: z.number().int().optional(),
      })
      .strict(),
    reads: ({ action }) => ['list', 'get'].includes(action),
    handler: (_caller, input) => (ran.push(input), input),
  });
  tools.alias(retired);
  return ran;
}

test('a retired name takes only its old arguments, so a grant bound to them binds the call', async () => {
  const sbxA = { kind: 'literal', value: 'sbx_A' } as const;
  const { worker, tools } = leased([
    { name: 'sandbox.release', alternatives: [{ id: sbxA }] },
    { name: 'sandbox.extend', alternatives: [{ id: sbxA }] },
  ]);
  const ran = sandboxes(tools);
  const person: Caller = { projectId: 'p', actorId: 'alice', credentialId: 'key-alice' };
  // A target name beside the old one would otherwise win the rename, past the grant on id.
  const bypasses = [
    ['sandbox.release', { id: 'sbx_A', sandbox_id: 'sbx_B' }],
    ['sandbox.release', { id: 'sbx_A', action: 'renew' }],
    ['sandbox.extend', { id: 'sbx_A', seconds: 60, sandbox_id: 'sbx_B' }],
    ['sandbox.extend', { id: 'sbx_A', seconds: 60, extend_seconds: 86_400 }],
  ] as const;
  for (const [name, input] of bypasses) {
    await assert.rejects(tools.call(name, worker, input), { code: 'invalid_input' });
    await assert.rejects(tools.invoke(name, person, input, true), { code: 'invalid_input' });
  }
  assert.deepEqual(ran, []);
  // Its old arguments, by their new names, and within its grant.
  assert.deepEqual(await tools.call('sandbox.extend', worker, { id: 'sbx_A', seconds: 60 }), {
    action: 'renew',
    sandbox_id: 'sbx_A',
    extend_seconds: 60,
  });
  await assert.rejects(tools.call('sandbox.release', worker, { id: 'sbx_B' }), {
    code: 'execution_arguments_forbidden',
  });
  assert.deepEqual(await tools.call('sandbox.release', worker, { id: 'sbx_A' }), {
    action: 'delete',
    sandbox_id: 'sbx_A',
  });
  assert.equal(ran.length, 2);
});

test('a worker and an inquiry visit with no grants read tools that also write, and write nothing', async (t) => {
  const fleet = { list: async () => [], drain: async () => assert.fail('drained') };
  for (const kind of ['work', 'inquiry']) {
    const { worker, tools } = leased([], kind);
    const ctx = new Context();
    ctx.provide('fleet', fleet);
    ctx.provide('tools', tools);
    await ctx.plugin(fleetToolsPlugin);
    t.after(() => ctx.fiber.dispose());
    const ran = sandboxes(tools);
    assert.deepEqual(
      (await tools.describe(worker)).map(({ name }) => name),
      ['fleet', 'sandboxes.sandbox'],
    );
    assert.deepEqual(await tools.call('fleet', worker, { action: 'list' }), []);
    assert.deepEqual(await tools.call('fleet.list', worker, {}), []);
    assert.deepEqual(await tools.call('sandboxes.sandbox', worker, { action: 'list' }), {
      action: 'list',
    });
    const refused = kind === 'work' ? 'execution_tool_forbidden' : 'inquiry_read_only';
    for (const [name, input] of [
      ['fleet', { action: 'drain', id: 'fa_1' }],
      ['fleet.drain', { id: 'fa_1' }],
      ['sandboxes.sandbox', { action: 'delete', sandbox_id: 'sbx_1' }],
      ['sandbox.release', { id: 'sbx_1' }],
    ] as const)
      await assert.rejects(tools.call(name, worker, input), { code: refused });
    assert.deepEqual(ran, [{ action: 'list' }]);
  }
});
