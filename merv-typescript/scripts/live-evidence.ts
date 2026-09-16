import assert from 'node:assert/strict';
import type { Task, ReviewRequest } from '@merv/contracts';

export const acceptance = {
  title: 'Verify arithmetic evidence',
  goal: 'Verify the sum and mean of 2, 4, 6, 8.',
  checks: ['Sum equals 20', 'Mean equals 5'],
};

/** Validate the actual model transcript, not its closing claim of success. */
export function verifyLiveEvidence(
  task: Task,
  review: ReviewRequest,
  transcripts: { reviewer: string; observer: string },
) {
  assert.equal(task.title, acceptance.title);
  assert.equal(task.goal, acceptance.goal);
  assert.deepEqual(task.checks, acceptance.checks);
  assert.equal(task.evidenceVersion, 2);
  assert.deepEqual(
    task.acceptanceChecks,
    acceptance.checks.map((text, index) => ({ number: index + 1, text })),
  );
  assert.ok(task.deliveryAssessmentId, 'The server must pin a generated assessment');
  assert.equal(task.deliveryIds.at(-1), task.deliveryAssessmentId);
  assert.ok(task.deliveryIds.length >= 2, 'Evidence precedes the generated assessment');
  assert.deepEqual(
    task.deliveryConfirmations.map((confirmation) => confirmation.checkNumber).sort(),
    [1, 2],
  );
  for (const confirmation of task.deliveryConfirmations) {
    assert.equal(confirmation.status, 'met');
    assert.ok(confirmation.notes.trim());
    assert.ok(confirmation.evidenceIds.length > 0);
    assert.ok(
      confirmation.evidenceIds.every((id) => task.deliveryIds.slice(0, -1).includes(id)),
      'Each confirmation cites submitted evidence, not the generated assessment',
    );
  }
  assert.equal(task.workflow.state, 'done');
  assert.equal(task.workflow.revision, 2);
  assert.equal(review.id, task.reviewId);
  assert.equal(review.subjectId, task.id);
  assert.equal(review.producerId, task.producerId);
  assert.ok(review.reviewerId && review.reviewerId !== task.producerId);
  assert.equal(review.verdict, 'pass');
  assert.equal(review.formatVersion, 2);
  assert.ok(review.synopsis && review.synopsis.length >= 40 && review.synopsis.length <= 420);
  assert.deepEqual(
    review.findings.map((finding) => finding.criterionNumber),
    [1, 2],
  );
  for (const finding of review.findings) {
    assert.equal(finding.status, 'met');
    assert.ok(finding.notes.trim(), 'Each retained finding describes the reviewer verification');
    assert.ok(finding.evidenceIds.length > 0);
    assert.ok(
      finding.evidenceIds.every((id) => task.deliveryIds.slice(0, -1).includes(id)),
      'Reviewer findings cite the actual delivery evidence',
    );
  }
  assert.deepEqual(review.criteria, task.checks);
  assert.deepEqual([...review.artifactIds].sort(), [task.briefId, ...task.deliveryIds].sort());
  for (const phase of ['reviewer', 'observer'] as const) {
    const calls = transcripts[phase]
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter(
        (event) =>
          event.type === 'item.completed' &&
          event.item?.type === 'mcp_tool_call' &&
          event.item.server === 'merv_typescript',
      )
      .map((event) => event.item);
    const successful = (call: any) =>
      call.status === 'completed' &&
      !call.error &&
      !(call.result?.content ?? []).some((part: any) => {
        if (part.type !== 'text') return false;
        try {
          return Boolean(JSON.parse(part.text)?.error);
        } catch {
          return false;
        }
      });
    for (const [tool, key, id] of [
      ['task.get', 'taskId', task.id],
      ['review.get', 'reviewId', review.id],
    ] as const) {
      assert.ok(
        calls.some(
          (call) => successful(call) && call.tool === tool && call.arguments?.[key] === id,
        ),
        `${phase} must read the tested ${tool}`,
      );
    }
    const verdictIndex =
      phase === 'reviewer'
        ? calls.findIndex(
            (call) =>
              successful(call) &&
              call.tool === 'review.submit' &&
              call.arguments?.reviewId === review.id,
          )
        : calls.length;
    assert.ok(verdictIndex >= 0, 'Reviewer must submit the tested review');
    if (phase === 'reviewer') {
      const submitted = calls[verdictIndex].arguments;
      assert.equal(submitted.verdict, review.verdict);
      assert.equal(submitted.synopsis?.trim(), review.synopsis);
      assert.ok(Array.isArray(submitted.findings), 'Reviewer must submit structured findings');
      assert.deepEqual(
        submitted.findings
          .map((finding: ReviewRequest['findings'][number]) => ({
            ...finding,
            notes: finding.notes.trim(),
          }))
          .sort(
            (a: ReviewRequest['findings'][number], b: ReviewRequest['findings'][number]) =>
              a.criterionNumber - b.criterionNumber,
          ),
        review.findings,
        'The exact submitted findings must survive persistence and restart',
      );
      assert.deepEqual(submitted.evidence ?? {}, review.evidence);
    }
    const requiredArtifacts = phase === 'reviewer' ? review.artifactIds : task.deliveryIds;
    for (const artifactId of requiredArtifacts) {
      assert.ok(
        calls
          .slice(0, verdictIndex)
          .some(
            (call) =>
              successful(call) &&
              call.tool === 'artifact.read' &&
              call.arguments?.artifactId === artifactId,
          ),
        `${phase} must read pinned artifact ${artifactId} before the verdict`,
      );
    }
  }
  return {
    expectedTask: true,
    structuredAssessmentPinned: true,
    structuredReviewPinned: true,
    independentReviewer: true,
    reviewerReadAllPinnedEvidence: true,
    observerReadRetainedDelivery: true,
  };
}
