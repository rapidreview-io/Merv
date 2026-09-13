import test from 'node:test';
import assert from 'node:assert/strict';
import type { Task, ReviewRequest } from '@merv/contracts';
import { acceptance, verifyLiveEvidence } from '../scripts/live-evidence.js';

function fixture() {
  const task: Task = {
    ...acceptance,
    id: 'task',
    projectId: 'project',
    producerId: 'producer',
    briefId: 'brief',
    deliveryIds: ['delivery'],
    reviewId: 'review',
    createdAt: 'now',
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
    artifactIds: ['brief', 'delivery'],
    criteria: acceptance.checks,
    snapshotHash: 'hash',
    status: 'submitted',
    reviewerId: 'reviewer',
    verdict: 'pass',
    notes: 'Verified 20 and 5',
    createdAt: 'now',
  };
  const call = (tool: string, args: Record<string, string>) =>
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
  ];
  const transcripts = {
    reviewer: [
      ...reads,
      call('artifact.read', { artifactId: 'brief' }),
      call('review.submit', { reviewId: 'review' }),
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
