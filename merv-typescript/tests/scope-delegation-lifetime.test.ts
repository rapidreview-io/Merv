/**
 * A key or credential delegation source holds only with the deadline its row still has, and the
 * check reads that deadline without a statement of its own.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createService,
  type Caller,
  type DelegationSource,
  type Transaction,
} from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { openState } from './fixtures/state.js';

async function fixture(t: test.TestContext) {
  const state = await openState(':memory:');
  t.after(() => state.close());
  const scope = await createService(new ProjectScope(state));
  const boot = await scope.credentials.bootstrap({
    projectName: 'Delegation lifetime',
    actorName: 'Owner',
  });
  const owner: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const deadline = new Date(Date.now() + 3_600_000).toISOString();
  const lasting = await scope.credentials.issueActor(owner, { name: 'Lasting', role: 'producer' });
  const expiring = await scope.credentials.issueActorCredential(owner, {
    actorId: lasting.actor.id,
    expiresAt: deadline,
  });
  const alice = await scope.members.acceptVerifiedIdentity({
    issuer: 'https://identity.example/auth/v1',
    subject: 'alice',
    expiresAt: deadline,
  });
  const project = await scope.members.createProject(alice, { name: 'Keys', requestId: 'keys' });
  const key = async (expiresAt: string | null) =>
    await scope.caller({
      kind: 'key',
      key: (await scope.userKeys.create(alice, { projectId: project.id, expiresAt })).key,
    });
  return { state, scope, owner, lasting, expiring, deadline, key };
}

/** Counts the statements run on `tx` while `run` uses it. */
async function statements(tx: Transaction, run: () => Promise<unknown>) {
  let count = 0;
  const counted = tx as unknown as Record<'get' | 'all' | 'run', (...args: unknown[]) => unknown>;
  for (const method of ['get', 'all', 'run'] as const) {
    const original = counted[method].bind(tx);
    counted[method] = (...args) => {
      count++;
      return original(...args);
    };
  }
  await run();
  return count;
}

test('a credential or key source carries its own deadline and holds only with it', async (t) => {
  const f = await fixture(t);
  const credentialCaller: Caller = {
    actorId: f.lasting.actor.id,
    projectId: f.owner.projectId,
    credentialId: f.expiring.credential.id,
  };
  const sources: [string, DelegationSource, string | null][] = [
    ['bootstrap credential', await f.scope.delegationSource(f.owner), null],
    ['expiring credential', await f.scope.delegationSource(credentialCaller), f.deadline],
    ['lasting key', await f.scope.delegationSource(await f.key(null)), null],
    ['expiring key', await f.scope.delegationSource(await f.key(f.deadline)), f.deadline],
  ];
  for (const [name, source, expiresAt] of sources)
    await t.test(name, async () => {
      assert.ok(source.kind === 'actor' || source.kind === 'key');
      assert.equal(source.expiresAt, expiresAt);
      assert.equal((await f.scope.requireDelegation(source, 'read')).id, source.actorId);
      for (const changed of [
        expiresAt === null ? f.deadline : null,
        new Date(Date.now() + 7_200_000).toISOString(),
      ])
        await assert.rejects(f.scope.requireDelegation({ ...source, expiresAt: changed }, 'read'), {
          code: 'invalid_delegation',
          status: 403,
        });
    });
});

test('a delegated credential or key check reads its deadline with the decision', async (t) => {
  const f = await fixture(t);
  for (const [name, source, expected] of [
    ['credential', await f.scope.delegationSource(f.owner), 3],
    ['key', await f.scope.delegationSource(await f.key(null)), 4],
  ] as const)
    await t.test(name, async () => {
      const count = await f.state.transaction(async (tx) =>
        statements(tx, () => f.scope.requireDelegation(source, 'read', tx)),
      );
      assert.equal(count, expected);
    });
});
