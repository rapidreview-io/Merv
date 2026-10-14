import { requireDependencies } from '@merv/workflows/rules';
import { limitMarks } from '@merv/workflows/ui';
import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Caller } from '@merv/contracts';
import { sourceCaller } from '@merv/scope/rules';
import type { CodeCapture } from '@merv/code-work/types';
import type { SandboxCheckHandle } from '@merv/code-work/check-types';
import { enqueueMirror, CodeMirrorService } from '@merv/code/store/mirror';
import { CodeBaseService } from '../packages/code-work/src/bases.js';
import { personMove } from '../packages/code-work/src/blockers.js';
import { git } from './fixtures/code-store.js';
import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';
import { assessment as reviewAssessment } from './fixtures/review-verdict.js';
import { baseResolutionFixture as fixture } from './fixtures/base-resolution.js';

test('Code refuses acceptance when another unit accepts a member commit after the review was pinned', async (t) => {
  const f = await fixture(t);
  await f.waiter();
  await f.bases.work(f.admin.projectId);
  const taskId = (await f.record())!.resolutionTaskId!;
  const commit = await f.resolveCommit();
  await f.admission(taskId, commit, 'admitted');
  const request = await f.requestReview(taskId, 0);
  const claim = await f.reviews.start(f.admin, request.id);
  await f.input('Another unit with the same commit', f.a, f.admin);
  await f.reviews.submit(f.admin, {
    reviewId: request.id,
    claimId: claim.claimId!,
    verdict: 'pass',
    notes: 'Checked',
    ...reviewAssessment(claim),
    requestId: 'wrong-pass',
  });
  assert.deepEqual((await f.reviews.get(f.admin, request.id)).provenance, request.provenance);
  await f.state.transaction(async (tx) => {
    await tx.run("UPDATE wf_instances SET state='done',revision=1 WHERE id=?", taskId);
  });
  const work = await f.workflows.get(f.admin, taskId);
  await assert.rejects(f.accept(work, commit, request.id), {
    code: 'code_provenance_unverifiable',
  });
  assert.equal((await f.code.unit(f.admin, taskId)).acceptance, null);
  assert.equal((await f.record())!.state, 'awaiting_resolution');
});

test('frozen-plan provenance excludes indirect authors, authorities and every earlier resolution round', async (t) => {
  const f = await fixture(t);
  const issue = async (name: string) => ({
    projectId: f.admin.projectId,
    actorId: (await f.scope.credentials.issueActor(f.admin, { name, role: 'operator' })).actor.id,
  });
  const indirect = await issue('Indirect input writer');
  const authority = await issue('Directing authority');
  const earlier = await issue('Earlier resolution writer');
  await f.producingSession(f.extra.id, indirect.actorId, authority.actorId);
  await f.waiter([f.left, f.extra]);
  await f.bases.work(f.admin.projectId);
  f.source.git('checkout', '--detach', f.d);
  const e = f.source.commit({ 'h.txt': 'E' });
  f.source.git(
    'push',
    f.repositories.paths(f.admin.projectId).repository,
    `${e}:refs/heads/fourth`,
  );
  const fourth = await f.input('Fourth input', e);
  await f.waiter([f.left, f.extra, fourth]);
  await f.bases.work(f.admin.projectId);
  await f.waiter([f.left, f.right, f.extra, fourth]);
  await f.bases.work(f.admin.projectId);
  const base = (await f.state.read((sql) =>
    f.bases.find(sql, f.admin.projectId, [f.a, f.c, f.d, e]),
  ))!;
  const path = await f.state.read((sql) => f.bases.path(sql, f.admin.projectId, base.key));
  assert.equal(path.length, 3, 'the indirect input is two frozen plan steps below the root');
  const taskId = base.resolutionTaskId!;
  await f.producingSession(taskId, earlier.actorId, authority.actorId);
  const request = await f.requestReview(taskId, 1, await issue('Current resolution writer'));
  assert.deepEqual(
    request.provenance,
    await f.state.transaction((tx) => f.units.reviewProvenance(f.admin.projectId, taskId, tx)),
  );
  for (const caller of [f.inputAuthor, indirect, authority, earlier]) {
    await assert.rejects(f.reviews.start(caller, request.id), { code: 'review_independence' });
    assert.equal(
      (await f.reviews.list(caller)).find((item) => item.id === request.id)!.claimable,
      false,
    );
  }
  const claim = await f.reviews.start(f.admin, request.id);
  const verdict = {
    reviewId: request.id,
    claimId: claim.claimId!,
    verdict: 'pass' as const,
    notes: 'Checked.',
    ...reviewAssessment(claim),
    requestId: 'pass',
  };
  assert.equal((await f.reviews.submit(f.admin, verdict)).verdict, 'pass');
  assert.equal(
    (await f.reviews.submit(f.admin, verdict)).provenance?.hash,
    request.provenance?.hash,
  );
});

test('every reviewer excluded is visible on the resolution task and pinned reviews survive Code unload', async (t) => {
  const f = await fixture(t);
  await f.waiter();
  await f.bases.work(f.admin.projectId);
  const taskId = (await f.record())!.resolutionTaskId!;
  await f.producingSession(taskId, f.admin.actorId);
  const request = await f.requestReview(taskId);
  await f.state.transaction(async (tx) => {
    await tx.run("UPDATE wf_instances SET state='in_review',revision=1 WHERE id=?", taskId);
    await tx.run('UPDATE tasks SET review_id=? WHERE id=?', request.id, taskId);
  });
  assert.match(
    (await f.reviews.get(f.admin, request.id)).waiting!,
    /Every eligible reviewer.*contributor or directing authority/,
  );
  assert.match(
    JSON.stringify(await f.workflows.evaluate(f.admin, taskId)),
    /Every eligible reviewer/,
  );
  // Closing Code Work withdraws the provenance it registered with Reviews.
  f.unbind();
  await f.code.close();
  await assert.rejects(f.reviews.start(f.admin, request.id), { code: 'review_independence' });
  // What follows is the Reviews protocol alone: as the task's own review, only a leased worker
  // could claim it.
  await f.state.transaction((tx) =>
    tx.run('UPDATE tasks SET review_id=NULL WHERE id=?', taskId).then(() => undefined),
  );
  const independent = {
    projectId: f.admin.projectId,
    actorId: (
      await f.scope.credentials.issueActor(f.admin, { name: 'Independent', role: 'reviewer' })
    ).actor.id,
  };
  const certifiedClaim = await f.reviews.start(independent, request.id);
  assert.equal(
    (
      await f.reviews.submit(independent, {
        reviewId: request.id,
        claimId: certifiedClaim.claimId!,
        verdict: 'pass',
        notes: 'Checked',
        ...reviewAssessment(certifiedClaim),
        requestId: 'certified-pass',
      })
    ).verdict,
    'pass',
  );
});

