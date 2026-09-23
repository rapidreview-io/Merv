import { createService } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { ReviewService } from '@merv/reviews';
import type { Caller, ReviewInput, Role } from '@merv/contracts';
import { openState } from './fixtures/state.js';
import { assessment } from './fixtures/review-verdict.js';

async function fixture(t: TestContext, version = Infinity) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-review-exclusions-'));
  const state = await openState(directory);
  const scope = await createService(new ProjectScope(state));
  const bootstrap = await scope.bootstrap({
    projectName: 'Contributor independence',
    actorName: 'Operator',
  });
  const operator: Caller = { actorId: bootstrap.actor.id, projectId: bootstrap.project.id };
  const issue = async (role: Role) => ({
    actorId: (await scope.issueActor(operator, { name: role, role })).actor.id,
    projectId: operator.projectId,
  });
  const producer = await issue('producer'),
    lensA = await issue('operator'),
    lensB = await issue('operator'),
    reviewer = await issue('reviewer');
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const output = await artifacts.create(producer, {
    title: 'Synthesis',
    content: 'The combined project findings.',
  });
  const inputA = await artifacts.create(lensA, {
    title: 'Lens A',
    content: 'Independent analysis A.',
  });
  const inputB = await artifacts.create(lensB, {
    title: 'Lens B',
    content: 'Independent analysis B.',
  });
  const migrate = state.migrate.bind(state);
  state.migrate = async (component, migrations) =>
    await migrate(
      component,
      component === 'reviews' ? migrations.filter((m) => m.version <= version) : migrations,
    );
  let reviews = await createService(new ReviewService(state, scope, artifacts));
  state.migrate = migrate;
  let seq = 0;
  const input = (): ReviewInput => ({
    subjectId: 'reflection-wave',
    subjectRevision: 4,
    producerId: producer.actorId,
    artifactIds: [output.id, inputA.id, inputB.id],
    pinnedInputIds: [inputA.id, inputB.id],
    criteria: ['The synthesis represents the evidence accurately.'],
    requestId: `exclusions-${++seq}`,
  });
  t.after(async () => {
    reviews.close();
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    state,
    scope,
    artifacts,
    operator,
    producer,
    lensA,
    lensB,
    reviewer,
    input,
    get reviews() {
      return reviews;
    },
    async reload() {
      reviews.close();
      reviews = await createService(new ReviewService(state, scope, artifacts));
    },
  };
}

test('pinned contributors cannot claim or submit synthesis review; independent reviewers retain normal lifecycle', async (t) => {
  const f = await fixture(t);
  const input = { ...f.input(), excludedActorIds: [f.lensB.actorId, f.lensA.actorId] };
  const review = await f.reviews.request(f.producer, input);
  assert.deepEqual(review.excludedActorIds, [f.lensA.actorId, f.lensB.actorId].sort());
  for (const caller of [f.lensA, f.lensB]) {
    await assert.rejects(async () => await f.reviews.checkStart(caller, review.id), {
      code: 'review_independence',
    });
    await assert.rejects(async () => await f.reviews.start(caller, review.id), {
      code: 'review_independence',
    });
  }
  // A list tells its reader which reviews are its move, so no client has to restate the rule
  // and get it wrong: an excluded contributor was once shown "your move" and refused on the
  // click, because the page compared the producer alone.
  const listed = async (caller: Caller) =>
    (await f.reviews.list(caller)).find((entry) => entry.id === review.id)?.claimable;
  for (const caller of [f.lensA, f.lensB, f.producer]) assert.equal(await listed(caller), false);
  assert.equal(await listed(f.reviewer), true);
  const claimed = await f.reviews.start(f.reviewer, review.id);
  // Claimed is nobody's to claim, including the reviewer holding it.
  assert.equal(await listed(f.reviewer), false);
  for (const caller of [f.lensA, f.lensB])
    await assert.rejects(async () => await f.reviews.checkSubmit(caller, review.id), {
      code: 'review_independence',
    });
  const submitted = await f.reviews.submit(f.reviewer, {
    reviewId: review.id,
    claimId: claimed.claimId!,
    verdict: 'pass',
    notes: 'Verified the synthesis against each pinned lens.',
    ...assessment(claimed),
    requestId: 'verdict',
  });
  assert.equal(submitted.status, 'submitted');
  assert.deepEqual(submitted.excludedActorIds, review.excludedActorIds);
  await f.reload();
  assert.deepEqual(await f.reviews.get(f.reviewer, review.id), submitted);
  assert.deepEqual(await f.reviews.request(f.producer, input), review);
});

