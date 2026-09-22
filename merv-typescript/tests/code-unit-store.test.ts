import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createService, type Caller, type Transaction } from '@merv/contracts';
import { SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { CodeUnitStore, type AcceptanceBody, type BaseBody } from '@merv/code/units';
import { CodeWriterService } from '@merv/code/writers';

/** The storage capability accepts facts from an owner; it has no research service to consult. */
class OwnerStore extends CodeUnitStore {
  declare(caller: Caller, unitId: string, tx: Transaction) {
    return this.retainDeclaration(caller, { unitId, workflow: 'external-owner', version: 9 }, tx);
  }
  pinFacts(caller: Caller, unitId: string, body: BaseBody, tx: Transaction) {
    return this.retainBase(
      caller,
      { unitId, workflow: 'external-owner', version: 9, leaseId: 'lease', body },
      tx,
    );
  }
  acceptFacts(caller: Caller, body: AcceptanceBody, tx: Transaction) {
    return this.retainUnitAcceptance(caller, body, tx);
  }
  reviewFacts(caller: Caller, body: AcceptanceBody, tx: Transaction) {
    return this.retainReviewAcceptance(caller, body, tx);
  }
  publishFacts(
    caller: Caller,
    unitId: string,
    reviewId: string,
    revision: number,
    tx: Transaction,
  ) {
    return this.retainPublishedAcceptance(caller, unitId, reviewId, revision, tx);
  }
}

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'merv-unit-store-'));
  const state = new SqliteState(join(root, 'state.sqlite'));
  const scope = await createService(new ProjectScope(state));
  const writers = new CodeWriterService(state, scope, 900);
  let store = await createService(new OwnerStore(state, scope, writers));
  t.after(async () => {
    store.close();
    writers.close();
    await state.close();
    rmSync(root, { recursive: true, force: true });
  });
  const principal = await scope.acceptVerifiedIdentity({
    issuer: 'https://identity.example/auth/v1',
    subject: 'owner',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  const project = await scope.createProject(principal, {
    name: 'Storage only',
    requestId: 'project',
  });
  const caller = await scope.caller(principal, project.id);
  const body = (unitId: string): AcceptanceBody => ({
    formatVersion: 1,
    unitId,
    workflow: 'external-owner',
    version: 9,
    terminalRevision: 2,
    submissionRef: 'submission',
    reviewRef: 'review',
    acceptedBy: caller.actorId,
    code: null,
    storage: 'none',
  });
  return {
    state,
    caller,
    body,
    get store() {
      return store;
    },
    async reopen() {
      store.close();
      store = await createService(new OwnerStore(state, scope, writers));
    },
  };
}

test('Code unit storage runs without research services and rolls facts back with its owner', async (t) => {
  const f = await fixture(t);
  const tables = await f.state.read((sql) =>
    sql.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'"),
  );
  assert.equal(
    tables.some(({ name }) => /^(workflow_instances|sessions|reviews)$/.test(name)),
    false,
  );
  const base: BaseBody = {
    formatVersion: 1,
    kind: 'accepted',
    reference: 'a'.repeat(40),
    repositoryId: 'repo',
    dependencies: [],
    sources: [],
    main: null,
  };
  await assert.rejects(
    f.state.transaction(async (tx) => {
      await f.store.declare(f.caller, 'rolled-back', tx);
      await f.store.pinFacts(f.caller, 'rolled-back', base, tx);
      await f.store.acceptFacts(f.caller, f.body('rolled-back'), tx);
      throw new Error('owner rejected');
    }),
    /owner rejected/,
  );
  await assert.rejects(f.store.unit(f.caller, 'rolled-back'), { code: 'code_unit_not_found' });

  await f.state.transaction(async (tx) => {
    await f.store.declare(f.caller, 'kept', tx);
    await f.store.pinFacts(f.caller, 'kept', base, tx);
    await f.store.acceptFacts(f.caller, f.body('kept'), tx);
  });
  const before = await f.store.unit(f.caller, 'kept');
  await f.reopen();
  await f.state.transaction((tx) => f.store.acceptFacts(f.caller, f.body('kept'), tx));
  assert.deepEqual(await f.store.unit(f.caller, 'kept'), before);
  await assert.rejects(
    f.state.transaction((tx) =>
      f.store.acceptFacts(f.caller, { ...f.body('kept'), submissionRef: 'different' }, tx),
    ),
    { code: 'code_acceptance_conflict' },
  );
  assert.deepEqual((await f.store.status(f.caller)).blockers, []);
});

test('review-round records stay separate from published acceptance and reject changed replay', async (t) => {
  const f = await fixture(t);
  const body = f.body('publication');
  await f.state.transaction((tx) => f.store.declare(f.caller, body.unitId, tx));
  const review = await f.state.transaction((tx) => f.store.reviewFacts(f.caller, body, tx));
  assert.equal((await f.store.unit(f.caller, body.unitId)).acceptance, null);
  await assert.rejects(
    f.state.transaction((tx) =>
      f.store.reviewFacts(f.caller, { ...body, submissionRef: 'changed' }, tx),
    ),
    { code: 'code_acceptance_conflict' },
  );
  await f.state.transaction((tx) =>
    f.store.publishFacts(f.caller, body.unitId, body.reviewRef, 3, tx),
  );
  const published = (await f.store.unit(f.caller, body.unitId)).acceptance!;
  assert.equal(published.reviewRef, body.reviewRef);
  assert.equal(published.terminalRevision, 3);
  assert.equal(published.acceptedAt, review.acceptedAt);
  assert.notEqual(published.hash, review.hash);
});