test('a resolution title names the contributing work on an intermediate union with bounded sides', async (t) => {
  const f = await fixture(t);
  await f.waiter([f.left, f.extra]);
  await f.bases.work(f.admin.projectId);
  await f.input('Prepare the dataset '.repeat(10), f.a);
  await f.input('Prepare the dataset '.repeat(10), f.a);
  const waiter = await f.waiter([f.left, f.right, f.extra]);
  await f.bases.work(f.admin.projectId);
  const base = (await f.state.read((sql) =>
    f.bases.find(sql, f.admin.projectId, [f.a, f.c, f.d]),
  ))!;
  assert.equal(base.state, 'awaiting_resolution');
  const task = await f.tasks.get(f.admin, base.resolutionTaskId!);
  assert.match(task.title, /^Merge ‘.+’(?: and 3 more)? with ‘.+’(?: and 3 more)?$/);
  assert.match(task.title, /and 3 more/);
  assert.ok(task.title.length <= 200);
  assert.ok(task.goal.includes('Prepare the dataset'));
  // Contributing work is named by its generic name and id; its domain data is never read.
  assert.match(task.goal, /\bD \(wf_/);
  assert.ok(!task.goal.includes('Implement'));
  assert.deepEqual(
    (await f.workflows.prerequisites(f.admin, [waiter.id]))
      .get(waiter.id)!
      .filter((edge) => edge.kind === 'system')
      .map((edge) => edge.id),
    [task.id],
  );
});

test('an open conflict and unchanged reconciles queue no work or prerequisite writes', async (t) => {
  const f = await fixture(t);
  let replaced = 0;
  const provide = f.workflows.systemPrerequisites.bind(f.workflows);
  t.mock.method(f.workflows, 'systemPrerequisites', (provider: string) => {
    const capability = provide(provider);
    return {
      replace: (...args: Parameters<typeof capability.replace>) => {
        replaced++;
        return capability.replace(...args);
      },
    };
  });
  const count = () => replaced;
  const ordinary = await f.waiter([f.left]);
  for (let i = 0; i < 3; i++) await f.code.reconcileAll();
  assert.equal(count(), 0);
  await f.waiter();
  await f.bases.work(f.admin.projectId);
  assert.deepEqual(await f.bases.due(), []);
  const receipts = count();
  assert.equal(receipts, 1);
  for (let i = 0; i < 4; i++) {
    await f.state.transaction((tx) =>
      tx.run('UPDATE wf_instances SET revision=revision+1 WHERE id=?', ordinary.id),
    );
    await f.code.reconcileAll();
    assert.deepEqual(await f.bases.due(), []);
  }
  assert.equal(count(), receipts);
});

test('accepted resolution verification runs outside transactions and recovers after creating its ref', async (t) => {
  const f = await fixture(t);
  t.mock.method(f.bases, 'soon', () => {});
  await f.waiter();
  await f.bases.work(f.admin.projectId);
  const commit = await f.resolveCommit();
  const run = f.repositories.git.run.bind(f.repositories.git);
  let crash = true;
  t.mock.method(f.repositories.git, 'run', async (...args: Parameters<typeof run>) => {
    const result = await run(...args);
    if (args[0][0] === 'update-ref' && crash) {
      crash = false;
      throw new Error('Crash after resolution ref');
    }
    return result;
  });
  // A seal that cannot finish leaves the acceptance for the next drain and says why,
  // rather than escaping the drain and stopping every other merge in the project.
  await f.acceptResolution(commit);
  assert.equal((await f.record())!.state, 'awaiting_resolution');
  assert.match((await f.record())!.blocker!, /Crash after resolution ref/);
  assert.deepEqual(await f.bases.due(), [f.admin.projectId]);
  await assert.rejects(
    f.state.transaction((tx) =>
      tx.run(
        'UPDATE code_bases SET resolution_commit=? WHERE project_id=?',
        f.a,
        f.admin.projectId,
      ),
    ),
  );
  await f.bases.close();
  const restarted = new CodeBaseService(f.state, f.repositories, {
    changed: (tx, projectId) => f.units.changed(tx, projectId),
    sponsors: (tx, projectId) => f.units.baseSponsors(tx, projectId),
    serviceWork: f.sessions.serviceWork,
    resolved: (tx, id, key, commit) => enqueueMirror(tx, id, 'mirror-base', key, commit),
  });
  await restarted.initialize();
  f.beforeClose.push(() => restarted.close());
  f.units.bases = restarted;
  await restarted.work(f.admin.projectId);
  assert.equal((await f.record())!.result?.commit, commit);
  assert.equal((await f.record())!.blocker, null);
  assert.deepEqual(await restarted.due(), []);
});

test('Git failing to read a resolution lineage is not a verdict on the resolution', async (t) => {
  const f = await fixture(t);
  t.mock.method(f.bases, 'soon', () => {});
  await f.waiter();
  await f.bases.work(f.admin.projectId);
  const base = (await f.record())!;
  const commit = await f.resolveCommit();
  const run = f.repositories.git.run.bind(f.repositories.git);
  let failing = true;
  t.mock.method(f.repositories.git, 'run', async (...args: Parameters<typeof run>) =>
    failing && args[0][0] === 'rev-list'
      ? { code: 128, stdout: Buffer.alloc(0), stderr: 'fatal: unable to read the object store' }
      : await run(...args),
  );
  await f.state.transaction((tx) => f.bases.recordAcceptance(tx, f.admin.projectId, base, commit));
  await f.bases.work(f.admin.projectId);
  const stuck = (await f.record())!;
  assert.equal(stuck.resolutionError, null);
  assert.equal(stuck.state, 'awaiting_resolution');
  assert.match(stuck.blocker!, /lineage could not be read/);
  assert.deepEqual(await f.bases.due(), [f.admin.projectId]);
  failing = false;
  await f.bases.work(f.admin.projectId);
  const sealed = (await f.record())!;
  assert.equal(sealed.result?.commit, commit);
  assert.equal(sealed.blocker, null);
  assert.deepEqual(await f.bases.due(), []);
});

test('Code unload preserves existing blockers and refuses new work', async (t) => {
  const f = await fixture(t);
  const waiter = await f.waiter();
  await f.bases.work(f.admin.projectId);
  const id = (await f.record())!.resolutionTaskId!;
  const blockers = await f.workflows.blockers(f.admin, waiter.id);
  await f.unsubscribe();
  f.unbind();
  await f.bases.close();
  await f.code.close();
  const decision = await f.workflows.evaluate(f.admin, waiter.id);
  assert.ok(
    decision.dependencies.some((edge) => edge.id === id && edge.kind === 'system' && !edge.settled),
  );
  assert.deepEqual(await f.workflows.blockers(f.admin, waiter.id), blockers);
  assert.ok(
    decision.providerBlockers.some((blocker) => blocker.related.some((record) => record.id === id)),
  );
  assert.ok(
    (await f.sessions.dispatch.stuck(f.admin)).items.some((item) => item.instanceId === waiter.id),
  );
  await assert.rejects(
    async () =>
      requireDependencies((await f.workflows.prerequisites(f.admin, [waiter.id])).get(waiter.id)!),
    {
      code: 'dependencies_pending',
    },
  );
  await assert.rejects(
    f.tasks.create(f.admin, {
      title: 'Note',
      goal: 'Write a note.',
      checks: ['The note exists.'],
      requestId: 'unloaded-note',
    }),
    { code: 'code_unavailable' },
  );
});
test('one resolution task serves concurrent, indirect, and future waiters', async (t) => {
  const f = await fixture(t);
  const waiters = await Promise.all([f.waiter(), f.waiter(), f.waiter()]);
  await Promise.all([
    f.bases.work(f.admin.projectId),
    f.bases.work(f.admin.projectId),
    f.code.reconcileAll(),
  ]);
  const base = (await f.record())!;
  assert.equal(base.state, 'awaiting_resolution');
  assert.ok(base.resolutionTaskId);
  const task = await f.tasks.get(f.admin, base.resolutionTaskId);
  assert.equal(task.workflow.version, 45);
  assert.match(task.title, /^Merge ‘[AC]’ with ‘[AC]’$/);
  assert.ok(!task.title.includes(base.key.slice(0, 12)));
  assert.match(task.goal, /\bA \(wf_/);
  assert.match(task.goal, /\bC \(wf_/);
  assert.match(task.goal, /f.txt/);
  const [left] = await f.state.read((sql) => f.bases.inputs(sql, f.admin.projectId, base));
  const status = await f.state.transaction((tx) => f.code.baseStatus(f.admin, task.id, tx));
  assert.equal(status.status, 'ready');
  const superset = await f.waiter([f.left, f.right, f.extra]);
  for (const waiter of [...waiters, superset]) {
    const edges = (await f.workflows.prerequisites(f.admin, [waiter.id])).get(waiter.id)!;
    assert.deepEqual(
      edges.filter((edge) => edge.kind === 'system').map((edge) => edge.id),
      [task.id],
    );
    await assert.rejects(
      async () =>
        requireDependencies(
          (await f.workflows.prerequisites(f.admin, [waiter.id])).get(waiter.id)!,
        ),
      {
        code: 'dependencies_pending',
      },
    );
    const blockers = await f.workflows.blockers(f.admin, waiter.id);
    assert.ok(
      blockers.some(
        (blocker) =>
          blocker.related.some((record) => record.id === task.id) &&
          blocker.message.includes('in_progress'),
      ),
    );
  }
  const stuck = await f.sessions.dispatch.stuck(f.admin);
  assert.ok(
    stuck.items.some((item) => item.instanceId === waiters[0].id && item.why.includes(task.id)),
  );
  for (let i = 0; i < 3; i++) await f.code.reconcileAll();
  assert.equal(
    (await f.tasks.list(f.admin)).filter((item) => item.workflow.version === 45).length,
    1,
  );
  const pin = await f.state.transaction((tx) =>
    f.code.pinBase(f.admin, { unitId: task.id, leaseId: 'resolution-pin', writer: false }, tx),
  );
  assert.equal(pin.reference, left);
  const resolved = await f.resolveCommit();
  await f.acceptResolution(resolved);
  assert.equal((await f.record())!.result?.method, 'task');
  assert.equal((await f.record())!.result?.commit, resolved);
  const future = await f.waiter();
  for (const waiter of [...waiters, future]) {
    requireDependencies((await f.workflows.prerequisites(f.admin, [waiter.id])).get(waiter.id)!);
    const pinned = await f.state.transaction((tx) =>
      f.code.pinBase(f.admin, { unitId: waiter.id, leaseId: waiter.id, writer: false }, tx),
    );
    assert.equal(pinned.reference, resolved);
    assert.equal(pinned.kind, 'merged');
    assert.deepEqual(
      pinned.sources.map((item) => item.unitId).sort(),
      [f.left.id, f.right.id].sort(),
    );
    assert.equal(
      (await f.workflows.prerequisites(f.admin, [waiter.id]))
        .get(waiter.id)!
        .filter((edge) => edge.kind === 'system').length,
      1,
    );
  }
  const combined = await f.state.transaction((tx) =>
    f.code.pinBase(f.admin, { unitId: superset.id, leaseId: superset.id, writer: false }, tx),
  );
  for (const input of [resolved, f.d])
    assert.equal(
      (
        await f.repositories.git.run(['merge-base', '--is-ancestor', input, combined.reference], {
          env: f.repositories.environment(f.admin.projectId),
        })
      ).code,
      0,
    );
  assert.equal(
    (await f.tasks.list(f.admin)).filter((item) => item.workflow.version === 45).length,
    1,
  );
});

test('conflict recovery creates and links the task atomically', async (t) => {
  const f = await fixture(t);
  const provider = f.units.resolutionTasks!;
  f.units.resolutionTasks = undefined;
  const waiter = await f.waiter();
  await f.bases.work(f.admin.projectId);
  assert.equal((await f.record())!.state, 'awaiting_resolution');
  assert.equal((await f.record())!.resolutionTaskId, null);
  let crashed = 0;
  f.units.resolutionTasks = {
    resume: provider.resume,
    create: async (input, tx) => {
      await provider.create(input, tx);
      crashed += 1;
      throw new Error('Crash before linkage');
    },
  };
  // A project that cannot be reconciled is left for the next pass; the pass itself goes on.
  await f.code.reconcileAll();
  assert.equal(crashed, 1);
  assert.equal(
    (await f.tasks.list(f.admin)).filter((item) => item.workflow.version === 45).length,
    0,
  );
  assert.equal((await f.record())!.resolutionTaskId, null);
  f.units.resolutionTasks = provider;
  await Promise.all([
    f.code.reconcileAll(),
    f.code.reconcileAll(),
    f.bases.work(f.admin.projectId),
  ]);
  const record = (await f.record())!;
  assert.ok(record.resolutionTaskId);
  assert.equal(
    (await f.tasks.list(f.admin)).filter((item) => item.workflow.version === 45).length,
    1,
  );
  assert.equal(
    (await f.workflows.prerequisites(f.admin, [waiter.id]))
      .get(waiter.id)!
      .filter((item) => item.kind === 'system')[0].id,
    record.resolutionTaskId,
  );
  await assert.rejects(
    f.state.transaction((tx) =>
      tx.run(
        'UPDATE code_bases SET resolution_task_id=? WHERE project_id=? AND base_key=?',
        'replacement',
        f.admin.projectId,
        record.key,
      ),
    ),
  );
});

test('a service task derives its base from prerequisites when it names no commit', async (t) => {
  const f = await fixture(t);
  const provider = f.tasks.serviceTasks('code');
  const brief = {
    projectId: f.admin.projectId,
    title: 'Consolidate',
    goal: 'Consolidate the accepted work.',
    checks: ['The result builds.'],
  };
  const { id } = await f.state.transaction((tx) =>
    provider.create({ ...brief, requestId: 'derived', dependsOn: [f.left.id, f.extra.id] }, tx),
  );
  const task = await f.tasks.get(f.admin, id);
  assert.equal(task.workflow.version, 45);
  assert.deepEqual(task.dependencies.map((edge) => edge.id).sort(), [f.left.id, f.extra.id].sort());
  await f.bases.work(f.admin.projectId);
  const status = (await f.code.unit(f.admin, id)).baseStatus;
  assert.equal(status?.status, 'ready');
  if (status?.status === 'ready') {
    assert.equal(status.kind, 'merged');
    assert.deepEqual(status.sources, [f.left.id, f.extra.id].sort());
    assert.deepEqual(status.merge?.sort(), [f.a, f.d].sort());
  }
  for (const [requestId, base] of Object.entries({
    neither: {},
    both: { baseReference: f.a, dependsOn: [f.left.id] },
  }))
    await assert.rejects(
      f.state.transaction((tx) => provider.create({ ...brief, requestId, ...base } as never, tx)),
      { code: 'invalid_base' },
    );
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Research's own capability, not a stand-in: the producer is the research service actor. */
const consolidation = (f: Fixture, dependsOn: string[]) =>
  f.state.transaction(async (tx) => {
    const task = await f.tasks.serviceTasks('research').create(
      {
        projectId: f.admin.projectId,
        requestId: 'consolidation',
        title: 'Cycle: consolidation',
        goal: 'Integrate the accepted work main lacks and publish it.',
        checks: ['Every experiment is kept, adapted or dropped.'],
        dependsOn,
      },
      tx,
    );
    await f.code.publishOnAcceptance(f.admin, { unitId: task.id }, tx);
    return task.id;
  });

/** A runner leases the task, and its worker delivers the base the task was given. */
async function deliver(f: Fixture, taskId: string) {
  const identity = await f.scope.credentials.issueActor(f.admin, {
    name: 'Runner',
    role: 'operator',
  });
  const runner = {
    projectId: f.admin.projectId,
    actorId: identity.actor.id,
    credentialId: identity.credential.id,
  };
  await f.sessions.dispatch.heartbeatRunner(runner, {
    runnerId: 'runner',
    machine: { hostname: 'runner', system: 'test', architecture: 'test' },
    platforms: [{ name: 'codex', harness: 'codex', enabled: true, parallelism: 1 }],
    capacity: 1,
    capabilities: ['code.v2'],
  });
  const task = await f.tasks.get(f.admin, taskId);
  const secret = `ms_${randomBytes(32).toString('base64url')}`;
  const session = await f.sessions.offer(runner, {
    instanceId: taskId,
    expectedRevision: task.workflow.revision,
    runnerId: 'runner',
    requestId: 'produce',
    secret,
  });
  // Conflict resolution is service work: Sandboxes attaches no compute to it.
  assert.equal(session.execution.references.computeProfile, 'none');
  const base = (await f.state.transaction((tx) => f.code.basePin(f.admin, taskId, tx)))!.reference;
  const workspace = {
    repositoryId: 'repository',
    workspaceId: taskId,
    mode: 'persistent' as const,
    branch: 'merv/consolidation',
    baseOid: base,
    headOid: base,
    stats: { commitCount: 1, filesChanged: 1, insertions: 1, deletions: 1 },
  };
  await f.sessions.attach(runner, {
    sessionId: session.id,
    runnerId: 'runner',
    hostRef: 'produce',
    workspace,
  });
  const worker = await f.sessions.authenticate(secret);
  f.captures.set('consolidated', {
    ref: { kind: 'code-commit', commandId: 'consolidated' },
    status: 'ready',
    provenance: {
      projectId: f.admin.projectId,
      instanceId: taskId,
      sessionId: session.id,
      actorId: worker.actorId,
      revision: task.workflow.revision,
      workflow: { name: 'task', version: 11, state: 'in_progress' },
      readOnly: false,
    } as CodeCapture['provenance'],
    workspace,
    observedAt: 'now',
    eventId: null,
  });
  const delivery = confirmedDelivery(
    {
      taskId,
      expectedRevision: task.workflow.revision,
      requestId: 'deliver',
      commandId: 'consolidated',
      artifactIds: [],
    },
    task.checks.length,
  );
  const submitted = await f.sessions.invocations.run(
    await f.sessions.invocations.prepare(worker, 'task.submit_delivery', delivery),
    (caller) => f.tasks.submitDelivery(caller, delivery),
  );
  return { runner, session, worker, base, submitted };
}

test('a research consolidation is delivered, and no contributor or directing authority reviews it', async (t) => {
  const f = await fixture(t);
  const taskId = await consolidation(f, [f.left.id, f.extra.id]);
  await f.bases.work(f.admin.projectId);
  const { runner, session, worker, submitted } = await deliver(f, taskId);
  assert.equal(submitted.workflow.state, 'in_review');
  const review = await f.reviews.get(f.admin, submitted.reviewId!);
  for (const actorId of [f.inputAuthor.actorId, runner.actorId, worker.actorId])
    assert.ok(review.provenance?.excludedActorIds.includes(actorId));
  // The authority that directed the delivery, and the author of integrated work, are refused.
  for (const caller of [runner, f.inputAuthor])
    await assert.rejects(f.reviews.start(caller, review.id), { code: 'review_independence' });
  await f.sessions.release(runner, { sessionId: session.id, runnerId: 'runner' });
  // A worker the same authority directs is refused too; one directed by anyone else is not.
  const offerReview = (by: Caller, runnerId: string) =>
    f.sessions.offer(by, {
      instanceId: taskId,
      expectedRevision: submitted.workflow.revision,
      runnerId,
      requestId: `review-${runnerId}`,
      secret: `ms_${randomBytes(32).toString('base64url')}`,
    });
  await assert.rejects(offerReview(runner, 'runner'), { code: 'review_independence' });
  const other = await f.scope.credentials.issueActor(f.admin, {
    name: 'Other runner',
    role: 'operator',
  });
  const independent = {
    projectId: f.admin.projectId,
    actorId: other.actor.id,
    credentialId: other.credential.id,
  };
  await f.sessions.dispatch.heartbeatRunner(independent, {
    runnerId: 'other',
    machine: { hostname: 'other', system: 'test', architecture: 'test' },
    platforms: [{ name: 'codex', harness: 'codex', enabled: true, parallelism: 1 }],
    capacity: 1,
    capabilities: ['code.v2'],
  });
  const leased = await offerReview(independent, 'other');
  const claimed = await f.reviews.get(f.admin, review.id);
  assert.deepEqual([claimed.status, claimed.reviewerId], ['started', leased.actorId]);
});

test('the owner, whom every consolidation excludes, decides it as owner without a leased checkout, and its commit is still checked', async (t) => {
  const f = await fixture(t, true);
  // In production the founder directs every worker, so the certificate names the founder.
  await f.producingSession(f.left.id, f.inputAuthor.actorId, f.admin.actorId);
  const taskId = await consolidation(f, [f.left.id, f.extra.id]);
  await f.bases.work(f.admin.projectId);
  const { runner, session, base, submitted } = await deliver(f, taskId);
  await f.sessions.release(runner, { sessionId: session.id, runnerId: 'runner' });
  // The runner's upload of the delivered head, in place of the journal a real one writes.
  await f.state.transaction((tx) =>
    tx.run(
      "INSERT INTO code_operations(id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at,unit_id) VALUES ('uploaded',?,'fixture','uploaded','upload','hash','{}','completed',?,'now','now',?)",
      f.admin.projectId,
      JSON.stringify({ head: base }),
      taskId,
    ),
  );
  const reviewId = submitted.reviewId!;
  const review = await f.reviews.get(f.admin, reviewId);
  assert.ok(review.provenance?.excludedActorIds.includes(f.admin.actorId));
  assert.equal(review.overridable, true);
  await assert.rejects(f.reviews.start(f.admin, reviewId), { code: 'review_independence' });
  // As owner the claim is not a leased worker's, and neither is the pass.
  const claimed = await f.reviews.start(f.admin, reviewId, undefined, true);
  assert.deepEqual([claimed.reviewerId, claimed.override], [f.admin.actorId, true]);
  const pass = (requestId: string) => ({
    reviewId,
    claimId: claimed.claimId!,
    verdict: 'pass' as const,
    notes: 'The owner read the consolidated commit.',
    ...reviewedFindings(claimed),
    expectedRevision: submitted.workflow.revision,
    requestId,
  });
  // The commit its delivery sealed must still be the one under review.
  const capture = f.captures.get('consolidated')!;
  f.captures.set('consolidated', {
    ...capture,
    workspace: { ...capture.workspace!, headOid: f.c },
  });
  await assert.rejects(f.tasks.submitReview(f.admin, pass('moved') as never), {
    code: 'task_commit_provenance',
  });
  f.captures.set('consolidated', capture);
  const done = await f.tasks.submitReview(f.admin, pass('pass') as never);
  assert.equal(done.workflow.state, 'done');
  const accepted = (await f.code.unit(f.admin, taskId)).acceptance!;
  assert.deepEqual(
    [accepted.acceptedBy, accepted.reviewRef, accepted.reviewAttached],
    [f.admin.actorId, reviewId, false],
  );
  assert.equal((await f.reviews.get(f.admin, reviewId)).override, true);
});

test('Fleet’s review director, vouched for by the owner every consolidation excludes, leases its review', async (t) => {
  const f = await fixture(t, true);
  await f.producingSession(f.left.id, f.inputAuthor.actorId, f.admin.actorId);
  const taskId = await consolidation(f, [f.left.id, f.extra.id]);
  await f.bases.work(f.admin.projectId);
  const { runner, session, submitted } = await deliver(f, taskId);
  await f.sessions.release(runner, { sessionId: session.id, runnerId: 'runner' });
  const review = await f.reviews.get(f.admin, submitted.reviewId!);
  assert.ok(review.provenance?.excludedActorIds.includes(f.admin.actorId));
  const director = sourceCaller({
    ...(await f.scope.serviceActor('fleet-review', f.admin.projectId, undefined, 'reviewer')),
    kind: 'service',
    vouchedBy: await f.scope.delegationSource(f.admin),
  });
  await f.sessions.dispatch.heartbeatRunner(director, {
    runnerId: 'fleet',
    machine: { hostname: 'fleet', system: 'test', architecture: 'test' },
    platforms: [{ name: 'codex', harness: 'codex', enabled: true, parallelism: 1 }],
    capacity: 1,
    capabilities: ['code.v2'],
  });
  const leased = await f.sessions.offer(director, {
    instanceId: taskId,
    expectedRevision: submitted.workflow.revision,
    runnerId: 'fleet',
    requestId: 'review',
    secret: `ms_${randomBytes(32).toString('base64url')}`,
  });
  const claimed = await f.reviews.get(f.admin, review.id);
  assert.deepEqual(
    [leased.role, claimed.status, claimed.reviewerId],
    ['reviewer', 'started', leased.actorId],
  );
});

test('a consolidation whose merge with main clashes is resolved, reviewed and delivered', async (t) => {
  const f = await fixture(t);
  // Main moved since A was built, onto the same line A changed; no unit accepted main.
  const main = f.source.commit({ 'f.txt': 'M\n' });
  f.source.git('push', f.repositories.paths(f.admin.projectId).repository, `${main}:refs/heads/m`);
  const setMain = (oid: string) =>
    f.state.transaction((tx) =>
      tx.run(
        'UPDATE code_projects SET main_json=? WHERE project_id=?',
        JSON.stringify({ oid, operationId: 'fixture', stored: true }),
        f.admin.projectId,
      ),
    );
  await setMain(main);
  const taskId = await consolidation(f, [f.left.id]);
  await f.bases.work(f.admin.projectId);
  await f.code.reconcileAll();
  const members = [f.a, main];
  assert.equal((await f.record(members))?.state, 'awaiting_resolution');
  const resolved = await f.resolveCommit(members);
  await f.acceptResolution(resolved, members);
  assert.equal((await f.record(members))?.result?.commit, resolved);
  const { base, submitted } = await deliver(f, taskId);
  assert.equal(base, resolved);
  assert.equal(submitted.workflow.state, 'in_review');
  // The resolution's certificate reads main from the lineage, not from where main is now.
  const certificate = () =>
    f.state.transaction(async (tx) =>
      f.units.reviewProvenance(f.admin.projectId, (await f.record(members))!.resolutionTaskId!, tx),
    );
  const before = await certificate();
  await setMain(f.d);
  assert.deepEqual(await certificate(), before);
});

test('derivation ignores a system edge below a code-less success', async (t) => {
  const f = await fixture(t);
  await f.waiter();
  await f.bases.work(f.admin.projectId);
  const resolutionId = (await f.record())!.resolutionTaskId!;
  let bridge = await f.handle.start(f.admin, {
    workflow: 'input',
    dependsOn: [f.left.id, f.right.id],
    requestId: 'bridge',
  });
  bridge = await f.handle.transition(f.admin, {
    instanceId: bridge.id,
    expectedRevision: 0,
    action: 'accept',
    requestId: 'bridge-done',
  });
  await f.state.transaction(async (tx) => {
    await f.code.acceptUnit(
      f.admin,
      {
        unitId: bridge.id,
        terminalRevision: bridge.revision,
        submissionRef: 'bridge',
        reviewRef: 'bridge',
        codeRef: null,
        reviewSessionId: null,
      },
      tx,
    );
    await f.workflows.systemPrerequisites('code').replace(
      {
        projectId: f.admin.projectId,
        instanceId: bridge.id,
        dependencies: [resolutionId],
      },
      tx,
    );
  });
  const waiter = await f.waiter([bridge]);
  const status = await f.state.transaction((tx) => f.code.baseStatus(f.admin, waiter.id, tx));
  assert.equal(status.status, 'blocked');
  if (status.status === 'blocked') assert.equal(status.blockers[0].code, 'code_merge_conflict');
  assert.equal(
    (await f.workflows.prerequisites(f.admin, [waiter.id]))
      .get(waiter.id)!
      .filter((edge) => edge.kind === 'system')[0].id,
    resolutionId,
  );
  assert.equal((await f.state.read((sql) => f.bases.records(sql, f.admin.projectId))).length, 1);
});

test('an accepted resolution missing an input never seals or replaces its task', async (t) => {
  const f = await fixture(t);
  const waiter = await f.waiter();
  await f.bases.work(f.admin.projectId);
  const baseRecord = (await f.record())!;
  const taskId = baseRecord.resolutionTaskId;
  // An old acceptance may predate admission proofs; the base worker must still reject it.
  await f.state.transaction((tx) =>
    f.bases.recordAcceptance(tx, f.admin.projectId, baseRecord!, f.a),
  );
  await f.bases.work(f.admin.projectId);
  for (let i = 0; i < 2; i++) await f.bases.work(f.admin.projectId);
  const base = (await f.record())!;
  assert.equal(base.state, 'awaiting_resolution');
  assert.equal(base.result, null);
  assert.equal(base.resolutionTaskId, taskId);
  assert.match(base.resolutionError!, /no two-parent merge/);
  assert.deepEqual(await f.bases.due(), []);
  const rejectedAt = base.updatedAt;
  await f.code.reconcileAll();
  await f.bases.work(f.admin.projectId);
  assert.equal((await f.record())!.updatedAt, rejectedAt);
  const blockers = await f.workflows.blockers(f.admin, waiter.id);
  assert.ok(
    blockers.some(
      (blocker) =>
        /no two-parent merge/.test(blocker.message) && /in_progress/.test(blocker.message),
    ),
  );
  await assert.rejects(
    f.state.transaction((tx) =>
      f.code.pinBase(f.admin, { unitId: waiter.id, leaseId: 'bad', writer: false }, tx),
    ),
    { code: 'code_merge_conflict' },
  );
});

test('three resolution rounds retain one task, carry all feedback and suspend until a human extends the limit', async (t) => {
  const f = await fixture(t, true);
  const waiter = await f.waiter();
  await f.bases.work(f.admin.projectId);
  const taskId = (await f.record())!.resolutionTaskId!;
  const commit = await f.resolveCommit();
  const identity = await f.scope.credentials.issueActor(f.admin, {
    name: 'Resolution worker machine',
    role: 'producer',
  });
  const runner = {
    projectId: f.admin.projectId,
    actorId: identity.actor.id,
    credentialId: identity.credential.id,
  };
  await f.sessions.dispatch.heartbeatRunner(runner, {
    runnerId: 'round-runner',
    machine: { hostname: 'rounds', system: 'test', architecture: 'test' },
    platforms: [{ name: 'codex', harness: 'codex', enabled: true, parallelism: 1 }],
    capacity: 1,
    capabilities: ['code.v2'],
  });
  // Each round's review is leased: only a leased worker may claim a Git task's review.
  const reviewerIdentity = await f.scope.credentials.issueActor(f.admin, {
    name: 'Independent review runner',
    role: 'operator',
  });
  const reviewer = {
    projectId: f.admin.projectId,
    actorId: reviewerIdentity.actor.id,
    credentialId: reviewerIdentity.credential.id,
  };
  await f.sessions.dispatch.heartbeatRunner(reviewer, {
    runnerId: 'round-reviewer',
    machine: { hostname: 'rounds', system: 'test', architecture: 'test' },
    platforms: [{ name: 'codex', harness: 'codex', enabled: true, parallelism: 1 }],
    capacity: 1,
    capabilities: ['code.v2'],
  });
  const ids: string[] = [];
  const submissions: string[] = [];
  for (let round = 1; round <= 3; round++) {
    const task = await f.tasks.get(f.admin, taskId);
    assert.equal(
      (task.workflow.data.rejectedReviewIds as string[] | undefined)?.length ?? 0,
      round - 1,
    );
    const context = await f.tasks.context(f.admin, {
      taskId,
      expectedRevision: task.workflow.revision,
      purpose: 'work',
      requestId: `context-${round}`,
    });
    for (let prior = 1; prior < round; prior++) {
      assert.ok(context.prompt.includes(`Correction ${prior}`));
      assert.ok(context.prompt.includes(ids[prior - 1]));
      assert.ok(context.prompt.includes(submissions[prior - 1]));
    }
    const secret = `ms_${randomBytes(32).toString('base64url')}`;
    const session = await f.sessions.offer(runner, {
      instanceId: taskId,
      expectedRevision: task.workflow.revision,
      runnerId: 'round-runner',
      requestId: `round-${round}`,
      secret,
    });
    const base = (await f.state.transaction((tx) => f.code.basePin(f.admin, taskId, tx)))!
      .reference;
    const workspace = {
      repositoryId: 'repository',
      workspaceId: taskId,
      mode: 'persistent' as const,
      branch: 'merv/resolution',
      baseOid: base,
      headOid: commit,
      stats: { commitCount: 1, filesChanged: 1, insertions: 1, deletions: 1 },
    };
    await f.sessions.attach(runner, {
      sessionId: session.id,
      runnerId: 'round-runner',
      hostRef: `round-${round}`,
      workspace,
    });
    const worker = await f.sessions.authenticate(secret);
    const commandId = `round-commit-${round}`;
    f.captures.set(commandId, {
      ref: { kind: 'code-commit', commandId },
      status: 'ready',
      provenance: {
        projectId: f.admin.projectId,
        instanceId: taskId,
        sessionId: session.id,
        actorId: worker.actorId,
        revision: task.workflow.revision,
        workflow: { name: 'task', version: 11, state: 'in_progress' },
        readOnly: false,
      } as CodeCapture['provenance'],
      workspace,
      observedAt: 'now',
      eventId: null,
    });
    await f.admission(taskId, commit, `round-upload-${round}`);
    const delivery = confirmedDelivery(
      {
        taskId,
        expectedRevision: task.workflow.revision,
        requestId: `delivery-${round}`,
        commandId,
        artifactIds: [],
      },
      task.checks.length,
    );
    const submitted = await f.sessions.invocations.run(
      await f.sessions.invocations.prepare(worker, 'task.submit_delivery', delivery),
      (caller) => f.tasks.submitDelivery(caller, delivery),
    );
    submissions.push(submitted.deliveryCodeArtifactId!);
    await f.sessions.release(runner, { sessionId: session.id, runnerId: 'round-runner' });
    const reviewSecret = `ms_${randomBytes(32).toString('base64url')}`;
    const reviewSession = await f.sessions.offer(reviewer, {
      instanceId: taskId,
      expectedRevision: submitted.workflow.revision,
      runnerId: 'round-reviewer',
      requestId: `round-review-${round}`,
      secret: reviewSecret,
    });
    const reviewWorker = await f.sessions.authenticate(reviewSecret);
    const review = await f.reviews.get(reviewWorker, submitted.reviewId!);
    ids.push(review.id);
    const assessment = {
      ...reviewedFindings(review),
      reviewId: review.id,
      claimId: review.claimId!,
      expectedRevision: submitted.workflow.revision,
      verdict: 'needs_changes' as const,
      notes: `Correction ${round}`,
      synopsis: `Correction ${round} is required because the independent checks found an unmet criterion.`,
      findings: review.criteria.map((_, index) => ({
        criterionNumber: index + 1,
        status: index === 0 ? ('not_met' as const) : ('met' as const),
        evidenceIds: [submitted.deliveryCodeArtifactId!],
        notes: index === 0 ? `Unmet criterion ${round}` : 'Independently verified.',
      })),
      requestId: `verdict-${round}`,
    };
    const returned = await f.sessions.invocations.run(
      await f.sessions.invocations.prepare(reviewWorker, 'review.submit', assessment),
      (caller) => f.tasks.submitReview(caller, assessment),
    );
    assert.equal(returned.workflow.state, round === 3 ? 'suspended' : 'in_progress');
    await f.sessions.release(reviewer, { sessionId: reviewSession.id, runnerId: 'round-reviewer' });
    await f.events.drain();
    // The move alone, which ends nothing, re-derives the units waiting on the resolution.
    const said = (await f.workflows.blockers(f.admin, waiter.id)).map((item) => item.message);
    assert.ok(
      said.some((message) => message.includes(returned.workflow.state)),
      String(said),
    );
    if (round === 1) {
      // A waiter that arrives while the returned resolution is reworked joins the same task.
      const [future] = await Promise.all([
        f.waiter(),
        f.code.reconcileAll(),
        f.code.reconcileAll(),
      ]);
      assert.deepEqual(
        (await f.workflows.prerequisites(f.admin, [future.id]))
          .get(future.id)!
          .filter((edge) => edge.kind === 'system')
          .map((edge) => edge.id),
        [taskId],
      );
      await f.bases.work(f.admin.projectId);
      const record = (await f.record())!;
      assert.deepEqual([record.resolutionTaskId, record.state], [taskId, 'awaiting_resolution']);
    }
    // The fixture plays the final handoff; real final capture is exercised by the driver tests.
    await f.state.transaction((tx) =>
      tx.run("UPDATE code_workspaces SET writer_state='closed' WHERE unit_id=?", taskId),
    );
  }
  await f.code.reconcileAll();
  const wait = await f.tasks.get(f.admin, waiter.id);
  assert.notEqual(wait.guidance.nextAction?.action, 'mark_failed');
  assert.ok(
    wait.guidance.dependencies.some(
      (edge) => edge.id === taskId && edge.state === 'suspended' && !edge.failed,
    ),
  );
  const blockers = await f.workflows.blockers(f.admin, waiter.id);
  assert.ok(
    blockers.some(
      (blocker) =>
        blocker.message.includes('suspended') && blocker.next.includes('workflow.extend_limit'),
    ),
  );
  // The move is the suspended task's own, asked of a project admin once on its card: each unit
  // waiting on it names nobody's move, so Needs you does not list it again per waiter.
  assert.equal(
    blockers.find((blocker) => blocker.code === 'code_merge_conflict')?.whose,
    undefined,
  );
  const gates = (await f.workflows.overview(f.admin, undefined, { open: true })).workflows;
  assert.equal(gates.find((gate) => gate.instanceId === waiter.id)?.yours, undefined);
  assert.ok(gates.find((gate) => gate.instanceId === taskId)?.yours?.ask);
  assert.ok(
    (await f.sessions.dispatch.stuck(f.admin)).items.some(
      (item) => item.instanceId === waiter.id && item.why.includes('suspended'),
    ),
  );
  // The suspended task carries the admin's move on its card, though its limit leaves in_progress.
  const escalated = await f.workflows.escalated(f.admin);
  assert.deepEqual(
    [escalated.admin, escalated.items.map((item) => [item.instanceId, item.limit.name])],
    [true, [[taskId, 'review_rounds']]],
  );
  const grant = {
    instanceId: taskId,
    limit: 'review_rounds',
    additional: 1,
    reason: 'One more correction',
    requestId: 'extend',
  };
  await assert.rejects(f.workflows.extendLimit(runner, grant), { code: 'forbidden' });
  const machineAdmin = await f.scope.credentials.issueActor(f.admin, {
    name: 'Operator machine',
    role: 'operator',
  });
  await assert.rejects(
    f.workflows.extendLimit(
      {
        projectId: f.admin.projectId,
        actorId: machineAdmin.actor.id,
        credentialId: machineAdmin.credential.id,
      },
      grant,
    ),
    { code: 'forbidden' },
  );

  // Every round is used, so resuming without another one is refused.
  await assert.rejects(
    f.workflows.extendLimit(f.admin, { ...grant, additional: 0, requestId: 'no-round' }),
    { code: 'invalid_input' },
  );
  await f.workflows.extendLimit(f.admin, grant);
  const resumed = await f.tasks.get(f.admin, taskId);
  assert.equal(resumed.workflow.state, 'in_progress');
  assert.equal(resumed.failure, null, 'a resumed task no longer reads as failed');
  assert.deepEqual(resumed.workflow.data.rejectedReviewIds, ids);
  await f.workflows.extendLimit(f.admin, grant);
  assert.equal((await f.tasks.get(f.admin, taskId)).workflow.revision, resumed.workflow.revision);
  const context = await f.tasks.context(f.admin, {
    taskId,
    expectedRevision: resumed.workflow.revision,
    purpose: 'work',
    requestId: 'resumed-context',
  });
  for (let prior = 1; prior <= 3; prior++) {
    assert.ok(context.prompt.includes(`Correction ${prior}`));
    assert.ok(context.prompt.includes(`Unmet criterion ${prior}`));
    assert.ok(context.prompt.includes(ids[prior - 1]));
    assert.ok(context.prompt.includes(submissions[prior - 1]));
  }
  assert.equal(
    (await f.tasks.list(f.admin)).filter((task) => task.workflow.version === 45).length,
    1,
  );
  const stopped = await f.tasks.markFailed(f.admin, {
    taskId,
    expectedRevision: resumed.workflow.revision,
    requestId: 'suspend-again',
    reason: 'The next round was abandoned before submission.',
  });
  assert.equal(stopped.workflow.state, 'suspended');
  assert.equal(stopped.failure!.reason, 'The next round was abandoned before submission.');
  await f.workflows.extendLimit(f.admin, { ...grant, requestId: 'resume-again' });
  const continued = await f.tasks.get(f.admin, taskId);
  assert.equal(continued.workflow.state, 'in_progress');
  assert.equal(continued.failure, null);
  assert.deepEqual(continued.workflow.data.rejectedReviewIds, ids);
  const feedback = await f.tasks.context(f.admin, {
    taskId,
    expectedRevision: continued.workflow.revision,
    purpose: 'work',
    requestId: 'after-abandonment',
  });
  assert.match(feedback.prompt, /abandoned before submission/);
  for (let prior = 1; prior <= 3; prior++) {
    assert.ok(feedback.prompt.includes(`Correction ${prior}`));
    assert.ok(feedback.prompt.includes(submissions[prior - 1]));
  }
  assert.equal((await f.record())!.resolutionTaskId, taskId);
  assert.deepEqual(await f.bases.due(), []);
});

for (const shape of ['single parent', 'different second parent'] as const)
  test(`${shape} cannot seal a resolution and the refusal remains visible`, async (t) => {
    const f = await fixture(t);
    const waiter = await f.waiter();
    await f.bases.work(f.admin.projectId);
    const base = (await f.record())!;
    const [left, right] = await f.state.read((sql) => f.bases.inputs(sql, f.admin.projectId, base));
    const tree = f.source.git('rev-parse', `${left}^{tree}`);
    const ancestor = f.source.git('rev-parse', `${left}^`);
    const wrong =
      shape === 'single parent'
        ? f.source.git(
            'commit-tree',
            tree,
            '-p',
            left!,
            '-m',
            'A single parent is not a resolution',
          )
        : f.source.git(
            'commit-tree',
            tree,
            '-p',
            left!,
            '-p',
            ancestor,
            '-m',
            'Wrong second parent',
          );
    // Both inputs eventually appear, but a later merge cannot repair the first merge's parents.
    const head =
      shape === 'single parent'
        ? wrong
        : f.source.git(
            'commit-tree',
            tree,
            '-p',
            wrong,
            '-p',
            right!,
            '-m',
            'Contains both inputs too late',
          );
    f.source.git(
      'push',
      f.repositories.paths(f.admin.projectId).repository,
      `${head}:refs/heads/invalid-resolution`,
    );
    await f.state.transaction((tx) => f.bases.recordAcceptance(tx, f.admin.projectId, base, head));
    await f.bases.work(f.admin.projectId);
    const rejected = (await f.record())!;
    assert.equal(rejected.result, null);
    assert.equal(rejected.resolutionTaskId, base.resolutionTaskId);
    assert.match(
      rejected.resolutionError!,
      shape === 'single parent' ? /no two-parent merge/ : /exactly.*two ordered parents/,
    );
    assert.ok(
      (await f.workflows.blockers(f.admin, waiter.id)).some((blocker) =>
        blocker.message.includes(rejected.resolutionError!),
      ),
    );
    assert.deepEqual(await f.bases.due(), []);
    if (shape === 'single parent')
      await assert.rejects(f.acceptResolution(head), {
        code: 'code_resolution_merge_required',
      });
  });

// A returned resolution (needs_changes) is the rounds test above.
for (const verdict of ['pass', 'fail'] as const)
  test(`service resolution uses the existing independent review path (${verdict})`, async (t) => {
    const f = await fixture(t, true);
    await f.waiter();
    await f.bases.work(f.admin.projectId);
    const id = (await f.record())!.resolutionTaskId!;
    const task = await f.tasks.get(f.admin, id);
    const commit = await f.resolveCommit();
    const issued = await f.scope.credentials.issueActor(f.admin, {
      name: 'Producer runner',
      role: 'producer',
    });
    const runner = {
      projectId: f.admin.projectId,
      actorId: issued.actor.id,
      credentialId: issued.credential.id,
    };
    await f.sessions.dispatch.heartbeatRunner(runner, {
      runnerId: 'runner',
      machine: { hostname: 'fixture', system: 'test', architecture: 'test' },
      platforms: [{ name: 'codex', harness: 'codex', enabled: true, parallelism: 4 }],
      capacity: 4,
      capabilities: ['code.v2'],
    });
    const secret = `ms_${randomBytes(32).toString('base64url')}`;
    const session = await f.sessions.offer(runner, {
      instanceId: id,
      expectedRevision: 0,
      runnerId: 'runner',
      requestId: 'work',
      secret,
    });
    const base = (await f.state.transaction((tx) => f.code.basePin(f.admin, id, tx)))!.reference;
    const workspace = {
      repositoryId: 'repository',
      workspaceId: id,
      mode: 'persistent' as const,
      branch: 'merv/task',
      baseOid: base,
      headOid: commit,
      stats: { commitCount: 1, filesChanged: 1, insertions: 1, deletions: 1 },
    };
    await f.sessions.attach(runner, {
      sessionId: session.id,
      runnerId: 'runner',
      hostRef: 'work',
      workspace: { ...workspace, headOid: base },
    });
    const worker = await f.sessions.authenticate(secret);
    f.captures.set('resolution-delivery', {
      ref: { kind: 'code-commit', commandId: 'resolution-delivery' },
      status: 'ready',
      provenance: {
        projectId: f.admin.projectId,
        instanceId: id,
        sessionId: session.id,
        actorId: worker.actorId,
        revision: 0,
        workflow: { name: 'task', version: 11, state: 'in_progress' },
        readOnly: false,
      } as CodeCapture['provenance'],
      workspace,
      observedAt: 'now',
      eventId: null,
    });
    await f.admission(id, commit, 'upload');
    const delivery = confirmedDelivery(
      {
        taskId: id,
        expectedRevision: 0,
        requestId: 'delivery',
        commandId: 'resolution-delivery',
        artifactIds: [],
      },
      task.checks.length,
    );
    const pending = await f.sessions.invocations.run(
      await f.sessions.invocations.prepare(worker, 'task.submit_delivery', delivery),
      (caller) => f.tasks.submitDelivery(caller, delivery),
    );
    const review = await f.reviews.get(f.admin, pending.reviewId!);
    assert.ok(review.excludedActorIds?.includes(task.producerId));
    assert.ok(review.excludedActorIds?.includes(runner.actorId));
    await assert.rejects(f.reviews.start(runner, review.id));
    await f.sessions.release(runner, { sessionId: session.id, runnerId: 'runner' });
    const reviewerIdentity = await f.scope.credentials.issueActor(f.admin, {
      name: 'Independent review runner',
      role: 'operator',
    });
    const reviewer = {
      projectId: f.admin.projectId,
      actorId: reviewerIdentity.actor.id,
      credentialId: reviewerIdentity.credential.id,
    };
    await f.sessions.dispatch.heartbeatRunner(reviewer, {
      runnerId: 'reviewer',
      machine: { hostname: 'fixture', system: 'test', architecture: 'test' },
      platforms: [{ name: 'codex', harness: 'codex', enabled: true, parallelism: 4 }],
      capacity: 4,
      capabilities: ['code.v2'],
    });
    const reviewSecret = `ms_${randomBytes(32).toString('base64url')}`;
    const reviewSession = await f.sessions.offer(reviewer, {
      instanceId: id,
      expectedRevision: pending.workflow.revision,
      runnerId: 'reviewer',
      requestId: 'review',
      secret: reviewSecret,
    });
    await f.sessions.attach(reviewer, {
      sessionId: reviewSession.id,
      runnerId: 'reviewer',
      hostRef: 'review',
      workspace: {
        ...workspace,
        workspaceId: reviewSession.id,
        mode: 'ephemeral',
        branch: null,
        baseOid: commit,
      },
    });
    const reviewWorker = await f.sessions.authenticate(reviewSecret);
    const claimed = await f.reviews.get(reviewWorker, review.id);
    const assessment = {
      ...reviewedFindings(claimed),
      reviewId: review.id,
      claimId: claimed.claimId!,
      expectedRevision: pending.workflow.revision,
      verdict,
      notes: 'Independent verification of the frozen inputs and checks.',
      requestId: 'verdict',
    };
    const result = await f.sessions.invocations.run(
      await f.sessions.invocations.prepare(reviewWorker, 'review.submit', assessment),
      (caller) => f.tasks.submitReview(caller, assessment),
    );
    assert.equal(result.workflow.state, verdict === 'pass' ? 'done' : 'suspended');
    await f.events.drain();
    await f.bases.work(f.admin.projectId);
    const resolved = (await f.record())!;
    assert.equal(resolved.resolutionTaskId, id);
    assert.equal(resolved.state, verdict === 'pass' ? 'resolved' : 'awaiting_resolution');
    if (verdict === 'pass') assert.equal(resolved.result?.commit, commit);
    if (verdict === 'fail') {
      await f.workflows.extendLimit(f.admin, {
        instanceId: id,
        limit: 'review_rounds',
        additional: 1,
        reason: 'Allow another attempt after the failed review.',
        requestId: 'resume-failed',
      });
      const resumed = await f.tasks.get(f.admin, id);
      assert.equal(resumed.workflow.state, 'in_progress');
      assert.deepEqual(resumed.workflow.data.rejectedReviewIds, [review.id]);
      const context = await f.tasks.context(f.admin, {
        taskId: id,
        expectedRevision: resumed.workflow.revision,
        purpose: 'work',
        requestId: 'failed-feedback',
      });
      assert.ok(context.prompt.includes(review.id));
      assert.ok(context.prompt.includes(assessment.notes));
      assert.ok(context.prompt.includes('"verdict":"fail"'));
    }
    assert.equal(
      (await f.tasks.list(f.admin)).filter((item) => item.workflow.version === 45).length,
      1,
    );
  });

test('project writers lease a service task as producers and mark_failed suspends a non-failing prerequisite', async (t) => {
  const f = await fixture(t);
  const waiter = await f.waiter();
  await f.bases.work(f.admin.projectId);
  const task = await f.tasks.get(f.admin, (await f.record())!.resolutionTaskId!);
  const owner = { projectId: f.admin.projectId, actorId: task.producerId };
  await f.scope.require(owner, 'write');
  await assert.rejects(f.scope.require(owner, 'admin'), { code: 'forbidden' });
  assert.equal(await f.scope.eligible(owner.projectId, owner.actorId, 'review'), false);
  await assert.rejects(
    f.state.transaction((tx) =>
      tx.run("UPDATE actors SET role='operator' WHERE id=?", owner.actorId),
    ),
  );
  for (const column of ['session_id', 'agent_id'])
    await assert.rejects(
      f.state.transaction((tx) =>
        tx.run(`UPDATE actors SET ${column}=? WHERE id=?`, 'forbidden', owner.actorId),
      ),
    );
  await assert.rejects(
    f.state.transaction((tx) => tx.run('DELETE FROM actors WHERE id=?', owner.actorId)),
  );

  await assert.rejects(
    f.scope.credentials.issueActorCredential(f.admin, { actorId: owner.actorId }),
    {
      code: 'member_actor',
    },
  );
  const producer = await f.scope.credentials.issueActor(f.admin, {
    name: 'Runner',
    role: 'producer',
  });
  const runner = {
    projectId: f.admin.projectId,
    actorId: producer.actor.id,
    credentialId: producer.credential.id,
  };
  assert.equal(
    await f.workflows.leaseRole(runner, { instanceId: task.id, expectedRevision: 0 }),
    'producer',
  );
  await f.sessions.dispatch.heartbeatRunner(runner, {
    runnerId: 'runner',
    machine: { hostname: 'fixture', system: 'test', architecture: 'test' },
    platforms: [{ name: 'codex', harness: 'codex', enabled: true, parallelism: 4 }],
    capacity: 4,
    capabilities: ['code.v2'],
  });
  const secret = `ms_${randomBytes(32).toString('base64url')}`;
  const session = await f.sessions.offer(runner, {
    instanceId: task.id,
    expectedRevision: 0,
    runnerId: 'runner',
    requestId: 'offer',
    secret,
  });
  const worker = await f.sessions.authenticate(secret);
  assert.equal((await f.scope.require(worker, 'write')).role, 'producer');
  await assert.rejects(f.scope.require(worker, 'admin'), { code: 'forbidden' });
  for (const tool of ['task.create', 'task.create_service', 'workflow.system_prerequisites'])
    await assert.rejects(f.sessions.invocations.prepare(worker, tool, {}));
  await assert.rejects(
    f.workflows.leaseRole(worker, { instanceId: task.id, expectedRevision: 0 }),
    { code: 'forbidden' },
  );
  await f.sessions.release(runner, { sessionId: session.id, runnerId: 'runner' });
  await f.tasks.markFailed(f.admin, {
    taskId: task.id,
    expectedRevision: 0,
    requestId: 'failed',
    reason: 'Cannot resolve this conflict.',
  });
  await f.code.reconcileAll();
  const read = await f.tasks.get(f.admin, waiter.id);
  assert.notEqual(read.guidance.nextAction?.action, 'mark_failed');
  assert.notEqual(read.guidance.currentGate, 'dependency_failed');
  assert.ok(
    read.guidance.dependencies.some(
      (edge) => edge.kind === 'system' && edge.state === 'suspended' && !edge.failed,
    ),
  );
  await f.code.reconcileAll();
  assert.equal((await f.record())!.resolutionTaskId, task.id);
});

test('a service task suspended with rounds to spare is an admin’s move that resumes it without a round', async (t) => {
  const f = await fixture(t, true);
  await f.waiter();
  await f.bases.work(f.admin.projectId);
  const task = await f.tasks.get(f.admin, (await f.record())!.resolutionTaskId!);
  await f.tasks.markFailed(f.admin, {
    taskId: task.id,
    expectedRevision: 0,
    requestId: 'failed',
    reason: 'Cannot resolve this conflict.',
  });
  // Suspended with rounds to spare: an admin's move, which resumes it without another round.
  const asked = await f.workflows.evaluate(f.admin, task.id);
  assert.equal(asked.state, 'suspended');
  assert.ok(asked.yours?.ask, 'the suspended task asks a project admin');
  const escalated = await f.workflows.escalated(f.admin);
  const [mark] = limitMarks(escalated);
  assert.deepEqual(
    [mark.key, mark.says, mark.action?.label, mark.action?.input],
    [
      `work:${task.id}`,
      ['Suspended · an admin resumes it'],
      'Resume',
      { instanceId: task.id, limit: 'review_rounds', additional: 0 },
    ],
  );
  const grants = async () =>
    await f.state.read((sql) =>
      sql.all('SELECT * FROM wf_limit_grants WHERE instance_id=?', task.id),
    );
  await f.workflows.extendLimit(f.admin, {
    instanceId: task.id,
    limit: 'review_rounds',
    additional: 0,
    reason: 'Try it again',
    requestId: 'resume',
  });
  assert.equal((await f.tasks.get(f.admin, task.id)).workflow.state, 'in_progress');
  assert.deepEqual(await grants(), [], 'no round is granted to resume it');
});

test('base operator controls retain history, deny workers, and explain each disposition to waiters', async (t) => {
  const f = await fixture(t);
  t.mock.method(f.bases, 'soon', () => {});
  const waiter = await f.waiter();
  const key = (await f.record())!.key;
  // Another Code consumer's quarantine is outside the research base policy.
  await f.state.transaction((tx) =>
    tx.run(
      'INSERT INTO code_units(project_id,unit_id,workflow,version,declared_at,quarantine_base_key) VALUES(?,?,?,?,?,?)',
      f.admin.projectId,
      'external-unit',
      'external-owner',
      1,
      new Date().toISOString(),
      'external-quarantine',
    ),
  );
  const control = (action: string, requestId = action) =>
    f.bases.control(f.scope, f.admin, { key, action, requestId, reason: `Operator ${action}` });
  const service = await f.state.transaction((tx) =>
    f.scope.serviceActor('fixture', f.admin.projectId, tx),
  );
  await assert.rejects(
    f.bases.control(f.scope, service, {
      key,
      action: 'cancel',
      requestId: 'forbidden',
      reason: 'No authority',
    }),
    { status: 403 },
  );
  const suspended = await control('suspend');
  assert.equal(suspended.state, 'suspended');
  assert.deepEqual(await control('suspend'), suspended);
  let blocker = (await f.workflows.blockers(f.admin, waiter.id))[0]!;
  assert.equal(blocker.code, 'code_base_blocked');
  assert.match(blocker.message, /suspended.*Operator suspend/);
  assert.match(blocker.next, /resume/);
  await f.bases.work(f.admin.projectId);
  assert.equal((await f.record())!.attempts, 0);
  assert.equal((await control('resume')).state, 'queued');
  await f.bases.work(f.admin.projectId);
  const task = (await f.record())!.resolutionTaskId;
  assert.ok(task);
  await control('suspend', 'suspend-conflict');
  const resolutionStatus = await f.state.transaction((tx) => f.code.baseStatus(f.admin, task!, tx));
  assert.equal(resolutionStatus.status, 'blocked');
  await control('resume', 'resume-conflict');
  assert.equal((await f.record())!.resolutionTaskId, task);
  assert.equal((await control('cancel')).state, 'cancelled');
  blocker = (await f.workflows.blockers(f.admin, waiter.id))[0]!;
  assert.match(blocker.message, /cancelled/);
  assert.match(blocker.next, /replan/);
  await assert.rejects(control('resume', 'cancelled-resume'), { code: 'code_base_changed' });
  const quarantined = await control('quarantine');
  assert.equal(quarantined.quarantined, true);
  assert.equal(quarantined.resolutionTaskId, task);
  assert.equal(
    (
      await f.state.read((sql) =>
        sql.get<{ quarantine_base_key: string }>(
          'SELECT quarantine_base_key FROM code_units WHERE project_id=? AND unit_id=?',
          f.admin.projectId,
          'external-unit',
        ),
      )
    )?.quarantine_base_key,
    'external-quarantine',
  );
  blocker = (await f.workflows.blockers(f.admin, waiter.id))[0]!;
  assert.equal(blocker.code, 'code_quarantined');
  const history = await f.state.read((sql) =>
    sql.all<{ payload_json: string }>(
      "SELECT payload_json FROM code_work_receipts WHERE project_id=? AND kind='base-control' ORDER BY created_at,id",
      f.admin.projectId,
    ),
  );
  assert.equal(history.length, 6);
  assert.equal(
    (await f.state.read((sql) =>
      sql.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM code_bases WHERE project_id=?',
        f.admin.projectId,
      ),
    ))!.n,
    1,
  );
});
test('a base that merged cleanly and failed its check is briefed as that, not as a conflict', async (t) => {
  const f = await fixture(t);
  await f.state.transaction((tx) =>
    tx.run(
      'INSERT INTO code_research_check_configuration(project_id,check_json) VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET check_json=EXCLUDED.check_json',
      f.admin.projectId,
      JSON.stringify({
        command: 'npm ci\nnpm test',
        timeoutSeconds: 600,
        image: { provider: 'thunder_compute', offerId: 'a6000_x1:thunder', snapshotId: null },
      }),
    ),
  );
  const handle: SandboxCheckHandle = {
    sandboxId: 'sbx_1',
    jobId: null,
    objectId: 'obj_1',
    restoreJobId: null,
    ready: false,
    environment: null,
  };
  f.bases.checks = {
    start: async () => ({ ...handle }),
    step: async (_projectId, plan, current) =>
      current.ready
        ? { ...current, jobId: 'job_1' }
        : {
            ...current,
            ready: true,
            environment: {
              provider: plan.provider,
              offerId: plan.offerId,
              snapshotId: plan.snapshotId,
            },
          },
    follow: async () => ({
      state: 'failed' as const,
      result: { exit: 7, bytes: 13, head: 'FAIL\u0000 test_one', tail: '' },
      setup: null,
      startedAt: null,
      finishedAt: null,
      usage: null,
    }),
    release: async () => {},
  };
  // The inputs of this base do not conflict: a is f.txt and d is g.txt.
  await f.waiter([f.left, f.extra]);
  for (let pass = 0; pass < 6; pass += 1) await f.bases.work(f.admin.projectId);
  const base = (await f.state.read((sql) => f.bases.find(sql, f.admin.projectId, [f.a, f.d])))!;
  assert.equal(base.state, 'awaiting_resolution');
  assert.equal(base.checkState, 'failed');
  const task = await f.tasks.get(f.admin, base.resolutionTaskId!);
  // The first sentence a worker reads must not ask for conflicts this base does not have.
  assert.match(task.title, /^Make the project check pass on /);
  assert.match(task.goal, /^The merge of .+ is clean; its project check failed\./);
  assert.ok(!task.goal.startsWith('Resolve conflicts between'));
  assert.ok(
    task.checks.includes('Leave no conflict markers.'),
    'and no path is named as conflicting',
  );
  assert.ok(task.checks.some((entry: string) => /failed with exit 7/.test(entry)));
});
test('a resolved base reaches the existing mirror journal and an outage never changes it or its waiters', async (t) => {
  const f = await fixture(t);
  t.mock.method(f.bases, 'soon', () => {});
  const waiter = await f.waiter([f.left, f.extra]);
  await f.bases.work(f.admin.projectId);
  const base = (await f.state.read((sql) => f.bases.find(sql, f.admin.projectId, [f.a, f.d])))!;
  assert.equal(base.state, 'resolved');
  const remote = join(f.directory, 'mirror.git');
  git(f.directory, ['init', '--bare', '--quiet', remote]);
  let outage = true;
  const transport = {
    target: async () => ({ repository: 'fixture/remote' }),
    lsRemote: async (_projectId: string, ref: string) => {
      if (outage) throw new Error('Mirror unavailable');
      const found = git(f.directory, ['ls-remote', remote, ref]);
      return found ? found.split('\t')[0]! : null;
    },
    push: async (
      _projectId: string,
      update: { ref: string; oid: string; expectedRemote: string | null },
    ) => {
      git(f.repositories.paths(f.admin.projectId).repository, [
        'push',
        '--porcelain',
        `--force-with-lease=${update.ref}:${update.expectedRemote ?? ''}`,
        remote,
        `${update.oid}:${update.ref}`,
      ]);
      return 'ok' as const;
    },
  };
  const mirror = new CodeMirrorService(f.state, f.scope, f.repositories, transport, {
    mirrorSeconds: 0,
    backoffMs: 0,
  });
  f.beforeClose.push(() => mirror.close());
  await mirror.run();
  assert.equal((await mirror.describe(f.admin.projectId)).state, 'retrying');
  assert.deepEqual(
    await f.state.read((sql) => f.bases.find(sql, f.admin.projectId, [f.a, f.d])),
    base,
  );
  assert.deepEqual(await f.workflows.blockers(f.admin, waiter.id), []);
  outage = false;
  await mirror.run();
  assert.equal(
    git(f.directory, ['--git-dir', remote, 'rev-parse', `refs/heads/merv/bases/${base.key}`]),
    base.result!.commit,
  );
  await mirror.run();
  // Accepting the inputs also journalled their result refs, which Code's store retains on its
  // own timer and then queues for the mirror; those may join at any point in these passes and
  // wait for the next one, so only the base's own operation is this test's to count.
  const operations = await f.state.read((sql) =>
    sql.all<{ status: string }>("SELECT status FROM code_operations WHERE kind='mirror-base'"),
  );
  assert.deepEqual(
    operations.map((row) => row.status),
    ['completed'],
  );
});

test('budget admission reaches the stuck report and consumes neither launch holds nor review rounds', async (t) => {
  const f = await fixture(t);
  t.mock.method(f.bases, 'soon', () => {});
  const waiter = await f.waiter([f.left, f.extra]);
  const admission = t.mock.method(f.sessions.serviceWork!, 'admit', async () => ({
    admitted: false as const,
    reason: 'budget_exceeded' as const,
  }));
  await f.bases.work(f.admin.projectId);
  const base = (await f.state.read((sql) => f.bases.find(sql, f.admin.projectId, [f.a, f.d])))!;
  assert.equal(base.attempts, 0);
  assert.equal(base.resolutionTaskId, null);
  assert.equal(base.blocker, 'budget_exceeded');
  const blockers = await f.workflows.blockers(f.admin, waiter.id);
  // Stored with the cause readers word it by, so none of them reads the message.
  assert.deepEqual(
    [blockers[0]!.code, blockers[0]!.cause],
    ['code_base_admission', 'budget_exceeded'],
  );
  assert.equal(personMove(blockers[0]!)?.sentence, 'The budget set for this project is spent');
  // Code says whose move ending it is, which the record's gate answers to a project admin.
  assert.equal(blockers[0]!.whose, 'admin');
  const stuck = await f.sessions.dispatch.stuck(f.admin);
  assert.ok(
    stuck.items.some(
      (item) =>
        item.instanceId === waiter.id &&
        item.code === 'code_base_admission' &&
        item.why.includes('budget_exceeded'),
    ),
  );
  const holds = await f.state.read((sql) =>
    sql.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM session_dispatch_holds WHERE project_id=? AND attempts>0',
      f.admin.projectId,
    ),
  );
  assert.equal(holds!.n, 0);
  admission.mock.restore();
  await f.bases.control(f.scope, f.admin, {
    key: base.key,
    action: 'retry',
    reason: 'Budget raised; retry now',
    requestId: 'budget-ready',
  });
  await f.bases.work(f.admin.projectId);
  assert.deepEqual(await f.workflows.blockers(f.admin, waiter.id), []);
});

test('a machine a resolved base could not give back holds up none of the work built on it', async (t) => {
  const f = await fixture(t);
  const waiter = await f.waiter([f.left, f.extra]);
  await f.bases.work(f.admin.projectId);
  const base = (await f.record([f.a, f.d]))!;
  assert.equal(base.state, 'resolved');
  // A release the service refused five times, or a warning kept from before cleanup was owned.
  await f.state.transaction((tx) =>
    tx.run(
      "INSERT INTO code_base_cleanup(project_id,base_key,cleanup_id,attempts,reason) VALUES (?,?,'legacy',5,'refused')",
      f.admin.projectId,
      base.key,
    ),
  );
  assert.match((await f.record([f.a, f.d]))!.blocker!, /code_check_unreclaimed/);
  const status = await f.state.transaction((tx) => f.code.baseStatus(f.admin, waiter.id, tx));
  assert.equal(status.status, 'ready', JSON.stringify(status));
});
