import assert from 'node:assert/strict';
import test from 'node:test';
import { createService, type SessionAuthority, type SessionToolPolicy } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { ApiServer } from '../packages/api/src/http.js';
import { ToolRegistry } from '../packages/api/src/registry.js';
import type { SessionApiProvider } from '../packages/api/src/types.js';
import { openState } from './fixtures/state.js';

test('a used event-listener disposer cannot remove a later subscription of the same callback', async (t) => {
  const state = await openState(':memory:');
  t.after(() => state.close());
  let calls = 0;
  const listener = () => {
    calls++;
  };
  const old = state.onEventsCommitted(listener);
  old();
  const current = state.onEventsCommitted(listener);
  old();
  const commit = () =>
    state.transaction((tx) =>
      state.appendEvent(tx, {
        projectId: 'project',
        actorId: 'actor',
        type: 'test.saved',
        subjectId: 'subject',
        data: {},
      }),
    );
  await commit();
  assert.equal(calls, 1, 'the current subscription must still receive committed events');
  current();
  await commit();
  assert.equal(calls, 1);
  const earlier = state.onEventsCommitted(listener);
  const later = state.onEventsCommitted(listener);
  earlier();
  await commit();
  assert.equal(calls, 2, 'overlapping subscriptions also own their callbacks independently');
  later();
});

for (const kind of ['authority', 'policy', 'http-sessions', 'http-mount'] as const) {
  test(`${kind}: a used disposer cannot withdraw a new registration of the same provider`, async (t) => {
    const state = await openState(':memory:');
    const scope = await createService(new ProjectScope(state));
    const tools = new ToolRegistry(scope);
    const api = new ApiServer(scope, tools);
    t.after(async () => {
      await api.stop();
      await tools.close();
      await state.close();
    });
    const authority: SessionAuthority = {
      require: async () => {
        throw new Error('not called');
      },
    };
    // Registration owns an opaque provider identity; this test does not dispatch routes.
    const sessions = {} as SessionApiProvider;
    const policy = {} as SessionToolPolicy;
    const handler = async () => {};
    const register = () =>
      kind === 'authority'
        ? scope.registerSessionAuthority(authority)
        : kind === 'policy'
          ? tools.registerSessionPolicy(policy)
          : kind === 'http-sessions'
            ? api.registerSessions(sessions)
            : api.mount('/fixture', handler);
    const conflict =
      kind === 'authority'
        ? 'session_authority_registered'
        : kind === 'http-mount'
          ? 'mount_conflict'
          : 'session_provider_conflict';
    const old = register();
    old();
    const current = register();
    old();
    assert.throws(register, { code: conflict }, 'the current registration must still own the slot');
    current();
    const replacement = register();
    current();
    old();
    assert.throws(register, { code: conflict });
    replacement();
    register()();
  });
}
