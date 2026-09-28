import assert from 'node:assert/strict';
import test from 'node:test';
import { digest } from '@merv/contracts';
import type { WorkflowAssignmentRule, WorkflowCheckContext } from '@merv/contracts';
import { buildAssignment } from '../packages/workflows/src/assignments.js';

const packet = (sources: unknown[]) => {
  const body = {
    projectId: 'project_a',
    actorId: 'actor_reviewer',
    type: 'task.review',
    typeVersion: 5,
    recipeHash: 'b'.repeat(64),
    subject: { id: 'wf_task', revision: 1 },
    prompt: 'Review the retained archive.',
    sources,
    omitted: [],
  };
  return {
    build: async () => ({
      role: 'reviewer',
      label: 'Task: in_review',
      brief: 'Review the retained archive.',
      references: [],
      handoff: { instruction: 'Claim the review.', tools: ['review.start'] },
      execution: { readOnly: true, tools: [] },
      context: { ...body, hash: digest(body) },
    }),
  } as unknown as WorkflowAssignmentRule;
};
const context = {
  caller: { projectId: 'project_a', actorId: 'actor_reviewer' },
  snapshot: { id: 'wf_task', revision: 1 },
} as unknown as WorkflowCheckContext;
const large = {
  id: 'art_large',
  title: 'cities1000.zip',
  mediaType: 'application/zip',
  hash: 'a'.repeat(64),
  size: 11_051_618,
};

// 2026-09-25 prod: every review of a task that retained a large artifact failed its offer with
// "Invalid workflow assignment packet", and blocked each machine the project rented after it.
test('an assignment may pin a large artifact, whose bytes live in object storage', async () => {
  assert.deepEqual((await buildAssignment(packet([large]), context)).context?.sources, [large]);
});

test('an assignment carries each context source by its ID, title, media type, hash and size', async () => {
  const row = {
    ...large,
    projectId: 'project_a',
    createdBy: 'actor_producer',
    objectId: 'obj_rows',
    createdAt: '2026-09-25T23:26:08.778Z',
  };
  await assert.rejects(buildAssignment(packet([row]), context), {
    code: 'invalid_workflow_policy',
  });
  const { title: _title, ...untitled } = large;
  await assert.rejects(buildAssignment(packet([untitled]), context), {
    code: 'invalid_workflow_policy',
  });
});
