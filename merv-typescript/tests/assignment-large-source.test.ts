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

test('the engine fences a context package by owner, revision, sources and hash, and keeps the rest', async () => {
  const body = {
    projectId: 'project_a',
    actorId: 'actor_reviewer',
    type: 'task.work',
    typeVersion: 2,
    recipeHash: 'b'.repeat(64),
    subject: { id: 'wf_task', revision: 1, focus: 'the archive' },
    prompt: 'Review.',
    sources: [{ id: 'art_a', projectId: 'project_a', lineage: ['art_0'] }],
    omitted: [],
    // A field context-builder adds later.
    budget: { characters: 1000 },
  };
  const packet = (context: unknown) =>
    ({
      build: async () => ({
        role: 'reviewer',
        label: 'Task: in_review',
        brief: 'Review.',
        references: [],
        handoff: { instruction: 'Claim the review.', tools: ['review.start'] },
        execution: { readOnly: true, tools: [] },
        context,
      }),
    }) as unknown as WorkflowAssignmentRule;
  const context = {
    caller: { projectId: 'project_a', actorId: 'actor_reviewer' },
    snapshot: { id: 'wf_task', revision: 1 },
  } as unknown as WorkflowCheckContext;
  const built = await buildAssignment(packet({ ...body, hash: digest(body) }), context);
  assert.deepEqual(built.context, { ...body, hash: digest(body) });
  const foreign = {
    ...body,
    sources: [...body.sources, { id: 'art_b', projectId: 'project_b' }],
  };
  await assert.rejects(buildAssignment(packet({ ...foreign, hash: digest(foreign) }), context), {
    code: 'invalid_workflow_policy',
    status: 500,
  });
  await assert.rejects(buildAssignment(packet({ ...body, hash: digest(foreign) }), context), {
    code: 'invalid_workflow_policy',
  });
});
