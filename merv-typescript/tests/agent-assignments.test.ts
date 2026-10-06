import type { Task } from '@merv/tasks/types';
import { currentTask, currentWork } from './fixtures/current-work.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executionOutputs, type Artifact, type Caller } from '@merv/contracts';
import { createApp } from './fixtures/app.js';
import { confirmedDelivery } from './fixtures/task-evidence.js';

const secret = () => `ms_${randomBytes(32).toString('base64url')}`;
async function runner(
  app: Awaited<ReturnType<typeof createApp>>,
  source: Caller,
  runnerId = 'external',
) {
  await app.ctx.sessions.dispatch.heartbeatRunner(source, {
    runnerId,
    machine: { hostname: 'fixture', system: 'test', architecture: 'test' },
    platforms: [{ name: 'test', harness: 'codex', enabled: true, parallelism: 4 }],
    capacity: 4,
    capabilities: ['code.v2'],
  });
}

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
  await runner(app, owner);
  const token = secret();
  const agent = await app.ctx.sessions.registerAgent(owner, {
    name: 'Continuing agent',
    runnerId: 'external',
    requestId: 'register',
    secret: token,
  });
  const createTask = async (requestId: string, by = owner) =>
    await currentTask(app.ctx, by, {
      title: requestId,
      goal: 'Verify addition.',
      checks: ['Two plus three equals five.'],
      requestId,
    });
  const work = currentWork(app.ctx, { directory: join(directory, 'work'), source: owner });
  const held = new Map<string, Awaited<ReturnType<typeof work.attach>>>();
  t.after(() => {
    for (const lease of held.values()) lease.driver?.dispose();
  });
  const assign = async (task: Task, requestId: string) => {
    const session = await app.ctx.sessions.assignAgent(token, {
      instanceId: task.id,
      expectedRevision: task.workflow.revision,
      requestId,
    });
    held.set(session.id, await work.attach(session));
    return session;
  };
  const first = await createTask('first');
  const a = await assign(first, 'work-first');
  const callerA = await app.ctx.sessions.authenticate(token);
  const proof = (await app.ctx.tools.call('artifact.create', callerA, {
    title: 'Proof',
    content: 'Observed 2 + 3 = 5.',
  })) as Artifact;
  const producing = held.get(a.id)!;
  producing.worker = callerA;
  const commandId = await work.commit(producing);
  const submitted = (await app.ctx.tools.call(
    'task.submit_delivery',
    callerA,
    confirmedDelivery({
      taskId: first.id,
      expectedRevision: 0,
      artifactIds: [proof.id],
      requestId: 'deliver-first',
      commandId,
    }),
  )) as Task;
  assert.equal(submitted.workflow.state, 'in_review');
  await app.ctx.sessions.releaseAgentAssignment(token, a.id);
  await work.release(producing);
  held.delete(a.id);
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
  const outputs = executionOutputs(app.ctx.artifacts, changingCaller);
  changingCaller.session!.id = callerA.session!.id;
  assert.deepEqual(await outputs, [], 'Previous execution output is not automatically authorized');
  // Scope, inside the listing, refuses a session caller whose actor is another session's worker.
  await assert.rejects(
    executionOutputs(app.ctx.artifacts, { ...callerB, session: { id: 'ses_elsewhere' } }),
    {
      code: 'forbidden',
      status: 403,
      message: 'Worker actors require their live session authority',
    },
  );
  await app.ctx.sessions.releaseAgentAssignment(token, b.id);
  await work.release(held.get(b.id)!);
  held.delete(b.id);
  // Another producer submits separate work. The same agent may now become a reviewer; had its
  // own source delivered it, the agent would be that source's hand and could not.
  const issued = await app.ctx.scope.issueActor(owner, { name: 'Other', role: 'producer' });
  const other: Caller = { ...owner, actorId: issued.actor.id, credentialId: issued.credential.id };
  const independent = await createTask('independent', other);
  const otherLease = await work.lease(independent, other);
  const otherProof = await work.run(
    otherLease,
    'artifact.create',
    { title: 'Other proof', content: 'Independently observed 2 + 3 = 5.' },
    (caller, input) => app.ctx.artifacts.create(caller, input as never),
  );
  const otherCommand = await work.commit(otherLease);
  const reviewTask = await work.run(
    otherLease,
    'task.submit_delivery',
    confirmedDelivery({
      artifactIds: [otherProof.id],
      commandId: otherCommand,
      requestId: 'other-delivery',
    }),
    (caller, input) => app.ctx.tasks.submitDelivery(caller, input as never),
  );
  await work.release(otherLease);
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

