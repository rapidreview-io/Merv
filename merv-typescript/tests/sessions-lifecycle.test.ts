import assert from 'node:assert/strict';
import test from 'node:test';
import { createService } from '@merv/contracts';
import { SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import { AgentObservations } from '../packages/sessions/src/observations.js';

function barrier() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    wait: async () => {
      enter();
      await held;
    },
  };
}
for (const fails of [false, true])
  test(
    `concurrent session close joins the complete ordered drain${fails ? ' even after a disposer fails' : ''}`,
    { timeout: 5000 },
    async (t) => {
      const state = new SqliteState(':memory:');
      const scope = await createService(new ProjectScope(state));
      const workflows = await createService(new WorkflowsService(state, scope));
      const events = await createService(new DurableEvents(state));
      const unsubscribe = barrier(),
        interrupt = barrier();
      const cleanup: string[] = [];
      const failure = new Error('Synthetic unsubscribe failure');
      const subscribe = events.subscribe.bind(events);
      t.mock.method(events, 'subscribe', async (...args: Parameters<typeof subscribe>) => {
        const dispose = await subscribe(...args);
        return async () => {
          cleanup.push('events');
          await unsubscribe.wait();
          await dispose();
          if (fails) throw failure;
        };
      });
      const registerPolicy = scope.toolPolicy.registerSessions.bind(scope.toolPolicy);
      t.mock.method(
        scope.toolPolicy,
        'registerSessions',
        (...args: Parameters<typeof registerPolicy>) => {
          const dispose = registerPolicy(...args);
          return () => {
            cleanup.push('policy');
            dispose();
          };
        },
      );
      const registerAuthority = scope.registerSessionAuthority.bind(scope);
      t.mock.method(
        scope,
        'registerSessionAuthority',
        (...args: Parameters<typeof registerAuthority>) => {
          const dispose = registerAuthority(...args);
          return () => {
            cleanup.push('authority');
            dispose();
          };
        },
      );
      const sessions = await createService(new LeasedSessions(state, scope, workflows, events));
      const finish = AgentObservations.prototype.interrupt;
      t.mock.method(
        AgentObservations.prototype,
        'interrupt',
        async function (this: AgentObservations) {
          cleanup.push('observations');
          await interrupt.wait();
          await finish.call(this);
        },
      );
      t.after(async () => {
        unsubscribe.release();
        interrupt.release();
        await sessions.close().catch(() => {});
        await events.close();
        workflows.close();
        await state.close();
      });
      let firstDone = false,
        secondDone = false;
      const first = sessions.close();
      void first.then(
        () => {
          firstDone = true;
        },
        () => {
          firstDone = true;
        },
      );
      await unsubscribe.entered;
      const second = sessions.close();
      void second.then(
        () => {
          secondDone = true;
        },
        () => {
          secondDone = true;
        },
      );
      const outcomes = Promise.allSettled([first, second]);
      await assert.rejects(sessions.sweep(), { code: 'session_unavailable' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(firstDone, false);
      assert.equal(secondDone, false, 'A repeated close must still join the admitted event drain');
      assert.deepEqual(cleanup, ['events']);
      unsubscribe.release();
      await interrupt.entered;
      assert.deepEqual(cleanup, ['events', 'policy', 'authority', 'observations']);
      assert.equal(firstDone, false, 'A cleanup error must not end shutdown before later cleanup');
      assert.equal(secondDone, false);
      interrupt.release();
      const results = await outcomes;
      assert.ok(results.every((result) => result.status === (fails ? 'rejected' : 'fulfilled')));
      if (fails)
        for (const result of results)
          assert.equal((result as PromiseRejectedResult).reason, failure);
      await sessions.close().catch((error) => assert.equal(error, failure));
      assert.equal(cleanup.length, 4, 'Repeated close must not repeat resource cleanup');
    },
  );
