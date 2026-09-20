import assert from 'node:assert/strict';
import test from 'node:test';
import {
  check,
  type Actor,
  type Caller,
  type SessionToolInvocation,
  type SessionToolPolicy,
} from '@merv/contracts';
import { ExactToolPolicy } from '../packages/scope/src/tool-policy.js';

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
    runs = 0;
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
  const policy = new ExactToolPolicy({ require: async () => ({}) as Actor });
  const dispose = policy.registerSessions(provider);
  return { policy, provider, dispose, live, cancellations: () => cancellations, runs: () => runs };
}

for (const replacement of ['absent', 'same', 'different'] as const) {
  test(`cancel releases the original reservation when its provider is ${replacement}`, async () => {
    const f = fixture(),
      other = fixture();
    const invocation = await f.policy.prepare(caller, 'write', {});
    f.dispose();
    if (replacement !== 'absent')
      f.policy.registerSessions(replacement === 'same' ? f.provider : other.provider);
    await f.policy.cancel(invocation);
    await f.policy.cancel(invocation);
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
        phase === 'allows'
          ? f.policy.allowsTool(caller, 'read', true)
          : phase === 'prepare'
            ? f.policy.prepare(caller, 'write', {})
            : f.policy.validate(caller, 'write', {});
      const rejected = assert.rejects(pending, { code: 'session_unavailable' });
      await held.entered;
      f.dispose();
      if (replace) f.policy.registerSessions(f.provider);
      held.release();
      await rejected;
      assert.equal(f.live.size, 0, 'a failed preparation must release any allocated reservation');
      if (replace) assert.equal(await f.policy.allowsTool(caller, 'read', true), true);
    });
  }
}

test('run refuses a preparation from an earlier registration of the same provider', async () => {
  const f = fixture();
  const invocation = await f.policy.prepare(caller, 'write', {});
  f.dispose();
  f.policy.registerSessions(f.provider);
  let writes = 0;
  try {
    await assert.rejects(
      f.policy.run(invocation, () => {
        writes++;
      }),
      { code: 'session_unavailable' },
    );
    assert.equal(writes, 0);
    assert.equal(f.runs(), 0, 'a retired preparation is refused before provider dispatch');
  } finally {
    await f.policy.cancel(invocation);
  }
  const current = await f.policy.prepare(caller, 'write', {});
  try {
    assert.equal(await f.policy.run(current, () => ++writes), 1);
  } finally {
    await f.policy.cancel(current);
  }
});

test('withdrawal while provider run awaits prevents handler dispatch', async (t) => {
  const held = gate();
  t.after(held.release);
  const f = fixture({ phase: 'run', wait: held.hold });
  const invocation = await f.policy.prepare(caller, 'write', {});
  let writes = 0;
  const pending = f.policy.run(invocation, () => {
    writes++;
  });
  const rejected = assert.rejects(pending, { code: 'session_unavailable' });
  await held.entered;
  f.dispose();
  f.policy.registerSessions(f.provider);
  held.release();
  try {
    await rejected;
    assert.equal(writes, 0);
  } finally {
    await f.policy.cancel(invocation);
  }
});

test('withdrawal after handler admission preserves a completed mutation result', async () => {
  const f = fixture();
  const invocation = await f.policy.prepare(caller, 'write', {});
  try {
    assert.equal(
      await f.policy.run(invocation, () => {
        f.dispose();
        return 'committed';
      }),
      'committed',
    );
  } finally {
    await f.policy.cancel(invocation);
  }
  assert.equal(f.live.size, 0);
});
