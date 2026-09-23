import assert from 'node:assert/strict';
import test from 'node:test';
import { createService, type SessionAuthority } from '@merv/contracts';

import { ProjectScope } from '@merv/scope';
import { openState } from './fixtures/state.js';

for (const operation of ['require', 'authority', 'delegation'] as const) {
  for (const replace of [false, true]) {
    test(`${operation} refuses authority ${replace ? 're-registered' : 'withdrawn'} while authorization is pending`, async (t) => {
      const state = await openState(':memory:');
      t.after(() => state.close());
      const scope = await createService(new ProjectScope(state));
      const boot = await scope.bootstrap({ projectName: 'Authority lifetime', actorName: 'Owner' });
      const owner = {
        actorId: boot.actor.id,
        projectId: boot.project.id,
        credentialId: boot.credential.id,
      };
      const source = await scope.delegationSource(owner);
      const worker = await state.transaction((tx) =>
        scope.createSessionActor(
          source,
          {
            sessionId: 'session_fixture',
            name: 'Worker',
            role: 'producer',
          },
          tx,
        ),
      );
      const caller = {
        actorId: worker.id,
        projectId: worker.projectId,
        session: { id: 'session_fixture' },
      };
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      const authority: SessionAuthority = {
        require: async () => {
          calls++;
          if (
            (operation === 'require' && calls === 1) ||
            (operation === 'authority' && calls === 2)
          ) {
            enter();
            await waiting;
          }
          return source;
        },
      };
      if (operation === 'delegation') {
        const requireDelegation = scope.requireDelegation.bind(scope);
        t.mock.method(
          scope,
          'requireDelegation',
          async (...args: Parameters<typeof requireDelegation>) => {
            const result = await requireDelegation(...args);
            enter();
            await waiting;
            return result;
          },
        );
      }
      const dispose = scope.registerSessionAuthority(authority);
      const pending = state.transaction(async (tx) => {
        const actor =
          operation === 'require'
            ? await scope.require(caller, 'read', tx)
            : await scope.authorityActor(caller, tx);
        await state.appendEvent(tx, {
          projectId: caller.projectId,
          actorId: caller.actorId,
          type: 'test.authorized',
          subjectId: 'subject',
          data: {},
        });
        return actor;
      });
      const rejected = assert.rejects(pending, { code: 'session_unavailable' });
      await entered;
      dispose();
      if (replace) scope.registerSessionAuthority(authority);
      release();
      await rejected;
      assert.equal(
        (await state.events(caller.projectId)).filter((event) => event.type === 'test.authorized')
          .length,
        0,
      );
      if (replace)
        assert.equal(
          (await scope.require(caller, 'read')).id,
          worker.id,
          'a fresh check can use the new registration',
        );
    });
  }
}
