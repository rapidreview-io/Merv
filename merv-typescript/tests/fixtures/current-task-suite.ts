import type { Task, TaskDelivery, TaskReview } from '@merv/tasks/types';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '@merv/contracts';
import { createApp } from './app.js';
import { currentTask, currentWork } from './current-work.js';
import { confirmedDelivery, reviewedFindings } from './task-evidence.js';

export async function currentTaskSuite(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-current-task-git-'));
  const app = await createApp({ directory, port: 0 });
  const boot = await app.ctx.scope.bootstrap({
    projectName: 'Current Git tasks',
    actorName: 'Owner',
  });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const issued = await app.ctx.scope.issueActor(owner, {
    name: 'Independent review runner',
    role: 'operator',
  });
  const reviewer: Caller = {
    projectId: owner.projectId,
    actorId: issued.actor.id,
    credentialId: issued.credential.id,
  };
  const work = currentWork(app.ctx, { directory, source: owner });
  t.after(async () => {
    await work.close();
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const create = () =>
    currentTask(app.ctx, owner, {
      title: 'Retain a harness',
      goal: 'Deliver reproducible arithmetic checks.',
      checks: ['Positive inputs work.', 'Negative inputs work.'],
      requestId: work.request(),
    });
  const delivery = async (task: Task) => {
    const held = await work.lease(task);
    const proof = await work.run(
      held,
      'artifact.create',
      { title: 'Execution evidence', content: 'Verified 2+3=5 and -2+1=-1.' },
      (caller, input) => app.ctx.artifacts.create(caller, input as never),
    );
    const commandId = await work.commit(held, { 'checks.txt': '2+3=5\n-2+1=-1\n' });
    const input = confirmedDelivery(
      {
        taskId: task.id,
        expectedRevision: task.workflow.revision,
        artifactIds: [proof.id],
        commandId,
        requestId: work.request(),
      },
      2,
    );
    return { held, proof, input };
  };
  const submit = async (prepared: Awaited<ReturnType<typeof delivery>>) => {
    const pending = await work.run(
      prepared.held,
      'task.submit_delivery',
      prepared.input,
      (caller, input) => app.ctx.tasks.submitDelivery(caller, input as unknown as TaskDelivery),
    );
    await work.release(prepared.held);
    return pending;
  };
  const claim = async (task: Task) => {
    const held = await work.lease(task, reviewer);
    return { held, review: await app.ctx.reviews.get(held.worker, task.reviewId!) };
  };
  const snapshot = async () => {
    await app.ctx.domainEvents.drain();
    return app.ctx.state.read(async (sql) => ({
      tasks: await sql.all('SELECT * FROM tasks ORDER BY id'),
      reviews: await sql.all('SELECT * FROM reviews ORDER BY id'),
      workflows: await sql.all('SELECT * FROM wf_instances ORDER BY id'),
      history: await sql.all('SELECT * FROM wf_history ORDER BY instance_id,revision'),
      artifacts: await sql.all('SELECT * FROM artifacts ORDER BY id'),
      commands: await sql.all('SELECT * FROM task_commands ORDER BY request_id'),
      reviewCommands: await sql.all('SELECT * FROM review_commands ORDER BY request_id'),
      events: await app.ctx.state.events(owner.projectId),
    }));
  };
  return { app, owner, reviewer, work, create, delivery, submit, claim, snapshot };
}
