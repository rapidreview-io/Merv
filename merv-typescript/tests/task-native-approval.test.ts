import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from './fixtures/app.js';
import { currentTask, currentWork } from './fixtures/current-work.js';
import { taskActors } from './fixtures/task-actors.js';
import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';
import { git } from './fixtures/code-store.js';
import type { CodeService } from '@merv/code-work/service';

test('task approval retains the dirty reviewed tree once, then makes it available to a dependent', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-task-native-'));
  const app = await createApp({ directory });
  const actors = await taskActors(app, 'Native approval');
  const source = actors.producer.caller;
  const code = app.ctx.codeWork as CodeService;
  const work = currentWork(app.ctx, { directory, source });
  try {
    const brief = await app.ctx.artifacts.create(source, {
      title: 'Brief',
      content: 'Implement add. Adds numbers. Use add. Uses add.',
    });
    let task = await currentTask(app.ctx, source, {
      title: 'Adder',
      goal: 'Implement add.',
      checks: ['Adds numbers.'],
      briefId: brief.id,
      requestId: work.request(),
    });
    const dependent = await currentTask(app.ctx, source, {
      title: 'Use adder',
      goal: 'Use add.',
      checks: ['Uses add.'],
      briefId: brief.id,
      dependsOn: task.id,
      requestId: work.request(),
    });
    const writer = await work.lease(task);
    const parent = git(writer.workspace.path, ['rev-parse', 'HEAD']);
    writeFileSync(join(writer.workspace.path, 'add.py'), 'def add(a, b): return a + b\n');
    const proof = await app.ctx.artifacts.create(writer.worker, {
      title: 'Evidence',
      content: 'Verified add(2,3)=5.',
    });
    task = await work.run(
      writer,
      'task.submit_delivery',
      confirmedDelivery({
        taskId: task.id,
        expectedRevision: task.workflow.revision,
        artifactIds: [proof.id],
        requestId: work.request(),
      }),
      (caller, input) => app.ctx.tasks.submitDelivery(caller, input as never),
    );
    assert.deepEqual(task.deliveryCode, {
      ref: { kind: 'submission', sessionId: writer.worker.session!.id },
      sessionId: writer.worker.session!.id,
      revision: 0,
    });
    assert.equal(Object.hasOwn(task.deliveryCode!, 'headOid'), false);
    assert.equal(Object.hasOwn(task.deliveryCode!, 'treeOid'), false);
    const call = code.v2!.call.bind(code.v2);
    let lostFreeze = false;
    let freezeCalls = 0;
    code.v2!.call = async (caller, route, body) => {
      const answer = await call(caller, route, body);
      if (route === 'submissions') {
        freezeCalls++;
        if (!lostFreeze) {
          lostFreeze = true;
          throw Object.assign(new Error('lost frozen submission reply'), {
            code: 'control_unavailable',
            status: 0,
          });
        }
      }
      return answer;
    };
    writer.stop();
    await assert.rejects(writer.driver.capture(writer.launch));
    assert.equal(lostFreeze, true);
    assert.equal((await code.unit(source, task.id)).writerState, 'closed');
    await work.release(writer);
    code.v2!.call = call;
    assert.equal(
      freezeCalls,
      2,
      'closed-writer retry replays the frozen receipt without another push',
    );
    assert.equal(
      git(writer.workspace.path, ['rev-parse', 'HEAD']),
      parent,
      'submission made no commit',
    );
    const reviewRunner = await app.ctx.scope.credentials.issueActor(actors.operator, {
      name: 'Independent runner',
      role: 'operator',
    });
    const review = await work.lease(task, {
      projectId: source.projectId,
      actorId: reviewRunner.actor.id,
      credentialId: reviewRunner.credential.id,
    });
    assert.equal(git(review.workspace.path, ['rev-parse', 'HEAD']), parent);
    assert.equal(
      readFileSync(join(review.workspace.path, 'add.py'), 'utf8'),
      'def add(a, b): return a + b\n',
    );
    const tree = git(review.workspace.path, ['write-tree']);
    const storage = app.ctx.codeWork.gitRemote;
    let available = false;
    code.bindSubmissionStorage({
      verifySubmission: (...args) => storage.verifySubmission(...args),
      materializeSubmission: (...args) =>
        available
          ? storage.materializeSubmission(...args)
          : Promise.reject(new Error('temporarily unavailable')),
    });
    const claim = await app.ctx.reviews.get(review.worker, task.reviewId!);
    await work.run(
      review,
      'review.submit',
      {
        ...reviewedFindings(claim),
        reviewId: claim.id,
        claimId: claim.claimId!,
        expectedRevision: task.workflow.revision,
        verdict: 'pass',
        notes: 'Executed add(2,3) and inspected implementation.',
        requestId: work.request(),
      },
      (caller, input) => app.ctx.tasks.submitReview(caller, input as never),
    );
    await work.release(review);
    assert.equal((await app.ctx.codeWork.unit(source, task.id)).acceptance, null);
    await assert.rejects(
      work.lease(await app.ctx.tasks.get(source, dependent.id)),
      (error: unknown) =>
        [
          'dependencies_pending',
          'code_base_pending',
          'code_approval_pending',
          'code_dependency_pending',
        ].includes((error as { code: string }).code),
    );
    // Later local edits cannot leak into the immutable submission.
    writeFileSync(join(writer.workspace.path, 'add.py'), 'raise RuntimeError("later edit")\n');
    available = true;
    await code.submissions.reconcile();
    const acceptance = (await app.ctx.codeWork.unit(source, task.id)).acceptance;
    assert.ok(acceptance?.reference && acceptance.reference !== parent);
    await code.submissions.reconcile();
    assert.deepEqual((await app.ctx.codeWork.unit(source, task.id)).acceptance, acceptance);
    const next = await work.lease(await app.ctx.tasks.get(source, dependent.id));
    assert.equal(git(next.workspace.path, ['rev-parse', 'HEAD']), acceptance.reference);
    assert.equal(git(next.workspace.path, ['rev-parse', 'HEAD^{tree}']), tree);
    assert.equal(git(next.workspace.path, ['rev-list', '--count', `${parent}..HEAD`]), '1');
    assert.equal(
      readFileSync(join(next.workspace.path, 'add.py'), 'utf8'),
      'def add(a, b): return a + b\n',
    );
  } finally {
    await work.close();
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
