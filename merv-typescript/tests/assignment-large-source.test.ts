import assert from 'node:assert/strict';
import test from 'node:test';
import { digest } from '@merv/contracts';
import type { WorkflowAssignmentRule, WorkflowCheckContext } from '@merv/contracts';
import { buildAssignment } from '../packages/workflows/src/assignments.js';

// 2026-09-25 prod: every review of a task that retained a large artifact failed its offer with
// "Invalid workflow assignment packet", and blocked each machine the project rented after it.
test('an assignment may pin a large artifact, whose bytes live in object storage', async () => {
  const source = {
    id: 'art_large',
    projectId: 'project_a',
    createdBy: 'actor_producer',
    title: 'cities1000.zip',
    mediaType: 'application/zip',
    hash: 'a'.repeat(64),
    size: 11_051_618,
    objectId: 'obj_rows',
    createdAt: '2026-09-25T23:26:08.778Z',
  };
  const body = {
    projectId: 'project_a',
    actorId: 'actor_reviewer',
    type: 'task.work',
    typeVersion: 1,
    recipeHash: 'b'.repeat(64),
    subject: { id: 'wf_task', revision: 1 },
    prompt: 'Review the retained archive.',
    sources: [source],
    omitted: [],
  };
  const rule = {
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
  const context = {
    caller: { projectId: 'project_a', actorId: 'actor_reviewer' },
    snapshot: { id: 'wf_task', revision: 1 },
  } as unknown as WorkflowCheckContext;
  const packet = await buildAssignment(rule, context);
  assert.equal(packet.context?.sources[0]?.objectId, 'obj_rows');
});
