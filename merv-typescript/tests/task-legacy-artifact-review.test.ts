import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonical, newId, now } from '@merv/contracts';

import { legacyArtifactReviewEligible } from '@merv/tasks/legacy-artifact-review';
import { createApp } from './fixtures/app.js';
import { taskActors } from './fixtures/task-actors.js';

import { currentWork } from './fixtures/current-work.js';
import { waitForManagedCode } from './fixtures/managed-code.js';

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
