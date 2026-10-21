import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonical, newId, now, sha256Hex } from '@merv/contracts';
import { validateDefinition } from '@merv/workflows/definition';
import { validateExecution } from '@merv/workflows/execution-policy';
import {
  ARTIFACT_TASK_WORKFLOW,
  artifactTaskExecution,
  legacyArtifactReviewEligible,
} from '@merv/tasks/legacy-artifact-review';
import { createApp } from './fixtures/app.js';
import { taskActors } from './fixtures/task-actors.js';
import { reviewedFindings } from './fixtures/task-evidence.js';
import { currentWork } from './fixtures/current-work.js';
import { waitForManagedCode } from './fixtures/managed-code.js';
import { gitCutover } from '@merv/code-work/cutover';

test('artifact task recovery keeps the exact published task2 definition and manifests', () => {
  assert.equal(
    sha256Hex(canonical(validateDefinition(ARTIFACT_TASK_WORKFLOW))),
    '2d2e8d5e83a8fae2cd7ffcab5d8eb7c0703ed93911b626f75ad3d80d66f4ea00',
  );
  assert.equal(
    sha256Hex(canonical(validateExecution(artifactTaskExecution('work')))),
    'd039571139579ba671b4037e938fda768988486d919f1664b5ca9fff7aad8117',
  );
  assert.equal(
    sha256Hex(canonical(validateExecution(artifactTaskExecution('review')))),
    '583cf254f26db955f33c2f3fbd51b68444dd43190e5a407af7bea038319d4b10',
  );
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'merv-artifact-review-'));
  const app = await createApp({ directory, api: false });
  const { operator, producer, reviewer } = await taskActors(app, 'Retained artifact review');
  const brief = await app.ctx.artifacts.create(operator, {
    title: 'Brief',
    content: '# Goal\nRetain measured output.\n# Done when\n- Literal output equals42.',
  });
  const evidence = await app.ctx.artifacts.create(producer.caller, {
    title: 'Literal output',
    content: '42',
  });
  const assessment = await app.ctx.artifacts.create(producer.caller, {
    title: 'Assessment',
    content: 'Check1: literal output is42.',
  });
  const id = newId('wf');
  const review = await app.ctx.reviews.request(producer.caller, {
    subjectId: id,
    subjectRevision: 1,
    producerId: producer.caller.actorId,
    artifactIds: [brief.id, evidence.id, assessment.id],
    pinnedInputIds: [brief.id],
    excludedActorIds: [operator.actorId],
    criteria: ['Literal output equals42.'],
    formatVersion: 2,
    requestId: 'historical-review',
  });
  const data = {
    title: 'Retain measured output',
    goal: 'Retain measured output.',
    checks: ['Literal output equals42.'],
    producerId: operator.actorId,
    briefId: brief.id,
    evidenceVersion: 2,
    deliveryIds: [evidence.id, assessment.id],
    deliveryAssessmentId: assessment.id,
    deliveryConfirmations: [
      {
        checkNumber: 1,
        status: 'met',
        evidenceIds: [evidence.id],
        notes: 'Read literal output42.',
      },
    ],
  };
  await app.ctx.state.transaction(async (tx) => {
    await tx.run(
      'INSERT INTO wf_instances(id,project_id,workflow,version,state,revision,data_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      id,
      operator.projectId,
      'task',
      2,
      'in_review',
      1,
      canonical(data),
      now(),
      now(),
    );
    await tx.run(
      'INSERT INTO tasks(id,project_id,title,goal,checks,producer_id,brief_id,delivery_ids,review_id,created_at,type_name,type_version,context_inputs,evidence_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id,
      operator.projectId,
      data.title,
      data.goal,
      canonical(data.checks),
      operator.actorId,
      brief.id,
      canonical(data.deliveryIds),
      review.id,
      now(),
      'task.work',
      2,
      '{}',
      2,
    );
    for (const [revision, action, from, to] of [
      [0, 'start', null, 'in_progress'],
      [1, 'submit_delivery', 'in_progress', 'in_review'],
    ] as const)
      await tx.run(
        'INSERT INTO wf_history(instance_id,project_id,revision,action,actor_id,request_id,from_state,to_state,data_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        id,
        operator.projectId,
        revision,
        action,
        producer.caller.actorId,
        `historical-${revision}`,
        from,
        to,
        '{}',
        now(),
      );
  });
  return {
    directory,
    app,
    operator,
    producer: producer.caller,
    reviewer: reviewer.caller,
    id,
    review,
    data,
    eligible: () =>
      app.ctx.state.read((sql) => legacyArtifactReviewEligible(sql, operator.projectId, id)),
    reviewSnapshot: () =>
      app.ctx.state.read((sql) =>
        sql.get(
          'SELECT subject_id,subject_revision,producer_id,artifact_ids,criteria,manifest,snapshot_hash,format_version,pinned_input_ids,excluded_actor_ids,provenance_json FROM reviews WHERE id=?',
          review.id,
        ),
      ),
    close: async () => {
      await app.stop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('a real independent artifact verdict preserves the review and accepts no Git claim', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const originalSnapshot = await f.reviewSnapshot();
  assert.equal(await f.eligible(), true);
  const cutover = await f.app.ctx.state.read(gitCutover);
  assert.equal(cutover.ready, true);
  assert.deepEqual(
    cutover.retainedArtifactReviews.map((row) => row.id),
    [f.id],
  );
  await assert.rejects(
    f.app.ctx.tasks.create(f.producer, {
      title: 'Cannot create retired work',
      goal: 'No new artifact-only contract.',
      checks: ['Rejected.'],
      type: 'task.work',
      typeVersion: 2,
      requestId: 'deny-retired-creation',
    }),
    { code: 'task_type_unavailable' },
  );
  await assert.rejects(f.app.ctx.reviews.start(f.producer, f.review.id));
  await assert.rejects(f.app.ctx.reviews.start(f.operator, f.review.id));
  await assert.rejects(
    f.app.ctx.tasks.markFailed(f.operator, {
      taskId: f.id,
      expectedRevision: 1,
      reason: 'Not a review verdict',
      requestId: 'deny-close',
    }),
    { code: 'legacy_artifact_review_only' },
  );
  const assignment = await f.app.ctx.workflows.assignment(f.reviewer, f.id);
  assert.ok(assignment);
  const claim = await f.app.ctx.reviews.start(f.reviewer, f.review.id);
  const input = {
    reviewId: claim.id,
    claimId: claim.claimId!,
    expectedRevision: 1,
    verdict: 'pass' as const,
    notes: 'Read the pinned literal42 and verified the criterion.',
    ...reviewedFindings(claim),
    requestId: 'real-pass',
  };
  const task = await f.app.ctx.tasks.submitReview(f.reviewer, input as never);
  assert.equal(task.workflow.version, 2);
  assert.equal(task.workflow.state, 'done');
  assert.deepEqual(
    (await f.app.ctx.tasks.submitReview(f.reviewer, input as never)).workflow,
    task.workflow,
  );
  const after = await f.app.ctx.reviews.get(f.reviewer, claim.id);
  assert.equal(after.snapshotHash, f.review.snapshotHash);
  assert.deepEqual(await f.reviewSnapshot(), originalSnapshot);
  assert.equal(after.subjectRevision, 1);
  assert.deepEqual(task.deliveryIds, f.data.deliveryIds);
  const stored = await f.app.ctx.state.read((sql) =>
    sql.get<{ acceptance_json: string }>(
      'SELECT acceptance_json FROM code_units WHERE project_id=? AND unit_id=?',
      f.operator.projectId,
      f.id,
    ),
  );
  assert.equal(JSON.parse(stored!.acceptance_json).code, null);
  assert.equal(await f.eligible(), false);
});

test('artifact recovery refuses a record that claims Git evidence', async (t) => {
  const f = await fixture();
  t.after(f.close);
  await f.app.ctx.state.transaction((tx) =>
    tx.run(
      'UPDATE wf_instances SET data_json=? WHERE id=?',
      canonical({ ...f.data, deliveryCode: { headOid: 'a'.repeat(40) } }),
      f.id,
    ),
  );
  assert.equal(await f.eligible(), false);
  assert.deepEqual(
    (await f.app.ctx.state.read(gitCutover)).legacyWork.map((row) => row.id),
    [f.id],
  );
  await assert.rejects(f.app.ctx.reviews.start(f.reviewer, f.review.id), {
    code: 'legacy_artifact_review_unavailable',
  });
  const review = await f.app.ctx.reviews.get(f.reviewer, f.review.id);
  assert.equal(review.status, 'requested');
  assert.equal(review.snapshotHash, f.review.snapshotHash);
  await f.app.ctx.state.transaction(async (tx) => {
    await tx.run('UPDATE wf_instances SET data_json=? WHERE id=?', canonical(f.data), f.id);
    await tx.run(
      'INSERT INTO code_workspaces(project_id,unit_id,declared_at) VALUES(?,?,?)',
      f.operator.projectId,
      f.id,
      now(),
    );
  });
  assert.equal(await f.eligible(), false);
  await assert.rejects(f.app.ctx.reviews.start(f.reviewer, f.review.id), {
    code: 'legacy_artifact_review_unavailable',
  });
});

test('preflight verifies the retained artifact execution contract before target initialization', async (t) => {
  const f = await fixture();
  t.after(f.close);
  assert.equal((await f.app.ctx.state.read(gitCutover)).ready, true);
  // Simulate an incompatible retained database, bypassing immutability only inside this
  // isolated test schema. Keep the original fingerprint to catch hash-only verification.
  await f.app.ctx.state.transaction(async (tx) => {
    await tx.run(
      'ALTER TABLE wf_execution_policies DISABLE TRIGGER wf_execution_policies_no_update',
    );
    await tx.run(
      "UPDATE wf_execution_policies SET manifest_json=? WHERE workflow='task' AND version=2 AND state='in_review'",
      canonical({ ...validateExecution(artifactTaskExecution('review')), readOnly: false }),
    );
    await tx.run(
      'ALTER TABLE wf_execution_policies ENABLE TRIGGER wf_execution_policies_no_update',
    );
  });
  assert.equal(await f.eligible(), false);
  const cutover = await f.app.ctx.state.read(gitCutover);
  assert.equal(cutover.ready, false);
  assert.deepEqual(
    cutover.legacyWork.map((row) => row.id),
    [f.id],
  );
  assert.deepEqual(cutover.retainedArtifactReviews, []);
  await assert.rejects(f.app.ctx.reviews.start(f.reviewer, f.review.id), {
    code: 'legacy_artifact_review_unavailable',
  });
});

test('a genuine artifact needs_changes verdict preserves the task and continues under native Git', async (t) => {
  const f = await fixture();
  const issued = await f.app.ctx.scope.credentials.issueActor(f.operator, {
    name: 'Independent runner',
    role: 'operator',
  });
  const source = {
    projectId: f.operator.projectId,
    actorId: issued.actor.id,
    credentialId: issued.credential.id,
  };
  const work = currentWork(f.app.ctx, { directory: f.directory, source });
  t.after(async () => {
    await work.close();
    await f.close();
  });
  const held = await work.lease(await f.app.ctx.tasks.get(source, f.id));
  assert.equal(held.session.execution.policy.workspace, undefined);
  assert.equal(held.session.execution.policy.readOnly, true);
  const claim = await f.app.ctx.reviews.get(held.worker, f.review.id);
  const task = await work.run(
    held,
    'review.submit',
    {
      reviewId: claim.id,
      claimId: claim.claimId!,
      expectedRevision: 1,
      verdict: 'needs_changes',
      notes: 'Retain the command and environment so the output can be reproduced.',
      synopsis: 'The literal output alone does not establish reproducibility.',
      findings: [
        {
          criterionNumber: 1,
          status: 'not_verified',
          evidenceIds: [f.data.deliveryIds[0]!],
          notes: 'Provide the exact reproducible command.',
        },
      ],
      requestId: 'real-revision',
    },
    (caller, input) => f.app.ctx.tasks.submitReview(caller, input as never),
  );
  assert.equal(task.id, f.id);
  assert.equal(task.workflow.version, 46);
  assert.equal(task.workflow.state, 'in_progress');
  assert.equal(task.workflow.revision, 3);
  assert.deepEqual(task.deliveryIds, f.data.deliveryIds);
  const after = await f.app.ctx.reviews.get(f.reviewer, claim.id);
  assert.equal(after.verdict, 'needs_changes');
  assert.equal(after.snapshotHash, f.review.snapshotHash);
  const history = await f.app.ctx.state.read((sql) =>
    sql.all<{ action: string }>(
      'SELECT action FROM wf_history WHERE instance_id=? ORDER BY revision',
      f.id,
    ),
  );
  assert.deepEqual(
    history.slice(0, 3).map((row) => row.action),
    ['start', 'submit_delivery', 'revise'],
  );
  await work.release(held);
  await waitForManagedCode(f.app.ctx.codeWork, f.operator);
  const resumed = await work.lease(task);
  const workspace = resumed.session.execution.policy.workspace;
  assert.ok(workspace && workspace.mode !== 'none');
  assert.equal(workspace.driver, 'code.git.1');
  assert.equal(resumed.session.execution.policy.readOnly, false);
  assert.ok(resumed.session.execution.references.artifacts?.includes(f.data.briefId));
  for (const id of f.data.deliveryIds)
    assert.ok(resumed.session.execution.references.artifacts?.includes(id));
  assert.equal((await f.app.ctx.tasks.get(f.operator, f.id)).typeVersion, 2);
  await work.release(resumed);
});
