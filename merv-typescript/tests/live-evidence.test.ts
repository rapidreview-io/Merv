import test from 'node:test';
import assert from 'node:assert/strict';
import type { Task, ReviewRequest } from '@merv/contracts';
import { acceptance, verifyLiveEvidence } from '../scripts/live-evidence.js';

function fixture() {
  const task: Task = {
    failure: null,
    dependencies: [],
    dependents: [],
    workStarts: [],
    type: 'task.work',
    typeVersion: 1,
    contextInputs: {},
    ...acceptance,
    id: 'task',
    projectId: 'project',
    producerId: 'producer',
    briefId: 'brief',
    evidenceVersion: 2,
    acceptanceChecks: acceptance.checks.map((text, index) => ({ number: index + 1, text })),
    deliveryConfirmations: acceptance.checks.map((_, index) => ({
      checkNumber: index + 1,
      status: 'met',
      evidenceIds: ['delivery'],
      notes: 'Independent calculation is recorded.',
    })),
    deliveryAssessmentId: 'assessment',
    deliveryIds: ['delivery', 'assessment'],
    reviewId: 'review',
    createdAt: 'now',
    guidance: {
      dependencies: [],
      workStart: null,
      instanceId: 'task',
      workflow: 'task',
      version: 1,
      state: 'done',
      revision: 2,
      label: 'Task',
      terminal: true,
      available: true,
      currentGate: 'terminal',
      nextAction: null,
      instruction: 'Finished',
      actions: [],
      blockers: [],
      references: [],
    },
    workflow: {
      id: 'task',
      projectId: 'project',
      workflow: 'task',
      version: 1,
      state: 'done',
      revision: 2,
      data: {},
      createdAt: 'now',
      updatedAt: 'now',
    },
  };
  const review: ReviewRequest = {
    id: 'review',
    projectId: 'project',
    subjectId: 'task',
    subjectRevision: 1,
    producerId: 'producer',
    artifactIds: ['brief', 'delivery', 'assessment'],
    criteria: acceptance.checks,
    formatVersion: 2,
    snapshotHash: 'hash',
    status: 'submitted',
    reviewerId: 'reviewer',
    claimId: 'claim',
    claimGeneration: 1,
    recovery: null,
    verdict: 'pass',
    notes: 'Verified 20 and 5',
    synopsis:
      'Independent arithmetic confirms a sum of twenty and a mean of five for all four values.',
    findings: [
      {
        criterionNumber: 1,
        status: 'met',
        evidenceIds: ['delivery'],
        notes: 'Adding 2, 4, 6, and 8 gives 20.',
      },
      {
        criterionNumber: 2,
        status: 'met',
        evidenceIds: ['delivery'],
        notes: 'Dividing the total of 20 by four values gives 5.',
      },
    ],
    evidence: {},
    createdAt: 'now',
  };
  const call = (tool: string, args: Record<string, unknown>) =>
    JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'mcp_tool_call',
        server: 'merv_typescript',
        tool,
        arguments: args,
        status: 'completed',
        result: { content: [{ type: 'text', text: '{}' }] },
      },
    });
  const reads = [
    call('task.get', { taskId: 'task' }),
    call('review.get', { reviewId: 'review' }),
    call('artifact.read', { artifactId: 'delivery' }),
    call('artifact.read', { artifactId: 'assessment' }),
  ];
  const transcripts = {
    reviewer: [
      ...reads,
      call('artifact.read', { artifactId: 'brief' }),
      call('review.submit', {
        reviewId: 'review',
        verdict: review.verdict,
        synopsis: review.synopsis,
        findings: review.findings,
      }),
    ].join('\n'),
    observer: reads.join('\n'),
  };
  return { task, review, transcripts, call };
}

test('live evidence validates the exact task and every pinned document before the verdict', () => {
  const { task, review, transcripts } = fixture();
  assert.equal(verifyLiveEvidence(task, review, transcripts).reviewerReadAllPinnedEvidence, true);
});

test('live evidence rejects an unrelated task despite successful tool calls', () => {
  const { task, review, transcripts } = fixture();
  assert.throws(() =>
    verifyLiveEvidence({ ...task, goal: 'A different goal' }, review, transcripts),
  );
  assert.throws(() =>
    verifyLiveEvidence(task, review, {
      ...transcripts,
      observer: transcripts.observer.replace('"taskId":"task"', '"taskId":"unrelated"'),
    }),
  );
});

test('live evidence rejects skipped, unrelated, or late reads of pinned evidence', () => {
  const { task, review, transcripts, call } = fixture();
  const withoutBrief = transcripts.reviewer
    .split('\n')
    .filter((line) => !line.includes('"artifactId":"brief"'))
    .join('\n');
  assert.throws(
    () => verifyLiveEvidence(task, review, { ...transcripts, reviewer: withoutBrief }),
    /must read pinned artifact brief/,
  );
  assert.throws(
    () =>
      verifyLiveEvidence(task, review, {
        ...transcripts,
        reviewer: transcripts.reviewer.replace('"artifactId":"brief"', '"artifactId":"unrelated"'),
      }),
    /must read pinned artifact brief/,
  );
  assert.throws(
    () =>
      verifyLiveEvidence(task, review, {
        ...transcripts,
        reviewer: withoutBrief + '\n' + call('artifact.read', { artifactId: 'brief' }),
      }),
    /must read pinned artifact brief/,
  );
});

test('live evidence requires complete reviewer findings citing the checked delivery', () => {
  const { task, review, transcripts } = fixture();
  for (const findings of [
    [],
    review.findings.slice(0, 1),
    review.findings.map((finding) => ({ ...finding, evidenceIds: ['assessment'] })),
    review.findings.map((finding) => ({ ...finding, status: 'not_verified' as const })),
  ]) {
    assert.throws(() => verifyLiveEvidence(task, { ...review, findings }, transcripts));
  }
});

test('live evidence compares actual reviewer submission with retained structured findings', () => {
  const { task, review, transcripts } = fixture();
  const edited = transcripts.reviewer
    .split('\n')
    .map((line) => {
      const event = JSON.parse(line);
      if (event.item.tool === 'review.submit') {
        event.item.arguments.findings[0].notes = 'A different finding was submitted.';
      }
      return JSON.stringify(event);
    })
    .join('\n');
  assert.throws(
    () => verifyLiveEvidence(task, review, { ...transcripts, reviewer: edited }),
    /exact submitted findings must survive/,
  );
});
