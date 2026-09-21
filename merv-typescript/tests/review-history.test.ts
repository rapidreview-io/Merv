import assert from 'node:assert/strict';
import test from 'node:test';
import { REVIEW_HISTORY_LIMITS, reviewHistory, type ReviewRequest } from '@merv/contracts';

const review = (id: string, patch: Partial<ReviewRequest> = {}): ReviewRequest => ({
  id,
  projectId: 'project-1',
  subjectId: 'subject-1',
  subjectRevision: 1,
  producerId: 'actor-producer',
  administrativeActorId: 'actor-admin',
  artifactIds: [],
  excludedActorIds: ['actor-excluded'],
  criteria: ['The result is reproducible', 'The report names its limits'],
  formatVersion: 2,
  snapshotHash: 'hash',
  status: 'submitted',
  reviewerId: 'actor-reviewer',
  claimId: 'claim-1',
  claimGeneration: 1,
  recovery: {
    eventId: 1,
    previousActorId: 'actor-previous',
    previousClaimId: null,
    reason: 'lease lost',
  },
  verdict: 'needs_changes',
  notes: 'Rerun with a fixed seed.',
  synopsis: 'Not reproducible yet.',
  findings: [],
  evidence: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  ...patch,
});

test('review history keeps rejected rounds oldest first, clipped, and free of actor ids', () => {
  const history = reviewHistory(
    [
      {
        review: review('review-1', {
          notes: 'n'.repeat(5000),
          synopsis: 's'.repeat(5000),
          criteria: ['c'.repeat(5000), 'Second'],
          findings: [
            { criterionNumber: 1, status: 'not_met', evidenceIds: ['e1'], notes: 'f'.repeat(5000) },
            { criterionNumber: 2, status: 'met', evidenceIds: [], notes: 'fine' },
            { criterionNumber: 3, status: 'not_verified', evidenceIds: [], notes: 'no criterion' },
            { criterionNumber: 2, status: 'waived', evidenceIds: [], notes: 'waived' },
          ],
        }),
        label: 'design attempt 1 round 1',
      },
      { review: review('review-pass', { verdict: 'pass', subjectRevision: 2 }) },
      { review: review('review-open', { status: 'started', verdict: null, subjectRevision: 3 }) },
      {
        review: review('review-2', {
          verdict: 'fail',
          returnTo: 'reflecting',
          subjectRevision: 4,
          notes: null,
          synopsis: null,
        }),
      },
    ],
    100_000,
  );
  assert.equal(history.omittedRounds, 0);
  assert.deepEqual(
    history.rounds.map(({ round, reviewId, verdict }) => ({ round, reviewId, verdict })),
    [
      { round: 1, reviewId: 'review-1', verdict: 'needs_changes' },
      { round: 2, reviewId: 'review-2', verdict: 'fail' },
    ],
  );
  const [first, second] = history.rounds;
  assert.equal(first.label, 'design attempt 1 round 1');
  assert.equal(first.notes?.length, REVIEW_HISTORY_LIMITS.notes);
  assert.equal(first.synopsis?.length, REVIEW_HISTORY_LIMITS.notes);
  assert.deepEqual(
    first.unmet.map(({ criterionNumber, status }) => ({ criterionNumber, status })),
    [
      { criterionNumber: 1, status: 'not_met' },
      { criterionNumber: 3, status: 'not_verified' },
    ],
  );
  assert.equal(first.unmet[0].criterion.length, REVIEW_HISTORY_LIMITS.criterion);
  assert.equal(first.unmet[0].notes.length, REVIEW_HISTORY_LIMITS.findingNotes);
  assert.equal(first.unmet[1].criterion, '');
  assert.deepEqual(second, {
    round: 2,
    reviewId: 'review-2',
    subjectRevision: 4,
    verdict: 'fail',
    returnTo: 'reflecting',
    synopsis: null,
    unmet: [],
    notes: null,
  });
  assert.equal('label' in second, false);
  assert.doesNotMatch(JSON.stringify(history), /actor-|lease lost|claim-1/);
});

test('review history over budget drops the oldest rounds and always keeps the latest', () => {
  const entries = [1, 2, 3, 4].map((round) => ({
    review: review(`review-${round}`, { subjectRevision: round, notes: 'n'.repeat(700) }),
  }));
  const one = JSON.stringify(reviewHistory(entries.slice(-1), 100_000)).length;
  const history = reviewHistory(entries, one * 2 + 40);
  assert.equal(history.omittedRounds, 2);
  assert.deepEqual(
    history.rounds.map(({ round, reviewId }) => ({ round, reviewId })),
    [
      { round: 3, reviewId: 'review-3' },
      { round: 4, reviewId: 'review-4' },
    ],
  );
  assert.ok(JSON.stringify(history).length <= one * 2 + 40);

  const latestOnly = reviewHistory(entries, 10);
  assert.equal(latestOnly.omittedRounds, 3);
  assert.deepEqual(
    latestOnly.rounds.map(({ reviewId }) => reviewId),
    ['review-4'],
  );
  assert.deepEqual(reviewHistory([], 10), { rounds: [], omittedRounds: 0 });
  assert.deepEqual(reviewHistory(entries, 100_000), reviewHistory(entries, 100_000));
});
