import { createService, migrationList } from '@merv/contracts';

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ArtifactStore } from '@merv/artifacts';
import { DiskBlobs } from '@merv/blobs';
import {
  check,
  type ReviewApplication,
  type ReviewRequest,
  type ReviewSubmit,
} from '@merv/contracts';
import { ReviewService } from '@merv/reviews';

import { ProjectScope } from '@merv/scope';

import { assessment, claimUnowned } from './fixtures/review-verdict.js';
import { openState } from './fixtures/state.js';

async function fixture(maximumMigration = Infinity) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-review-return-'));
  const path = directory;
  const state = await openState(path);
  const scope = await createService(new ProjectScope(state));
  const boot = await scope.credentials.bootstrap({
    projectName: 'Return route',
    actorName: 'Operator',
  });
  const operator = { actorId: boot.actor.id, projectId: boot.project.id };
  const issue = async (role: 'producer' | 'reviewer' | 'reader') => {
    const actor = await scope.credentials.issueActor(operator, { name: role, role });
    return { token: actor.token, caller: { actorId: actor.actor.id, projectId: boot.project.id } };
  };
  const producer = await issue('producer'),
    reviewer = await issue('reviewer'),
    reader = await issue('reader');
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const proof = await artifacts.create(producer.caller, {
    title: 'Proof',
    content: 'A retained observation.',
  });
  const migrate = state.migrate.bind(state);
  state.migrate = async (component, migrations) =>
    await migrate(
      component,
      component === 'reviews'
        ? migrationList(migrations).filter((item) => item.version <= maximumMigration)
        : migrations,
    );
  const reviews = await createService(new ReviewService(state, scope, artifacts));
  state.migrate = migrate;
  let sequence = 0;
  const request = async () =>
    await reviews.request(producer.caller, {
      subjectId: `domain-${++sequence}`,
      subjectRevision: 0,
      producerId: producer.caller.actorId,
      artifactIds: [proof.id],
      criteria: ['The observation is reproducible.'],
      requestId: `request-${sequence}`,
    });
  const claim = async () => await claimUnowned(reviews, reviewer.caller, (await request()).id);
  const input = (review: ReviewRequest): ReviewSubmit => ({
    reviewId: review.id,
    claimId: review.claimId!,
    verdict: 'needs_changes',
    notes: 'The observation needs another independent check.',
    ...assessment(review),
    requestId: `submit-${++sequence}`,
  });
  const durable = async () =>
    await state.read(async (sql) => ({
      reviews: await sql.all('SELECT * FROM reviews ORDER BY id'),
      commands: await sql.all('SELECT * FROM review_commands ORDER BY actor_id,request_id'),
      events: await state.events(operator.projectId),
    }));
  return {
    directory,
    path,
    state,
    scope,
    reviews,
    artifacts,
    operator,
    producer,
    reviewer,
    reader,
    request,
    claim,
    input,
    durable,
    async close() {
      await state.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('selected review routes are immutable verdict evidence, included in replay identity, and survive restart', async () => {
  const f = await fixture();
  try {
    const review = await f.claim();
    assert.equal(Object.hasOwn(review, 'returnTo'), false);
    const input = { ...f.input(review), returnTo: 'repair.check-1' };
    const before = await f.durable();
    assert.equal(
      (await f.reviews.checkSubmit(f.reviewer.caller, review.id, input)).status,
      'started',
    );
    assert.deepEqual(await f.durable(), before);
    const result = await f.reviews.submit(f.reviewer.caller, input);
    assert.equal(result.returnTo, input.returnTo);
    assert.equal(result.snapshotHash, review.snapshotHash);
    assert.deepEqual(await f.reviews.get(f.reader.caller, result.id), result);
    assert.equal((await f.reviews.list(f.reader.caller))[0].returnTo, input.returnTo);
    // A record's page reads only its own reviews.
    assert.deepEqual(
      (await f.reviews.list(f.reader.caller, { subjectId: review.subjectId })).map(
        (item) => item.id,
      ),
      [review.id],
    );
    assert.deepEqual(await f.reviews.list(f.reader.caller, { subjectId: 'wf_other' }), []);
    assert.equal(
      (await f.state.events(f.operator.projectId)).at(-1)?.data.returnTo,
      input.returnTo,
    );
    const committed = await f.durable();
    assert.deepEqual(await f.reviews.submit(f.reviewer.caller, input), result);
    for (const returnTo of ['other', undefined])
      await assert.rejects(
        async () => await f.reviews.submit(f.reviewer.caller, { ...input, returnTo }),
        {
          code: 'request_conflict',
        },
      );
    assert.deepEqual(await f.durable(), committed);
    for (const replacement of ['other', null])
      await assert.rejects(
        async () =>
          await f.state.transaction(
            async (tx) =>
              await tx.run('UPDATE reviews SET return_to=? WHERE id=?', replacement, result.id),
          ),
        { code: 'state_constraint' },
      );
    await f.state.close();
    const state = await openState(f.path);
    try {
      const scope = await createService(new ProjectScope(state));
      const reviews = await createService(
        new ReviewService(
          state,
          scope,
          await createService(
            new ArtifactStore(state, scope, new DiskBlobs(join(f.directory, 'blobs'))),
          ),
        ),
      );
      assert.deepEqual(await reviews.get(f.reader.caller, result.id), result);
      assert.deepEqual(await reviews.submit(f.reviewer.caller, input), result);
      assert.equal(
        (await state.events(f.operator.projectId)).filter(
          (event) => event.type === 'review.submitted',
        ).length,
        1,
      );
    } finally {
      await state.close();
    }
  } finally {
    await f.close();
  }
});

test('the current review owner chooses required routes and rolls back route, receipt, event and domain transition together', async () => {
  const f = await fixture();
  try {
    const review = await f.claim();
    await f.state.transaction(async (tx) => {
      await tx.run('CREATE TABLE return_fixture (id TEXT PRIMARY KEY,state TEXT)');
      await tx.run('INSERT INTO return_fixture VALUES(?,?)', review.subjectId, 'review');
    });
    let failLate = false;
    const install = () =>
      f.reviews.registerSubmitOwner({
        id: 'return-fixture',
        owns: async (request) => request.id === review.id,
        async submit(caller, input, tx) {
          check(
            input.verdict === 'needs_changes' && ['repair', 'retry'].includes(input.returnTo ?? ''),
            'domain_return_required',
            'Choose a domain return destination',
          );
          const submitted = await f.reviews.submit(caller, input, tx);
          await tx.run(
            'UPDATE return_fixture SET state=? WHERE id=?',
            input.returnTo!,
            review.subjectId,
          );
          if (failLate) throw new Error('Owner transition failed');
          return submitted;
        },
      });
    const dispose = install();
    const input: ReviewApplication = { ...f.input(review), expectedRevision: 0 };
    const before = await f.durable();
    for (const returnTo of [undefined, 'elsewhere'])
      await assert.rejects(
        async () => await f.reviews.apply(f.reviewer.caller, { ...input, returnTo }),
        {
          code: 'domain_return_required',
        },
      );
    failLate = true;
    await assert.rejects(
      async () => await f.reviews.apply(f.reviewer.caller, { ...input, returnTo: 'repair' }),
      /Owner transition failed/,
    );
    assert.deepEqual(await f.durable(), before);
    assert.equal(
      await f.state.read(
        async (sql) =>
          (await sql.get<{ state: string }>('SELECT state FROM return_fixture'))!.state,
      ),
      'review',
    );
    dispose();
    await assert.rejects(
      async () => await f.reviews.apply(f.reviewer.caller, { ...input, returnTo: 'repair' }),
      {
        code: 'review_owner_unavailable',
      },
    );
    install();
    failLate = false;
    const result = (await f.reviews.apply(f.reviewer.caller, {
      ...input,
      returnTo: 'retry',
    })) as ReviewRequest;
    assert.equal(result.returnTo, 'retry');
    assert.equal(
      await f.state.read(
        async (sql) =>
          (await sql.get<{ state: string }>('SELECT state FROM return_fixture'))!.state,
      ),
      'retry',
    );
  } finally {
    await f.close();
  }
});
