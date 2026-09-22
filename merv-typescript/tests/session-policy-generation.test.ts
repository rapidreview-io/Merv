import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import {
  check,
  type Actor,
  type Caller,
  type SessionToolInvocation,
  type SessionToolPolicy,
} from '@merv/contracts';
import { ToolRegistry } from '../packages/api/src/registry.js';

const caller: Caller = { projectId: 'project', actorId: 'worker', session: { id: 'session' } };
function gate() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    hold: async () => {
      enter();
      await waiting;
    },
  };
}
function fixture(hold?: { phase: string; wait: () => Promise<void> }) {
  const live = new Set<SessionToolInvocation>();
  let cancellations = 0,
    runs = 0,
    writes = 0;
  const wait = async (phase: string) => {
    if (hold?.phase === phase) await hold.wait();
  };
  const provider: SessionToolPolicy = {
    allowsTool: async () => {
      await wait('allows');
      return true;
    },
    prepare: async (caller, tool, input) => {
      const invocation = { caller: { ...caller }, tool, input };
      live.add(invocation);
      await wait('prepare');
      return invocation;
    },
    validate: async () => {
      await wait('validate');
    },
    cancel: async (invocation) => {
      cancellations++;
      live.delete(invocation);
    },
    run: async (invocation, handler) => {
      check(live.has(invocation), 'session_invocation', 'Unknown invocation', 403);
      runs++;
      await wait('run');
      return handler(invocation.caller, invocation.input);
    },
  };
  // Scope freshness has separate real-database coverage. This fixture isolates the
  // registration boundary and models a provider owning opaque invocation reservations.
  const tools = new ToolRegistry({ require: async () => ({}) as Actor });
  tools.register({
    name: 'write',
    description: 'A mutation',
    inputSchema: z.object({}).strict(),
    handler: () => {
      writes++;
      return 'committed';
    },
  });
  const dispose = tools.registerSessionPolicy(provider);
  return {
    tools,
    provider,
    dispose,
    live,
    cancellations: () => cancellations,
    runs: () => runs,
    writes: () => writes,
  };
}

for (const replacement of ['absent', 'same', 'different'] as const) {
  test(`cancel releases the original reservation when its provider is ${replacement}`, async (t) => {
    const held = gate();
    t.after(held.release);
    const f = fixture({ phase: 'validate', wait: held.hold }),
      other = fixture();
    const rejected = assert.rejects(f.tools.call('write', caller, {}), {
      code: 'session_unavailable',
    });
    await held.entered;
    f.dispose();
    if (replacement !== 'absent')
      f.tools.registerSessionPolicy(replacement === 'same' ? f.provider : other.provider);
    held.release();
    await rejected;
    assert.equal(f.live.size, 0, 'the original provider must release its reservation');
    assert.equal(f.cancellations(), 1, 'cleanup is owned once by the preparing registration');
    assert.equal(other.cancellations(), 0, 'replacement must not receive a foreign invocation');
  });
}

for (const phase of ['allows', 'prepare', 'validate'] as const) {
  for (const replace of [false, true]) {
    test(`${phase} rejects provider ${replace ? 're-registration' : 'withdrawal'} while pending`, async (t) => {
      const held = gate();
      t.after(held.release);
      const f = fixture({ phase, wait: held.hold });
      const pending =
        phase === 'allows' ? f.tools.describe(caller) : f.tools.call('write', caller, {});
      const rejected = assert.rejects(pending, { code: 'session_unavailable' });
      await held.entered;
      f.dispose();
      if (replace) f.tools.registerSessionPolicy(f.provider);
      held.release();
      await rejected;
      assert.equal(f.live.size, 0, 'a failed preparation must release any allocated reservation');
      assert.equal(f.runs(), 0, 'a retired decision is refused before provider dispatch');
      assert.equal(f.writes(), 0);
      if (replace) {
        assert.deepEqual(
          (await f.tools.describe(caller)).map((tool) => tool.name),
          ['write'],
        );
        assert.equal(await f.tools.call('write', caller, {}), 'committed');
      }
    });
  }
}

test('withdrawal while provider run awaits prevents handler dispatch', async (t) => {
  const held = gate();
  t.after(held.release);
  const f = fixture({ phase: 'run', wait: held.hold });
  const rejected = assert.rejects(f.tools.call('write', caller, {}), {
    code: 'session_unavailable',
  });
  await held.entered;
  f.dispose();
  f.tools.registerSessionPolicy(f.provider);
  held.release();
  await rejected;
  assert.equal(f.writes(), 0);
  assert.equal(f.live.size, 0);
});

test('withdrawal after handler admission preserves a completed mutation result', async () => {
  const f = fixture();
  f.tools.register({
    name: 'commit',
    description: 'A mutation that outlives its provider',
    inputSchema: z.object({}).strict(),
    handler: () => {
      f.dispose();
      return 'committed';
    },
  });
  assert.equal(await f.tools.call('commit', caller, {}), 'committed');
  assert.equal(f.live.size, 0);
});

test('mounted tools re-validate a session through the current registration only', async (t) => {
  const held = gate();
  t.after(held.release);
  const f = fixture({ phase: 'validate', wait: held.hold });
  const rejected = assert.rejects(f.tools.validateSession(caller, '_mount.tool', {}), {
    code: 'session_unavailable',
  });
  await held.entered;
  f.dispose();
  const current = f.tools.registerSessionPolicy(f.provider);
  held.release();
  await rejected;
  current();
  await assert.rejects(f.tools.validateSession(caller, '_mount.tool', {}), {
    code: 'session_unavailable',
  });
});