test('exclusions are immutable set-valued provenance in snapshot and replay, retained across reissue and revocation', async (t) => {
  const f = await fixture(t);
  const input = { ...f.input(), excludedActorIds: [f.lensB.actorId, f.lensA.actorId] };
  const review = await f.reviews.request(f.producer, input);
  assert.deepEqual(
    await f.reviews.request(f.producer, {
      ...input,
      excludedActorIds: [f.lensA.actorId, f.lensB.actorId, f.lensA.actorId],
    }),
    review,
  );
  for (const exclusions of [[f.lensA.actorId], [], undefined])
    await assert.rejects(
      async () => await f.reviews.request(f.producer, { ...input, excludedActorIds: exclusions }),
      {
        code: 'request_conflict',
      },
    );
  const otherwiseSame = await f.reviews.request(f.producer, {
    ...input,
    requestId: 'different-snapshot',
    excludedActorIds: [f.lensA.actorId],
  });
  assert.notEqual(otherwiseSame.snapshotHash, review.snapshotHash);
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) =>
          await tx.run('UPDATE reviews SET excluded_actor_ids=? WHERE id=?', '[]', review.id),
      ),
    { code: 'state_constraint' },
  );
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) =>
          await tx.run(
            "UPDATE reviews SET reviewer_id=?,status='started' WHERE id=?",
            f.lensA.actorId,
            review.id,
          ),
      ),
    { code: 'state_constraint' },
  );
  await f.scope.revokeActor(f.operator, f.lensA.actorId);
  const reissueInput = {
    reviewId: review.id,
    subjectRevision: 5,
    requestId: 'reissue',
  };
  const reissuing = f.reviews.reissue(f.producer, reissueInput);
  reissueInput.subjectRevision = 99;
  const reissued = await reissuing;
  assert.equal(reissued.subjectRevision, 5);
  assert.deepEqual(reissued.excludedActorIds, review.excludedActorIds);
  await assert.rejects(async () => await f.reviews.start(f.lensA, reissued.id), {
    code: 'forbidden',
  });
  await assert.rejects(async () => await f.reviews.start(f.lensB, reissued.id), {
    code: 'review_independence',
  });
  assert.deepEqual(
    (await f.reviews.request(f.producer, { ...input, requestId: 'after-contributor-revoked' }))
      .excludedActorIds,
    review.excludedActorIds,
  );
  const claimed = await f.reviews.start(f.reviewer, reissued.id);
  await f.scope.revokeActor(f.operator, f.reviewer.actorId);
  await assert.rejects(
    async () =>
      await f.reviews.submit(f.reviewer, {
        reviewId: reissued.id,
        claimId: claimed.claimId!,
        verdict: 'pass',
        notes: 'Cannot submit after losing authority.',
        ...assessment(claimed),
        requestId: 'revoked-verdict',
      }),
    { code: 'forbidden' },
  );
});

test('excluded IDs must be authors in the exact scoped manifest and are validated without accessor effects', async (t) => {
  const f = await fixture(t);
  const other = await f.scope.bootstrap({ projectName: 'Other', actorName: 'Other operator' });
  const outsider = { projectId: other.project.id, actorId: other.actor.id };
  const otherOutput = await f.artifacts.create(outsider, {
    title: 'Foreign lens',
    content: 'Not this project.',
  });
  for (const excludedActorIds of [
    [outsider.actorId],
    [f.reviewer.actorId],
    ['actor_missing'],
    [''],
    Array(1),
  ])
    await assert.rejects(
      async () => await f.reviews.request(f.producer, { ...f.input(), excludedActorIds }),
      {
        code: 'invalid_review_exclusions',
      },
    );
  const cross = f.input();
  await assert.rejects(
    async () =>
      await f.reviews.request(f.producer, {
        ...cross,
        artifactIds: [...cross.artifactIds, otherOutput.id],
        pinnedInputIds: [...cross.pinnedInputIds!, otherOutput.id],
        excludedActorIds: [outsider.actorId],
      }),
    { code: 'not_found' },
  );
  let calls = 0;
  const accessor = Object.defineProperty(f.input(), 'excludedActorIds', {
    enumerable: true,
    get() {
      calls++;
      return [f.lensA.actorId];
    },
  });
  await assert.rejects(async () => await f.reviews.request(f.producer, accessor), {
    code: 'invalid_review_exclusions',
  });
  const array = Object.defineProperty([f.lensA.actorId], 0, {
    get() {
      calls++;
      return f.lensA.actorId;
    },
  });
  await assert.rejects(
    async () => await f.reviews.request(f.producer, { ...f.input(), excludedActorIds: array }),
    {
      code: 'invalid_review_exclusions',
    },
  );
  assert.equal(calls, 0);
  assert.equal((await f.reviews.list(f.operator)).length, 0);
});

