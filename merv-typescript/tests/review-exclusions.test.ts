import { createService, migrationList } from '@merv/contracts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { ArtifactStore } from '@merv/artifacts';
import { DiskBlobs } from '@merv/blobs';
import type { Caller, ReviewInput, Role } from '@merv/contracts';
import { ReviewService } from '@merv/reviews';
import { ProjectScope } from '@merv/scope';
import { assessment, ownReviews } from './fixtures/review-verdict.js';
import { openState } from './fixtures/state.js';

async function fixture(t: TestContext, version = Infinity) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-review-exclusions-'));
  const state = await openState(directory);
  const scope = await createService(new ProjectScope(state));
  const bootstrap = await scope.credentials.bootstrap({
    projectName: 'Contributor independence',
    actorName: 'Operator',
  });
  const operator: Caller = { actorId: bootstrap.actor.id, projectId: bootstrap.project.id };
  const issue = async (role: Role) => ({
    actorId: (await scope.credentials.issueActor(operator, { name: role, role })).actor.id,
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
      component === 'reviews'
        ? migrationList(migrations).filter((m) => m.version <= version)
        : migrations,
    );
  let reviews = await createService(new ReviewService(state, scope, artifacts));
  ownReviews(reviews);
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
      ownReviews(reviews);
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

test('excluded IDs must be authors in the exact scoped manifest and are validated without accessor effects', async (t) => {
  const f = await fixture(t);
  const other = await f.scope.credentials.bootstrap({
    projectName: 'Other',
    actorName: 'Other operator',
  });
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