test('a format-2 task lease freezes a paper of many multibyte sections within its packet', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-paper-receipt-'));
  const app = await createApp({ directory, api: true, port: 0 });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Paper receipt', actorName: 'Owner' });
  const owner: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  // 300 sections whose text all fits task.work@4's 96,000 characters, but at three bytes a
  // character, with long titles and IDs repeated in each note and ref, whose JSON is near 1 MB.
  for (const kind of ['literature', 'methods', 'results'] as const)
    await app.ctx.paper.patch(owner, {
      kind,
      expectedRevision: 0,
      requestId: `paper-${kind}`,
      changes: Array.from({ length: 100 }, (_, index) => ({
        id: `${kind}-${index}-`.padEnd(150, 'x'),
        title: `${index} ${'節'.repeat(290)}`,
        content: '結果'.repeat(160),
      })),
    });
  const task = await currentTask(app.ctx, owner, {
    title: 'Survey',
    goal: 'Summarize the paper.',
    checks: ['Cites every section it relies on.'],
    requestId: 'create-survey',
  });
  await runner(app, owner);
  const token = secret();
  await app.ctx.sessions.registerAgent(owner, {
    name: 'Paper agent',
    runnerId: 'external',
    requestId: 'register-paper-agent',
    secret: token,
  });
  const session = await app.ctx.sessions.assignAgent(token, {
    instanceId: task.id,
    expectedRevision: task.workflow.revision,
    requestId: 'work-survey',
  });
  const context = session.assignment.context!;
  assert.equal(`${context.type}@${context.typeVersion}`, 'task.work@4');
  const { receipt } = (await app.ctx.state.transaction(
    async (tx) =>
      await tx.get<{ receipt: string }>('SELECT receipt FROM task_leases WHERE task_id=?', task.id),
  ))!;
  assert.ok(Buffer.byteLength(receipt) <= 400 * 1024);
  // The sections that fit are frozen whole, and the rest are named or counted for paper.read.
  const paper = (
    JSON.parse(receipt) as { paper: { sections: unknown[]; left: unknown[]; more: number } }
  ).paper;
  assert.ok(paper.sections.length > 0 && paper.more > 0);
  assert.equal(paper.sections.length + paper.left.length + paper.more, 300);
  assert.ok(context.prompt.includes('\n### paper:literature:current:1:0:literature-0-'));
});

test('an agent route closes a session as what happened to it, and a closed session only once', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-agent-close-'));
  const app = await createApp({ directory, api: true, port: 0 });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Agent close', actorName: 'Owner' });
  const owner: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const createTask = async (requestId: string) =>
    await currentTask(app.ctx, owner, {
      title: requestId,
      goal: 'Verify addition.',
      checks: ['Two plus three equals five.'],
      requestId,
    });
  const stored = async (id: string) => {
    const { status, closeReason, outcome, deferral } = await app.ctx.sessions.get(owner, id);
    return { status, closeReason, outcome, deferral };
  };

  await runner(app, owner, 'hand');
  // The implicit agent of a hand offer is retired once, with its live offer.
  const offered = await app.ctx.sessions.offer(owner, {
    instanceId: (await createTask('offered')).id,
    expectedRevision: 0,
    runnerId: 'hand',
    requestId: 'hand-offer',
    secret: secret(),
  });
  assert.equal((await app.ctx.sessions.retireAgent(owner, offered.agentId!)).status, 'retired');
  assert.deepEqual(await stored(offered.id), {
    status: 'released',
    closeReason: 'agent_retired',
    outcome: 'halted',
    deferral: undefined,
  });

  // A delivered handoff is recorded as that, whichever route closes the session.
  await runner(app, owner);
  const token = secret();
  await app.ctx.sessions.registerAgent(owner, {
    name: 'Continuing agent',
    runnerId: 'external',
    requestId: 'register',
    secret: token,
  });
  const task = await createTask('delivered');
  const execution = await app.ctx.sessions.assignAgent(token, {
    instanceId: task.id,
    expectedRevision: task.workflow.revision,
    requestId: 'work',
  });
  const work = currentWork(app.ctx, { directory: join(directory, 'work'), source: owner });
  const lease = await work.attach(execution);
  const worker = await app.ctx.sessions.authenticate(token);
  const proof = (await app.ctx.tools.call('artifact.create', worker, {
    title: 'Proof',
    content: 'Observed 2 + 3 = 5.',
  })) as Artifact;
  lease.worker = worker;
  const commandId = await work.commit(lease);
  await app.ctx.tools.call(
    'task.submit_delivery',
    worker,
    confirmedDelivery({
      taskId: task.id,
      expectedRevision: 0,
      artifactIds: [proof.id],
      requestId: 'deliver',
      commandId,
    }),
  );
  const closed = await app.ctx.sessions.releaseAgentAssignment(token, execution.id);
  await work.release(lease);
  assert.deepEqual(
    [closed.status, closed.closeReason, closed.outcome],
    ['released', 'handoff', 'completed'],
  );

  // A closed session's release records nothing and echoes no deferral it did not record.
  const control = { sessionId: execution.id, runnerId: 'external' };
  const again = await app.ctx.sessions.release(owner, {
    ...control,
    outcome: 'preparation_deferred',
    deferral: { cause: 'store_busy', code: 'code_store_full' },
  });
  assert.equal(again.deferral, undefined);
  assert.deepEqual(await stored(execution.id), {
    status: 'released',
    closeReason: 'handoff',
    outcome: 'completed',
    deferral: undefined,
  });
  // A completed outcome is still never a release's to claim.
  await assert.rejects(app.ctx.sessions.release(owner, { ...control, outcome: 'completed' }), {
    code: 'invalid_outcome',
    status: 400,
  });
});