test('additive migration preserves legacy snapshot hash, absent field and stored command replay', async (t) => {
  const f = await fixture(t, 6);
  const input = f.input();
  const requested = await f.reviews.request(f.producer, input);
  const claimed = await f.reviews.start(f.reviewer, requested.id);
  const submit = {
    reviewId: claimed.id,
    claimId: claimed.claimId!,
    verdict: 'pass' as const,
    notes: 'Verified independently before migration.',
    ...assessment(claimed),
    requestId: 'legacy-verdict',
  };
  const submitted = await f.reviews.submit(f.reviewer, submit);
  const stored = await f.state.read(
    async (sql) => await sql.all('SELECT * FROM review_commands ORDER BY request_id'),
  );
  assert.equal(Object.hasOwn(requested, 'excludedActorIds'), false);
  await f.reload();
  assert.deepEqual(
    await f.state.read(
      async (sql) => await sql.all('SELECT * FROM review_commands ORDER BY request_id'),
    ),
    stored,
  );
  assert.deepEqual(await f.reviews.get(f.operator, requested.id), submitted);
  assert.deepEqual(
    await f.reviews.request(f.producer, { ...input, excludedActorIds: undefined }),
    requested,
  );
  assert.deepEqual(await f.reviews.submit(f.reviewer, submit), submitted);
  assert.equal(
    Object.hasOwn(await f.reviews.get(f.operator, requested.id), 'excludedActorIds'),
    false,
  );
  const legacy = await f.reviews.request(f.producer, f.input());
  assert.equal((await f.reviews.start(f.lensA, legacy.id)).reviewerId, f.lensA.actorId);
});

test('review entrypoints retain their caller and preflight claim', async (t) => {
  for (const method of [
    'get',
    'list',
    'checkStart',
    'start',
    'checkSubmit',
    'supersede',
  ] as const) {
    await t.test(method, async (t) => {
      const f = await fixture(t);
      const review = await f.reviews.request(f.producer, f.input());
      const other = await f.scope.bootstrap({ projectName: 'Other', actorName: 'Other' });
      const foreign = { projectId: other.project.id, actorId: other.actor.id };
      const reading = method === 'get' || method === 'list';
      const caller = { ...(reading ? foreign : f.reviewer) };
      if (method === 'supersede')
        caller.actorId = (
          await f.scope.issueActor(f.operator, { name: 'Other producer', role: 'producer' })
        ).actor.id;
      const claim = method === 'checkSubmit' ? await f.reviews.start(f.reviewer, review.id) : null;
      const input = {
        claimId: 'wrong-claim',
        reviewId: review.id,
        verdict: 'pass' as const,
        notes: 'Checked.',
      };
      const authorize = f.scope.require.bind(f.scope);
      t.mock.method(f.scope, 'require', async (...args: Parameters<typeof authorize>) => {
        const result = await authorize(...args);
        if (method === 'checkSubmit') input.claimId = claim!.claimId!;
        else Object.assign(caller, reading ? f.operator : f.producer);
        return result;
      });
      if (method === 'get')
        await assert.rejects(f.reviews.get(caller, review.id), { code: 'not_found' });
      else if (method === 'list') assert.deepEqual(await f.reviews.list(caller), []);
      else if (method === 'checkSubmit')
        await assert.rejects(f.reviews.checkSubmit(caller, review.id, input), {
          code: 'stale_claim',
        });
      else if (method === 'supersede')
        await assert.rejects(f.reviews.supersede(caller, review.id), { code: 'forbidden' });
      else {
        const result = await f.reviews[method](caller, review.id);
        assert.equal(result.status, method === 'start' ? 'started' : 'requested');
        if (method === 'start') assert.equal(result.reviewerId, f.reviewer.actorId);
      }
    });
  }
});

