import type { TaskReview } from '@merv/tasks/types';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Data } from '@merv/contracts';
import { reviewedFindings } from './fixtures/task-evidence.js';
import { currentTaskSuite } from './fixtures/current-task-suite.js';

for (const verdict of ['pass', 'needs_changes', 'fail'] as const) {
  test(`structured current task findings route ${verdict} and retain their exact assessment`, async (t) => {
    const f = await currentTaskSuite(t);
    const pending = await f.submit(await f.delivery(await f.create()));
    const { held, review } = await f.claim(pending);
    const input: Data = {
      ...reviewedFindings(review),
      reviewId: review.id,
      claimId: review.claimId!,
      verdict,
      notes: 'Recomputed the retained positive and negative arithmetic cases independently.',
      evidence: {
        outcome: 'The checked arithmetic behavior is retained.',
        observed: { positive: 5, negative: -1 },
      },
      expectedRevision: pending.workflow.revision,
      requestId: f.work.request(),
    };
    const saved = await f.work.run(held, 'review.submit', input, (caller, bound) =>
      f.app.ctx.tasks.submitReview(caller, bound as unknown as TaskReview),
    );
    assert.equal(
      saved.workflow.state,
      { pass: 'done', needs_changes: 'in_progress', fail: 'failed' }[verdict],
    );
    const assessment = await f.app.ctx.reviews.get(f.owner, review.id);
    assert.deepEqual(assessment.findings, input.findings);
    assert.deepEqual(assessment.evidence, input.evidence);
    assert.equal(assessment.synopsis, input.synopsis);
    if (verdict === 'pass')
      assert.equal(saved.workflow.data.outcome, input.evidence && (input.evidence as Data).outcome);
    await f.work.release(held);
    if (verdict === 'needs_changes') {
      const context = await f.app.ctx.tasks.context(f.owner, {
        taskId: saved.id,
        purpose: 'work',
        expectedRevision: saved.workflow.revision,
        requestId: f.work.request(),
      });
      assert.ok(context.prompt.includes(assessment.snapshotHash));
      assert.ok(context.prompt.includes(assessment.synopsis!));
    }
  });
}

test('current review preflight and commit reject inconsistent findings without changing either service', async (t) => {
  const f = await currentTaskSuite(t);
  const pending = await f.submit(await f.delivery(await f.create()));
  const { held, review } = await f.claim(pending);
  const valid = reviewedFindings(review);
  const findings = valid.findings as Data[];
  const input = {
    ...valid,
    reviewId: review.id,
    claimId: review.claimId!,
    verdict: 'pass',
    notes: 'Checked the retained evidence independently.',
    expectedRevision: pending.workflow.revision,
    requestId: f.work.request(),
  };
  const before = await f.snapshot();
  for (const proposed of [
    { ...input, findings: [] },
    { ...input, findings: [findings[0]] },
    { ...input, findings: [findings[0], findings[0]] },
    { ...input, findings: [{ ...findings[0], status: 'not_verified' }, findings[1]] },
    { ...input, findings: [{ ...findings[0], evidenceIds: ['art_missing'] }, findings[1]] },
    { ...input, synopsis: ' ' },
    { ...input, synopsis: '# Invalid Markdown synopsis' },
  ]) {
    let rejectedCode: string | undefined;
    await assert.rejects(
      f.app.ctx.tasks.submitReview(held.worker, proposed as TaskReview),
      (error: unknown) => {
        rejectedCode = (error as { code?: string }).code;
        return !!rejectedCode;
      },
    );
    const preflight = await f.app.ctx.workflows.evaluate(held.worker, pending.id, {
      action: 'submit_review',
      input: proposed,
    });
    assert.ok(
      preflight.actions
        .find((action) => action.action === 'submit_review')!
        .blockers.some((blocker) => blocker.code === rejectedCode),
    );
    assert.deepEqual(await f.snapshot(), before);
  }
});

test('a leased independent reviewer can explicitly waive a criterion with its recorded reason', async (t) => {
  const f = await currentTaskSuite(t);
  const pending = await f.submit(await f.delivery(await f.create()));
  const { held, review } = await f.claim(pending);
  const evidence = reviewedFindings(review);
  const findings = evidence.findings as Data[];
  findings[1] = {
    criterionNumber: 2,
    status: 'waived',
    evidenceIds: [],
    notes:
      'Negative inputs are explicitly outside the accepted release scope; the positive-input goal holds.',
  };
  const done = await f.work.run(
    held,
    'review.submit',
    {
      ...evidence,
      reviewId: review.id,
      claimId: review.claimId!,
      verdict: 'pass',
      notes: 'Verified the positive-input goal and recorded the scope waiver.',
      expectedRevision: pending.workflow.revision,
      requestId: f.work.request(),
    },
    (caller, bound) => f.app.ctx.tasks.submitReview(caller, bound as unknown as TaskReview),
  );
  assert.equal(done.workflow.state, 'done');
  assert.deepEqual((await f.app.ctx.reviews.get(f.owner, review.id)).findings, findings);
});
