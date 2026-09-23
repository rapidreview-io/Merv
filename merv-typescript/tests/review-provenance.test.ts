import assert from 'node:assert/strict';
import test from 'node:test';
import { createService, digest, type Caller, type Transaction } from '@merv/contracts';
import { ReviewService } from '@merv/reviews';
import { resolutionFixture } from './fixtures/resolution.js';

test('provenance migration preserves populated reviews and freezes certificates', async (t) => {
  const f = await resolutionFixture(t, { reviews: 8 });
  const producer = {
    projectId: f.admin.projectId,
    actorId: (await f.scope.issueActor(f.admin, { name: 'Producer', role: 'producer' })).actor.id,
  };
  const output = await f.artifacts.create(producer, {
    title: 'Evidence',
    content: 'Retained.',
  });
  const input = {
    subjectId: 'subject',
    subjectRevision: 0,
    producerId: producer.actorId,
    artifactIds: [output.id],
    criteria: ['Correct'],
    requestId: 'old',
  };
  const before = await f.reviews.request(producer, input);
  const reviews = await createService(new ReviewService(f.state, f.scope, f.artifacts));
  f.beforeClose.push(() => reviews.close());
  assert.deepEqual(await reviews.get(producer, before.id), before);
  assert.deepEqual(await reviews.request(producer, input), before);
  const body = {
    formatVersion: 1 as const,
    provider: 'fixture',
    reference: 'subject',
    sourceHash: digest(output),
    excludedActorIds: [producer.actorId],
  };
  let computations = 0;
  const release = reviews.provenance('fixture').register(async () => {
    computations++;
    return { ...body, hash: digest(body) };
  });
  const certified = await reviews.request(producer, {
    ...input,
    provenanceOwner: 'fixture',
    requestId: 'certified',
  });
  assert.ok(certified.provenance);
  for (const id of [before.id, certified.id]) {
    await assert.rejects(
      f.state.transaction((tx) =>
        tx.run('UPDATE reviews SET provenance_json=? WHERE id=?', '{}', id),
      ),
      { code: 'state_constraint' },
    );
    await assert.rejects(
      f.state.transaction((tx) => tx.run('DELETE FROM reviews WHERE id=?', id)),
      { code: 'state_constraint' },
    );
  }
  release();
  const writes = t.mock.method(f.state, 'transaction', () =>
    assert.fail('review reads must not open write transactions'),
  );
  await reviews.get(f.admin, certified.id);
  assert.equal(
    (await reviews.list(f.admin)).find((review) => review.id === certified.id)?.claimable,
    true,
  );
  writes.mock.restore();
  const claimed = await reviews.start(f.admin, certified.id);
  assert.equal(
    (
      await reviews.submit(f.admin, {
        reviewId: certified.id,
        claimId: claimed.claimId!,
        verdict: 'pass',
        notes: 'Checked',
        requestId: 'pass',
      })
    ).verdict,
    'pass',
  );
  assert.equal(computations, 1, 'the owner supplies the certificate only at creation');
  // The optional provider never changes an ordinary review's behavior.
  const legacy = await reviews.start(f.admin, before.id);
  assert.equal(
    (
      await reviews.submit(f.admin, {
        reviewId: before.id,
        claimId: legacy.claimId!,
        verdict: 'pass',
        notes: 'Checked',
        requestId: 'old-pass',
      })
    ).verdict,
    'pass',
  );
});
test("submission checks the caller's current directing authority against pinned provenance", async (t) => {
  const f = await resolutionFixture(t);
  const producer = {
    projectId: f.admin.projectId,
    actorId: (await f.scope.issueActor(f.admin, { name: 'Contributor', role: 'producer' })).actor
      .id,
  };
  const output = await f.artifacts.create(producer, { title: 'Evidence', content: 'Checked' });
  const contributor = {
    projectId: f.admin.projectId,
    actorId: (await f.scope.issueActor(f.admin, { name: 'Input writer', role: 'producer' })).actor
      .id,
  };
  const body = {
    formatVersion: 1 as const,
    provider: 'fixture',
    reference: 'subject',
    sourceHash: digest(output),
    excludedActorIds: [contributor.actorId],
  };
  let computations = 0;
  f.reviews.provenance('fixture').register(async () => {
    computations++;
    return { ...body, hash: digest(body) };
  });
  const review = await f.reviews.request(producer, {
    subjectId: 'subject',
    subjectRevision: 0,
    producerId: producer.actorId,
    artifactIds: [output.id],
    criteria: ['Correct'],
    provenanceOwner: 'fixture',
    requestId: 'request',
  });
  let directing = contributor;
  t.mock.method(f.scope, 'authorityActor', async (_caller: Caller, tx?: Transaction) =>
    f.scope.require(directing, 'read', tx),
  );
  await assert.rejects(f.reviews.start(f.admin, review.id), { code: 'review_independence' });
  directing = f.admin;
  const claim = await f.reviews.start(f.admin, review.id);
  directing = contributor;
  await assert.rejects(f.reviews.checkSubmit(f.admin, review.id), {
    code: 'review_independence',
  });
  await assert.rejects(
    f.reviews.submit(f.admin, {
      reviewId: review.id,
      claimId: claim.claimId!,
      verdict: 'pass',
      notes: 'Checked',
      requestId: 'submit',
    }),
    { code: 'review_independence' },
  );
  const retained = await f.reviews.get(f.admin, review.id);
  assert.equal(retained.status, 'started');
  assert.deepEqual(retained.provenance, review.provenance);
  assert.equal(computations, 1);
});