test('review requests retain the validated evidence list while artifact lookup yields', async (t) => {
  const f = await fixture(t);
  const input = f.input(),
    original = structuredClone(input);
  const get = f.artifacts.get.bind(f.artifacts);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  t.mock.method(f.artifacts, 'get', async (...args: Parameters<typeof get>) => {
    const result = await get(...args);
    if (first) {
      first = false;
      enter();
      await waiting;
    }
    return result;
  });
  const caller = { ...f.producer };
  const pending = f.reviews.request(caller, input);
  try {
    await entered;
    input.artifactIds[0] = 'unchecked-artifact';
    input.criteria[0] = '';
    Object.assign(caller, f.lensA);
  } finally {
    release();
  }
  const review = await pending;
  assert.equal((await f.state.events(f.operator.projectId)).at(-1)!.actorId, f.producer.actorId);
  assert.deepEqual(review.artifactIds, original.artifactIds);
  assert.deepEqual(review.criteria, original.criteria);
  const row = await f.state.read((sql) =>
    sql.get<{ manifest: string }>('SELECT manifest FROM reviews WHERE id=?', review.id),
  );
  assert.deepEqual(
    review.artifactIds,
    JSON.parse(row!.manifest).map((artifact: { id: string }) => artifact.id),
  );
  assert.deepEqual(await f.reviews.request(f.producer, original), review);
});

test('review submission retains the decision checked before a pending validation returns', async (t) => {
  const f = await fixture(t);
  const review = await f.reviews.request(f.producer, f.input());
  const claim = await f.reviews.start(f.reviewer, review.id);
  const original = {
    reviewId: review.id,
    claimId: claim.claimId!,
    verdict: 'pass' as const,
    notes: 'Checked all evidence.',
    ...assessment(claim),
    requestId: 'stable-decision',
  };
  const input = { ...original };
  const checkSubmit = f.reviews.checkSubmit.bind(f.reviews);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(f.reviews, 'checkSubmit', async (...args: Parameters<typeof checkSubmit>) => {
    const result = await checkSubmit(...args);
    enter();
    await waiting;
    return result;
  });
  const caller = { ...f.reviewer };
  const pending = f.reviews.submit(caller, input);
  try {
    await entered;
    input.notes = '';
    Object.assign(caller, f.producer);
  } finally {
    release();
  }
  const result = await pending;
  assert.equal(result.notes, original.notes);
  assert.equal((await f.state.events(f.operator.projectId)).at(-1)!.actorId, f.reviewer.actorId);
  assert.deepEqual(await f.reviews.submit(f.reviewer, original), result);
});

test('a reissue replays the exclusions a delivery pinned, whoever asks for the new claim', async (t) => {
  const f = await fixture(t);
  const runner = {
    actorId: (await f.scope.issueActor(f.operator, { name: 'Fleet runner', role: 'operator' }))
      .actor.id,
    projectId: f.operator.projectId,
  };
  // A leased delivery pins the record's owner and the authority that directed the worker.
  // That authority is rarely the one asking for the new claim, and the set it pinned is not
  // the reissuer's to justify again: it was admitted once, when the delivery made it.
  const review = await f.reviews.request(runner, {
    ...f.input(),
    excludedActorIds: [f.producer.actorId, runner.actorId],
  });
  assert.deepEqual(review.excludedActorIds, [f.producer.actorId, runner.actorId].sort());
  for (const [caller, requestId] of [
    [f.producer, 'reissue-by-owner'],
    [f.operator, 'reissue-by-another-operator'],
  ] as const) {
    const reissued = await f.reviews.reissue(caller, {
      reviewId: review.id,
      subjectRevision: 5,
      requestId,
    });
    assert.deepEqual(reissued.excludedActorIds, review.excludedActorIds);
    await assert.rejects(async () => await f.reviews.start(runner, reissued.id), {
      code: 'review_independence',
    });
  }
});
