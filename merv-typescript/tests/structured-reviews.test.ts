import { createService } from '@merv/contracts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ArtifactStore } from '@merv/artifacts';
import { DiskBlobs } from '@merv/blobs';
import { type ReviewInput, type ReviewRequest, type ReviewSubmit } from '@merv/contracts';
import { ReviewService } from '@merv/reviews';

import { ProjectScope } from '@merv/scope';
import { ownReviews } from './fixtures/review-verdict.js';
import { openState } from './fixtures/state.js';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'merv-review-findings-'));
  const state = await openState(directory);
  const scope = await createService(new ProjectScope(state));
  const boot = await scope.credentials.bootstrap({
    projectName: 'Structured assessment',
    actorName: 'Operator',
  });
  const operator = { actorId: boot.actor.id, projectId: boot.project.id };
  const issue = async (role: 'producer' | 'reviewer' | 'reader') => ({
    actorId: (await scope.credentials.issueActor(operator, { name: role, role })).actor.id,
    projectId: operator.projectId,
  });
  const producer = await issue('producer'),
    reviewer = await issue('reviewer'),
    reader = await issue('reader');
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const proof = await artifacts.create(producer, {
    title: 'Receipt',
    content: 'Two execution cases passed.',
  });
  const extra = await artifacts.create(producer, {
    title: 'Unsubmitted receipt',
    content: 'Not in the snapshot.',
  });
  const reviews = await createService(new ReviewService(state, scope, artifacts));
  ownReviews(reviews);
  let sequence = 0;
  const input = (): ReviewInput => ({
    subjectId: `subject-${++sequence}`,
    subjectRevision: 2,
    producerId: producer.actorId,
    criteria: ['Adds positive inputs.', 'Handles negative inputs.'],
    artifactIds: [proof.id],
    formatVersion: 2,
    requestId: `request-${sequence}`,
  });
  const request = async () => await reviews.request(producer, input());
  const submit = (review: ReviewRequest): ReviewSubmit => ({
    reviewId: review.id,
    claimId: review.claimId!,
    verdict: 'pass',
    notes: 'Independent evidence inspection is complete.',
    synopsis: 'Both retained execution cases passed and the requested addition goal is achieved.',
    findings: [
      {
        criterionNumber: 2,
        status: 'met',
        evidenceIds: [proof.id],
        notes: ' Negative inputs produced the expected result. ',
      },
      {
        criterionNumber: 1,
        status: 'met',
        evidenceIds: [proof.id],
        notes: 'Positive inputs produced the expected result.',
      },
    ],
    evidence: {
      outcome: 'Adder validated independently.',
      metrics: { passing: 2, total: 2 },
      observations: ['positive', 'negative'],
      accepted: true,
    },
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
    state,
    scope,
    artifacts,
    reviews,
    operator,
    producer,
    reviewer,
    reader,
    proof,
    extra,
    issue,
    input,
    request,
    submit,
    durable,
    async close() {
      await state.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('structured review preflights reject incomplete, contradictory or unpinned findings without durable writes', async () => {
  const f = await fixture();
  try {
    const claimed = await f.reviews.start(f.reviewer, (await f.request()).id);
    const valid = f.submit(claimed);
    const finding = valid.findings![1];
    const wrong = [
      undefined,
      null,
      [],
      [finding],
      [finding, finding],
      [{ ...finding, criterionNumber: 0 }, valid.findings![0]],
      [{ ...finding, criterionNumber: 3 }, valid.findings![0]],
      [{ ...finding, criterionNumber: 1.5 }, valid.findings![0]],
      [{ ...finding, status: 'unknown' }, valid.findings![0]],
      [{ ...finding, evidenceIds: [] }, valid.findings![0]],
      [{ ...finding, evidenceIds: [f.extra.id] }, valid.findings![0]],
      [{ ...finding, evidenceIds: [f.proof.id, f.proof.id] }, valid.findings![0]],
      [{ ...finding, evidenceIds: [42] }, valid.findings![0]],
      [{ ...finding, evidenceIds: 'not-an-array' }, valid.findings![0]],
      [{ ...finding, notes: ' ' }, valid.findings![0]],
      [{ ...finding, notes: 'x'.repeat(16001) }, valid.findings![0]],
      [{ ...finding, unknown: true }, valid.findings![0]],
      [{ ...finding, status: 'not_met', evidenceIds: [] }, valid.findings![0]],
      [{ ...finding, status: 'not_verified', evidenceIds: [] }, valid.findings![0]],
    ];
    const before = await f.durable();
    for (const findings of wrong) {
      const input = { ...valid, findings } as ReviewSubmit;
      await assert.rejects(async () => await f.reviews.checkSubmit(f.reviewer, claimed.id, input), {
        code: 'invalid_findings',
      });
      await assert.rejects(async () => await f.reviews.submit(f.reviewer, input), {
        code: 'invalid_findings',
      });
      assert.deepEqual(await f.durable(), before);
    }
    const other = await f.scope.credentials.bootstrap({
      projectName: 'Other',
      actorName: 'Other operator',
    });
    const foreign = await f.artifacts.create(
      { actorId: other.actor.id, projectId: other.project.id },
      { title: 'Foreign', content: 'Not authorized.' },
    );
    await assert.rejects(
      async () =>
        await f.reviews.submit(f.reviewer, {
          ...valid,
          findings: [{ ...finding, evidenceIds: [foreign.id] }, valid.findings![0]],
        }),
      { code: 'invalid_findings' },
    );
    assert.deepEqual(await f.durable(), before);
  } finally {
    await f.close();
  }
});

test('a pass can waive an ordinary criterion but never a required one, in preflight and in the commit', async () => {
  const f = await fixture();
  try {
    const request = async () =>
      await f.reviews.start(
        f.reviewer,
        (await f.reviews.request(f.producer, { ...f.input(), requiredCriteria: [2] })).id,
      );
    const finding = (input: ReviewSubmit, status: 'waived' | 'not_verified', number: number) => {
      const item = input.findings!.find((entry) => entry.criterionNumber === number)!;
      item.status = status;
      item.evidenceIds = [];
      item.notes = 'The reviewer did not establish this criterion.';
      return input;
    };

    const claimed = await request();
    const waived = finding(f.submit(claimed), 'waived', 2);
    const before = await f.durable();
    await assert.rejects(f.reviews.checkSubmit(f.reviewer, claimed.id, waived), {
      code: 'criterion_not_waivable',
      message: /Criterion 2 is required/,
    });
    await assert.rejects(f.reviews.submit(f.reviewer, waived), {
      code: 'criterion_not_waivable',
    });
    assert.deepEqual(await f.durable(), before, 'A refused pass leaves no verdict behind');
    await assert.rejects(
      f.reviews.submit(f.reviewer, finding(f.submit(claimed), 'not_verified', 2)),
      { code: 'invalid_findings' },
    );
    // The same review still passes when the waived criterion is the ordinary one.
    const passed = await f.reviews.submit(f.reviewer, finding(f.submit(claimed), 'waived', 1));
    assert.equal(passed.verdict, 'pass');
    assert.equal(passed.findings[1].status, 'met');

    const returned = await request();
    const result = await f.reviews.submit(f.reviewer, {
      ...finding(f.submit(returned), 'waived', 2),
      verdict: 'needs_changes',
      synopsis:
        'The required negative case was not established, so the delivery returns for changes.',
    });
    assert.equal(result.verdict, 'needs_changes');
  } finally {
    await f.close();
  }
});
