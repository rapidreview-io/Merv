import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Artifact, Caller, Task } from '@merv/contracts';
import { createApp } from '../src/app.js';
import { confirmedDelivery } from './fixtures/task-evidence.js';

const secret = () => `ms_${randomBytes(32).toString('base64url')}`;

test('one agent can produce successive tasks and review other work, but cannot review its own or inherit unpinned outputs', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-continuing-agent-'));
  const app = await createApp({ directory, api: true, port: 0 });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({
    projectName: 'Agent continuity',
    actorName: 'Owner',
  });
  const owner: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const token = secret();
  const agent = await app.ctx.sessions.registerAgent(owner, {
    name: 'Continuing agent',
    runnerId: 'external',
    requestId: 'register',
    secret: token,
  });
  const createTask = async (requestId: string) =>
    await app.ctx.tasks.create(owner, {
      title: requestId,
      goal: 'Verify addition.',
      checks: ['Two plus three equals five.'],
      requestId,
    });
  const assign = async (task: Task, requestId: string) =>
    await app.ctx.sessions.assignAgent(token, {
      instanceId: task.id,
      expectedRevision: task.workflow.revision,
      requestId,
    });
  const first = await createTask('first');
  const a = await assign(first, 'work-first');
  const callerA = await app.ctx.sessions.authenticate(token);
  const proof = (await app.ctx.tools.call('artifact.create', callerA, {
    title: 'Proof',
    content: 'Observed 2 + 3 = 5.',
  })) as Artifact;
  const submitted = (await app.ctx.tools.call(
    'task.submit_delivery',
    callerA,
    confirmedDelivery({
      taskId: first.id,
      expectedRevision: 0,
      artifactIds: [proof.id],
      requestId: 'deliver-first',
    }),
  )) as Task;
  assert.equal(submitted.workflow.state, 'in_review');
  await app.ctx.sessions.releaseAgentAssignment(token, a.id);
  await assert.rejects(async () => await assign(submitted, 'self-review'), {
    code: 'review_independence',
  });
  // What the agent is refused it is not offered: its own delivery's review is not available.
  assert.ok(
    !(await app.ctx.sessions.agentSelf(token)).available.some(
      (item) => item.instanceId === first.id,
    ),
  );
  assert.equal((await app.ctx.sessions.agentSelf(token)).current, null);
  const second = await createTask('second');
  const b = await assign(second, 'work-second');
  const callerB = await app.ctx.sessions.authenticate(token);
  assert.equal(callerB.actorId, callerA.actorId);
  assert.equal(b.agentId, agent.id);
  // It reads the earlier proof like anything else in the project; it did not author it.
  assert.ok(await app.ctx.tools.call('artifact.read', callerB, { artifactId: proof.id }));
  const changingCaller = structuredClone(callerB);
  const outputs = app.ctx.artifacts.authored(changingCaller);
  changingCaller.session!.id = callerA.session!.id;
  assert.deepEqual(await outputs, [], 'Previous execution output is not automatically authorized');
  await app.ctx.sessions.releaseAgentAssignment(token, b.id);
  // Another producer submits separate work. The same agent may now become a reviewer.
  const independent = await createTask('independent');
  const otherProof = await app.ctx.artifacts.create(owner, {
    title: 'Other proof',
    content: 'Independently observed 2 + 3 = 5.',
  });
  const reviewTask = await app.ctx.tasks.submitDelivery(
    owner,
    confirmedDelivery({
      taskId: independent.id,
      expectedRevision: 0,
      artifactIds: [otherProof.id],
      requestId: 'other-delivery',
    }),
  );
  const reviewExecution = await assign(reviewTask, 'review-other');
  const reviewer = await app.ctx.sessions.authenticate(token);
  assert.equal(reviewer.actorId, agent.actorId);
  assert.equal(reviewExecution.role, 'reviewer');
  assert.equal((await app.ctx.scope.require(reviewer, 'review')).role, 'reviewer');
  await assert.rejects(async () => await app.ctx.scope.require(reviewer, 'write'), {
    code: 'forbidden',
  });
  assert.equal(
    (await app.ctx.sessions.agentSelf(token)).assignments.length,
    3,
    'Refused self-review created no execution',
  );
  // A leased reviewer asking whether its submission is ready is answered against the call it
  // would make: reviewId, claimId and expectedRevision are bound to the lease rather than
  // typed, so the question must not come back saying the claim is stale.
  await app.ctx.reviews.start(reviewer, reviewTask.reviewId!);
  const asked = await app.ctx.workflows.evaluate(reviewer, independent.id, {
    action: 'submit_review',
    input: {
      verdict: 'pass',
      notes: 'Checked the delivered proof against the criterion.',
      synopsis: 'The delivered proof observes the sum independently and satisfies the criterion.',
      requestId: 'leased-preflight',
    },
  });
  assert.equal(
    asked.blockers.some((blocker) => blocker.code === 'stale_claim'),
    false,
    'A bound claim is not a stale one',
  );
});
