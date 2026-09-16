import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { EnvironmentCredentials } from '../packages/mounts/src/credentials.js';
import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';

test('machine domain writes preserve key provenance, while key withdrawal preserves the owner and review claim', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-key-domain-'));
  const app = await createApp({ directory });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const { scope, state, tasks, artifacts, reviews, workflows, feed } = app.ctx;
  const login = async (subject: string) =>
    await scope.acceptVerifiedIdentity({
      issuer: 'https://identity.example/auth/v1',
      subject,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  const operator = await login('operator'),
    producer = await login('producer'),
    reviewer = await login('reviewer');
  const project = await scope.createProject(operator, {
    name: 'Key attribution',
    requestId: 'project',
  });
  await scope.addMember(operator, project.id, { subject: 'producer', role: 'producer' });
  await scope.addMember(operator, project.id, { subject: 'reviewer', role: 'reviewer' });
  const p = await scope.createKey(producer, { projectId: project.id });
  const r = await scope.createKey(reviewer, { projectId: project.id });
  const producerCaller = await scope.caller({
    kind: 'key',
    key: await scope.authenticateKey(p.token),
  });
  const reviewerCaller = await scope.caller({
    kind: 'key',
    key: await scope.authenticateKey(r.token),
  });
  const head = await state.eventHead();
  const task = await tasks.create(producerCaller, {
    title: 'Evidence',
    goal: 'Verify a result',
    checks: ['The result is verified'],
    requestId: 'task',
  });
  await workflows.begin(producerCaller, {
    instanceId: task.id,
    expectedRevision: task.workflow.revision,
  });
  await tasks.context(producerCaller, {
    taskId: task.id,
    purpose: 'work',
    expectedRevision: task.workflow.revision,
    requestId: 'context',
  });
  await tasks.checkpoint(producerCaller, {
    taskId: task.id,
    purpose: 'work',
    expectedRevision: task.workflow.revision,
    requestId: 'checkpoint',
    notes: 'Verified the fixture result.',
  });
  const delivery = await artifacts.create(producerCaller, {
    title: 'Result',
    content: 'The result is verified.',
  });
  await feed.post(producerCaller, {
    body: 'Result checked.',
    artifactIds: [delivery.id],
    requestId: 'feed',
  });
  const pending = await tasks.submitDelivery(
    producerCaller,
    confirmedDelivery({
      taskId: task.id,
      artifactIds: [delivery.id],
      expectedRevision: 0,
      requestId: 'delivery',
    }),
  );
  const claim = await reviews.start(reviewerCaller, pending.reviewId!);
  await workflows.begin(reviewerCaller, { instanceId: task.id, expectedRevision: 1 });
  const keyEvents = await state.events(project.id, head);
  const expectedActors = new Map([
    [producerCaller.actorId, producerCaller],
    [reviewerCaller.actorId, reviewerCaller],
  ]);
  for (const event of keyEvents) {
    const bound = expectedActors.get(event.actorId);
    assert.ok(bound, `Unexpected actor on ${event.type}: ${event.actorId}`);
    assert.deepEqual(
      event.data.source,
      {
        kind: 'user-key',
        keyId: bound.key!.id,
        membershipId: bound.key!.membershipId,
      },
      event.type,
    );
  }
  for (const type of [
    'artifact.created',
    'task.created',
    'workflow.transition',
    'workflow.work_started',
    'context.built',
    'task.checkpoint_saved',
    'feed.posted',
    'task.delivery_submitted',
    'review.requested',
    'review.started',
  ]) {
    assert.ok(
      keyEvents.some((event) => event.type === type),
      type,
    );
  }
  const before = await state.eventHead();
  await scope.revokeKey(reviewer, r.key.id);
  await assert.rejects(async () => await reviews.checkSubmit(reviewerCaller, claim.id), {
    code: 'forbidden',
  });
  const human = await scope.caller(reviewer, project.id);
  assert.equal((await reviews.get(human, claim.id)).claimId, claim.claimId);
  assert.equal(await scope.eligible(project.id, human.actorId, 'review'), true);
  const done = await tasks.submitReview(human, {
    reviewId: claim.id,
    claimId: claim.claimId!,
    verdict: 'pass',
    notes: 'The owner independently checked the result.',
    ...reviewedFindings(claim),
    expectedRevision: 1,
    requestId: 'verdict',
  });
  assert.equal(done.workflow.state, 'done');
  const humanEvents = (await state.events(project.id, before)).filter(
    (event) => event.type === 'review.submitted',
  );
  assert.equal(humanEvents.length, 1);
  assert.equal(
    humanEvents[0].data.source,
    undefined,
    'Human completion is not misattributed to the revoked key',
  );
  assert.deepEqual(
    (await state.events(project.id)).find((event) => event.type === 'review.started')!.data.source,
    {
      kind: 'user-key',
      keyId: r.key.id,
      membershipId: reviewerCaller.key!.membershipId,
    },
  );
  const rendered = JSON.stringify(await state.events(project.id));
  assert.ok(
    !rendered.includes(p.token) && !rendered.includes(r.token),
    'Audit contains IDs, never bearer secrets',
  );
});

test('known user keys remain excluded from upstream credentials while active and after rotation or revocation', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-key-upstream-'));
  const app = await createApp({ directory });
  const envName = `MERV_TEST_USER_KEY_${randomUUID().replaceAll('-', '_')}`;
  t.after(async () => {
    delete process.env[envName];
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const { scope } = app.ctx;
  const owner = await scope.acceptVerifiedIdentity({
    issuer: 'https://identity.example/auth/v1',
    subject: 'owner',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const project = await scope.createProject(owner, { name: 'Local key', requestId: 'project' });
  const caller = await scope.caller(owner, project.id);
  const root = await scope.createKey(owner, { projectId: project.id });
  const successor = await scope.rotateKey(owner, { keyId: root.key.id });
  await scope.revokeKey(owner, root.key.id);
  const provider = new EnvironmentCredentials(scope, [
    {
      id: 'local-user-key',
      projectId: project.id,
      actorId: caller.actorId,
      mountId: 'sandboxes',
      secretRef: `env:${envName}`,
    },
  ]);
  for (const token of [root.token, successor.token]) {
    process.env[envName] = token;
    await assert.rejects(async () => await provider.resolve(caller, 'sandboxes'), {
      code: 'credential_unavailable',
    });
    assert.equal(await scope.recognizesCredential(token), true);
  }
  const active = await scope.createKey(owner, { projectId: project.id });
  process.env[envName] = active.token;
  await assert.rejects(async () => await provider.resolve(caller, 'sandboxes'), {
    code: 'credential_unavailable',
  });
  process.env[envName] = 'explicitly-configured-upstream-service-token';
  assert.equal(
    (await provider.resolve(caller, 'sandboxes')).headers().authorization,
    'Bearer explicitly-configured-upstream-service-token',
  );
});
