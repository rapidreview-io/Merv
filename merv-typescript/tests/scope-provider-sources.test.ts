/**
 * Scope's three provider slots (sessions, managed runners and conversations) and the source each
 * provider vouches for. Each slot holds one provider, refuses a second, and fences a decision
 * whose provider was withdrawn or installed again while it was pending. The source a provider
 * returns must belong to the caller's project and, except for a worker's delegator, be the caller.
 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  createService,
  MervError,
  type Caller,
  type DelegationSource,
  type Scope,
} from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { deferred } from './fixtures/deferred.js';
import { openState } from './fixtures/state.js';

type Provider = { require: () => Promise<DelegationSource> };

async function fixture(t: TestContext) {
  const state = await openState(':memory:');
  t.after(() => state.close());
  const scope = await createService(new ProjectScope(state));
  const boot = await scope.bootstrap({ projectName: 'Provider sources', actorName: 'Owner' });
  const owner: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const source = await scope.delegationSource(owner);
  const other = (await scope.issueActor(owner, { name: 'Other', role: 'producer' })).actor;
  const worker = await state.transaction((tx) =>
    scope.createSessionActor(
      source,
      { sessionId: 'session_sources', name: 'Worker', role: 'producer' },
      tx,
    ),
  );
  const callers = {
    session: {
      actorId: worker.id,
      projectId: worker.projectId,
      session: { id: 'session_sources' },
    },
    managed: {
      actorId: owner.actorId,
      projectId: owner.projectId,
      managed: { allocationId: 'allocation_sources', epoch: 1, credentialHash: 'a'.repeat(64) },
    },
    conversation: {
      actorId: owner.actorId,
      projectId: owner.projectId,
      conversation: {
        id: 'conversation_sources',
        epoch: 1,
        commandId: 'command_sources',
        runtimeId: 'runtime_sources',
      },
    },
  } satisfies Record<string, Caller>;
  return { state, scope, owner, source, other, worker, callers };
}

const kinds = {
  session: {
    register: (scope: Scope, provider: Provider) => scope.registerSessionAuthority(provider),
    registered: 'session_authority_registered',
    unavailable: 'session_unavailable',
    name: 'Session authority',
    forbidden: 'forbidden',
  },
  managed: {
    register: (scope: Scope, provider: Provider) => scope.registerManagedRunnerAuthority(provider),
    registered: 'managed_authority_registered',
    unavailable: 'managed_runner_unavailable',
    name: 'Managed runner authority',
    forbidden: 'managed_runner_forbidden',
  },
  conversation: {
    register: (scope: Scope, provider: Provider) => scope.registerConversationAuthority(provider),
    registered: 'conversation_authority_registered',
    unavailable: 'conversation_unavailable',
    name: 'Conversation authority',
    forbidden: 'conversation_forbidden',
  },
} as const;

for (const [kind, slot] of Object.entries(kinds) as [
  keyof typeof kinds,
  (typeof kinds)[keyof typeof kinds],
][]) {
  test(`${kind}: one provider at a time, and a spent disposer withdraws nothing`, async (t) => {
    const f = await fixture(t);
    const caller = f.callers[kind];
    await assert.rejects(f.scope.require(caller, 'read'), {
      code: slot.unavailable,
      status: 503,
      message: `${slot.name} is unavailable`,
    });
    const provider: Provider = { require: async () => f.source };
    const first = slot.register(f.scope, provider);
    // A second install throws at once, before any await.
    assert.throws(() => slot.register(f.scope, provider), {
      code: slot.registered,
      status: 409,
      message: `${slot.name} is already installed`,
    });
    assert.ok(await f.scope.require(caller, 'read'));
    first();
    await assert.rejects(f.scope.require(caller, 'read'), { code: slot.unavailable, status: 503 });
    const second = slot.register(f.scope, provider);
    first();
    assert.ok(await f.scope.require(caller, 'read'), 'the spent disposer left the new provider');
    second();
    await assert.rejects(f.scope.require(caller, 'read'), { code: slot.unavailable, status: 503 });
  });

  for (const replace of [false, true])
    test(`${kind}: a provider ${replace ? 'installed again' : 'withdrawn'} while a decision is pending refuses it`, async (t) => {
      const f = await fixture(t);
      const entered = deferred();
      const release = deferred();
      let calls = 0;
      const provider: Provider = {
        require: async () => {
          if (calls++ === 0) {
            entered.resolve();
            await release.promise;
          }
          return f.source;
        },
      };
      const dispose = slot.register(f.scope, provider);
      const pending = f.scope.require(f.callers[kind], 'read');
      const rejected = assert.rejects(pending, {
        code: slot.unavailable,
        status: 503,
        message: new RegExp(`^${slot.name} changed during authorization`),
      });
      await entered.promise;
      dispose();
      if (replace) slot.register(f.scope, provider);
      release.resolve();
      await rejected;
      if (replace)
        assert.ok(await f.scope.require(f.callers[kind], 'read'), 'a fresh call is fine');
    });

  test(`${kind}: the provider's own refusal comes first`, async (t) => {
    const f = await fixture(t);
    slot.register(f.scope, {
      require: async () => {
        throw new MervError('unauthorized', 'Provider refused', 401);
      },
    });
    await assert.rejects(f.scope.require(f.callers[kind], 'read'), {
      code: 'unauthorized',
      status: 401,
    });
  });

  test(`${kind}: a missing or foreign-project source is refused`, async (t) => {
    const f = await fixture(t);
    let vouched: DelegationSource | undefined;
    slot.register(f.scope, { require: async () => vouched! });
    const caller = f.callers[kind];
    for (const source of [undefined, { ...f.source, projectId: 'project_foreign' }]) {
      vouched = source;
      await assert.rejects(f.scope.require(caller, 'read'), { code: slot.forbidden, status: 403 });
    }
    vouched = f.source;
    assert.ok(await f.scope.require(caller, 'read'));
  });
}

test('session: the source may be another actor of the project, the worker delegator', async (t) => {
  const f = await fixture(t);
  let vouched: DelegationSource = { ...f.source, projectId: 'project_foreign' };
  f.scope.registerSessionAuthority({ require: async () => vouched });
  await assert.rejects(f.scope.require(f.callers.session, 'read'), {
    code: 'forbidden',
    status: 403,
    message: 'Session source does not match this project',
  });
  vouched = f.source;
  assert.notEqual(f.source.actorId, f.worker.id);
  assert.equal((await f.scope.require(f.callers.session, 'read')).id, f.worker.id);
  assert.equal((await f.scope.authorityActor(f.callers.session)).id, f.owner.actorId);
});

for (const kind of ['managed', 'conversation'] as const)
  test(`${kind}: a source for another actor of the project is refused`, async (t) => {
    const f = await fixture(t);
    kinds[kind].register(f.scope, { require: async () => ({ ...f.source, actorId: f.other.id }) });
    await assert.rejects(f.scope.require(f.callers[kind], 'read'), {
      code: kinds[kind].forbidden,
      status: 403,
      message: `${kind === 'managed' ? 'Managed runner' : 'Conversation'} source does not match this caller`,
    });
  });

test('managed: a source whose actor was revoked is refused', async (t) => {
  const f = await fixture(t);
  const issued = await f.scope.issueActor(f.owner, { name: 'Runner owner', role: 'producer' });
  const source = await f.scope.delegationSource({
    actorId: issued.actor.id,
    projectId: issued.actor.projectId,
    credentialId: issued.credential.id,
  });
  f.scope.registerManagedRunnerAuthority({ require: async () => source });
  const runner: Caller = { ...f.callers.managed, actorId: issued.actor.id };
  assert.equal((await f.scope.require(runner, 'read')).id, issued.actor.id);
  await f.scope.revokeActor(f.owner, issued.actor.id);
  await assert.rejects(f.scope.require(runner, 'read'), {
    code: 'managed_runner_forbidden',
    status: 403,
    message: 'Managed runner source actor is revoked',
  });
});
