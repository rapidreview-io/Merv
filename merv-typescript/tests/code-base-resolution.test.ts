import { pendingMerge, verifyResolution } from '../packages/code/src/pending-merge.js';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdirSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  createService,
  type Caller,
  type WorkflowSnapshot,
  type Transaction,
} from '@merv/contracts';
import { CodeService } from '@merv/code/service';
import { CodeRepositories } from '@merv/code/store/repository';
import type { CodeCapture } from '@merv/code/types';
import type { SandboxCheckHandle } from '@merv/sandboxes';
import { enqueueMirror, CodeMirrorService } from '@merv/code/store/mirror';
import { CodeBaseService } from '../packages/code/src/bases.js';
import type { CodeUnitService } from '../packages/code/src/units.js';
import { backends, optional, gitSource, git, type Backend } from './fixtures/code-store.js';
import { resolutionFixture } from './fixtures/resolution.js';
import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';
import { boundProject } from './fixtures/code-binding.js';

async function fixture(t: TestContext, backend: Backend, human = false) {
  const f = await resolutionFixture(t, backend, { human });
  await f.sessions.setDispatch(f.admin, { enabled: true });
  const code = await createService(
    new CodeService(f.state, f.scope, f.sessions, f.artifacts, f.workflows),
  );
  const units = (code as unknown as { unitStore: CodeUnitService }).unitStore;
  const root = join(f.directory, 'code');
  // These tests exercise Git and database transactions, not the store's socket writer lock.
  mkdirSync(join(root, 'tmp'), { recursive: true });
  mkdirSync(join(root, 'empty-template'));
  const repositories = new CodeRepositories({ root, quotaBytes: 1024 ** 3, reservedFreeBytes: 1 });
  await repositories.ensure(f.admin.projectId, 'repository', 'sha1');
  const insideTransaction = new AsyncLocalStorage<boolean>();
  const transaction = f.state.transaction.bind(f.state);
  t.mock.method(f.state, 'transaction', (fn: (tx: Transaction) => Promise<unknown>) =>
    transaction((tx) => insideTransaction.run(true, () => fn(tx))),
  );
  const gitRun = repositories.git.run.bind(repositories.git);
  t.mock.method(repositories.git, 'run', (...args: Parameters<typeof gitRun>) => {
    assert.notEqual(
      insideTransaction.getStore(),
      true,
      'Git must run outside the write transaction',
    );
    return gitRun(...args);
  });
  const bases = new CodeBaseService(f.state, repositories, {
    changed: (tx, projectId) => units.imported(tx, projectId),
    sponsors: (tx, projectId, members) => units.baseSponsors(tx, projectId, members),
    serviceWork: f.sessions.serviceWork,
    resolved: (tx, id, key, commit) => enqueueMirror(tx, id, 'mirror-base', key, commit),
  });
  await bases.initialize();
  units.bases = bases;
  const unbind = f.tasks.bindCode(code);
  const unbindReviews = code.bindReviews(f.reviews);
  f.beforeClose.push(unbindReviews);
  const inputAuthor = {
    projectId: f.admin.projectId,
    actorId: (await f.scope.issueActor(f.admin, { name: 'Input author', role: 'operator' })).actor
      .id,
  };
  const producingSession = async (
    unitId: string,
    actorId = inputAuthor.actorId,
    authorityId = actorId,
    revision = 0,
  ) => {
    const id = `source-${randomBytes(8).toString('hex')}`;
    await f.state.transaction(async (tx) => {
      await tx.run(
        "INSERT INTO worker_sessions(id,project_id,actor_id,instance_id,revision,owner_hash,runner_id,request_id,token_hash,fingerprint,status,session_json) VALUES (?,?,?,?,?,?,?,?,?,?,'released',?)",
        id,
        f.admin.projectId,
        actorId,
        unitId,
        revision,
        id,
        id,
        id,
        id,
        id,
        JSON.stringify({
          id,
          projectId: f.admin.projectId,
          actorId,
          instanceId: unitId,
          expectedRevision: revision,
          status: 'released',
          source: { actorId: authorityId },
          execution: { policy: { readOnly: false } },
        }),
      );
    });
    return id;
  };
  const unsubscribe = await f.events.subscribe({
    id: 'code.reconcile.v1',
    types: ['workflow.transition'],
    from: 'now',
    handle: (event, tx) => code.transitioned(event, tx),
  });
  const source = gitSource(t);
  const main = source.commit({ 'f.txt': 'base\n', 'g.txt': 'base\n' });
  const a = source.commit({ 'f.txt': 'A\n' });
  source.git('checkout', '--detach', main);
  const c = source.commit({ 'f.txt': 'C\n' });
  source.git('checkout', '--detach', main);
  const d = source.commit({ 'g.txt': 'D\n' });
  const bare = repositories.paths(f.admin.projectId).repository;
  for (const [name, commit] of Object.entries({ main, a, c, d }))
    source.git('push', bare, `${commit}:refs/heads/${name}`);
  await boundProject(f.state, f.admin.projectId, main, 'repository');
  await f.state.transaction(async (tx) => {
    await tx.run(
      'UPDATE code_projects SET store_json=?,main_json=? WHERE project_id=?',
      JSON.stringify({ format: 1, objectFormat: 'sha1', rootOid: main }),
      JSON.stringify({ oid: main, operationId: 'fixture', stored: true }),
      f.admin.projectId,
    );
  });
  const handle = await f.workflows.register(
    {
      name: 'input',
      version: 1,
      managed: true,
      initial: 'working',
      states: ['working', 'done'],
      terminal: ['done'],
      edges: [{ from: 'working', action: 'accept', to: 'done' }],
    },
    {
      successStates: ['done'],
      actions: [
        {
          name: 'accept',
          tool: 'input.accept',
          instruction: 'Accept.',
          states: ['working'],
          transitions: ['accept'],
          check: () => {},
        },
      ],
    },
  );
  let sequence = 0;
  const captures = new Map<string, CodeCapture>();
  const originalCapture = code.capture.bind(code);
  t.mock.method(
    code,
    'capture',
    async (
      _caller: Caller,
      ref: Parameters<CodeService['capture']>[1],
      tx?: Parameters<CodeService['capture']>[2],
    ) => {
      if (ref.kind !== 'code-commit') return await originalCapture(_caller, ref, tx);
      const capture = captures.get(ref.commandId!);
      assert.ok(capture, 'the fixture must supply an immutable accepted capture');
      return capture;
    },
  );
  const admission = async (taskId: string, commit: string, id: string) => {
    const pending = await f.state.read((sql) => pendingMerge(sql, f.admin.projectId, taskId));
    assert.ok(pending);
    const proof = await verifyResolution(
      repositories.git,
      repositories.environment(f.admin.projectId),
      pending.firstParent,
      pending.secondParent,
      commit,
    );
    assert.equal(proof.error, null);
    const merge = {
      plan: pending.plan,
      left: pending.firstParent,
      right: pending.secondParent,
      firstMerge: proof.firstMerge,
    };
    await f.state.transaction(async (tx) => {
      await tx.run(
        "UPDATE code_units SET generation=CASE WHEN generation=0 THEN 1 ELSE generation END,writer_state=CASE WHEN generation=0 THEN 'closed' ELSE writer_state END,head_oid=? WHERE project_id=? AND unit_id=?",
        commit,
        f.admin.projectId,
        taskId,
      );
      await tx.run(
        'UPDATE code_pending_merges SET head_oid=?,first_merge=? WHERE project_id=? AND unit_id=?',
        commit,
        proof.firstMerge,
        f.admin.projectId,
        taskId,
      );
      await tx.run(
        "INSERT INTO code_operations(id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at,unit_id) VALUES (?,?,'fixture',?,'upload','hash','{}','completed',?,'now','now',?)",
        id,
        f.admin.projectId,
        id,
        JSON.stringify({ head: commit, merge }),
        taskId,
      );
    });
  };
  const accept = async (
    work: WorkflowSnapshot,
    commit: string,
    reviewRef = `review-${work.id}`,
  ) => {
    const commandId = `accepted-${work.id}`;
    captures.set(commandId, {
      ref: { kind: 'code-commit', commandId },
      status: 'ready',
      provenance: {
        projectId: f.admin.projectId,
        instanceId: work.id,
        readOnly: false,
      } as CodeCapture['provenance'],
      workspace: {
        repositoryId: 'repository',
        workspaceId: work.id,
        mode: 'persistent',
        branch: null,
        baseOid: main,
        headOid: commit,
        stats: { commitCount: 1, filesChanged: 1, insertions: 1, deletions: 1 },
      },
      observedAt: 'now',
      eventId: null,
    });
    await f.state.transaction(async (tx) => {
      await code.acceptUnit(
        f.admin,
        {
          unitId: work.id,
          terminalRevision: work.revision,
          submissionRef:
            (
              await tx.get<{ snapshot_hash: string }>(
                'SELECT snapshot_hash FROM reviews WHERE id=?',
                reviewRef,
              )
            )?.snapshot_hash ?? commandId,
          reviewRef,
          codeRef: { kind: 'code-commit', commandId },
          reviewSessionId: null,
        },
        tx,
      );
      // Fixture inputs are retained in the real repository, in place of an upload journal.
      await tx.run(
        "INSERT INTO code_operations(id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at) VALUES (?,?,'fixture',?,'import','hash','{}','completed',?,'now','now')",
        commandId,
        f.admin.projectId,
        commandId,
        JSON.stringify({ head: commit }),
      );
    });
  };
  const input = async (name: string, commit: string, producer = inputAuthor) => {
    const requestId = `input-${++sequence}`;
    let work = await handle.start(f.admin, {
      workflow: 'input',
      requestId,
      data: { title: name, goal: `Implement ${name}` },
    });
    work = await handle.transition(f.admin, {
      instanceId: work.id,
      action: 'accept',
      expectedRevision: 0,
      requestId: `${requestId}-accept`,
    });
    await producingSession(work.id, producer.actorId);
    await accept(work, commit);
    return work;
  };
  const left = await input('A', a),
    right = await input('C', c),
    extra = await input('D', d);
  const waiter = (inputs = [left, right]) =>
    f.tasks.create(f.admin, {
      title: `Waiter ${++sequence}`,
      goal: 'Build on the accepted inputs.',
      checks: ['The result works.'],
      workspace: 'git',
      dependsOn: inputs.map((item) => item.id),
      requestId: `waiter-${sequence}`,
    });
  const record = () => f.state.read((sql) => bases.find(sql, f.admin.projectId, [a, c]));
  const resolveCommit = async () => {
    const base = (await record())!;
    const [plannedLeft, plannedRight] = await f.state.read((sql) =>
      bases.inputs(sql, f.admin.projectId, base),
    );
    const tree = source.git('rev-parse', `${a}^{tree}`);
    const commit = source.git(
      'commit-tree',
      tree,
      '-p',
      plannedLeft!,
      '-p',
      plannedRight!,
      '-m',
      'Resolve conflict',
    );
    source.git('push', bare, `${commit}:refs/heads/resolved`);
    return commit;
  };
  const requestReview = async (taskId: string, subjectRevision = 1, producer = inputAuthor) => {
    const output = await f.artifacts.create(producer, {
      title: 'Resolution',
      content: 'Verified resolution evidence.',
    });
    return f.reviews.request(producer, {
      subjectId: taskId,
      subjectRevision,
      producerId: producer.actorId,
      artifactIds: [output.id],
      criteria: ['The resolution is correct.'],
      provenanceOwner: 'code',
      requestId: `resolution-${taskId}`,
    });
  };
  const acceptResolution = async (commit: string) => {
    const taskId = (await record())!.resolutionTaskId!;
    // The owner-review protocol is tested in task-git-workspace; here its committed terminal
    // state is the boundary and acceptUnit still checks and records the capture itself.
    await f.state.transaction((tx) =>
      tx
        .run("UPDATE wf_instances SET state='done',revision=revision+1 WHERE id=?", taskId)
        .then(() => undefined),
    );
    await admission(taskId, commit, `admitted-${taskId}`);
    await producingSession(taskId);
    const request = await requestReview(taskId, 0);
    const claim = await f.reviews.start(f.admin, request.id);
    await f.reviews.submit(f.admin, {
      reviewId: request.id,
      claimId: claim.claimId!,
      verdict: 'pass',
      notes: 'Verified.',
      requestId: `pass-${taskId}`,
    });
    await accept(await f.workflows.get(f.admin, taskId), commit, request.id);
    await code.reconcileAll();
    await bases.work(f.admin.projectId);
  };
  f.beforeClose.push(async () => {
    await unsubscribe();
    unbind();
    await bases.close();
    await code.close();
  });
  return {
    ...f,
    code,
    units,
    bases,
    source,
    a,
    c,
    d,
    left,
    right,
    extra,
    waiter,
    record,
    resolveCommit,
    acceptResolution,
    requestReview,
    accept,
    admission,
    repositories,
    captures,
    inputAuthor,
    producingSession,
    handle,
    input,
    unbind,
    unbindReviews,
    unsubscribe,
  };
}

for (const backend of backends) {
  test(
    `${backend}: Code refuses acceptance when another unit accepts a member commit after the review was pinned`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
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
    },
  );

  test(
    `${backend}: frozen-plan provenance excludes indirect authors, authorities and every earlier resolution round`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const issue = async (name: string) => ({
        projectId: f.admin.projectId,
        actorId: (await f.scope.issueActor(f.admin, { name, role: 'operator' })).actor.id,
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
        requestId: 'pass',
      };
      assert.equal((await f.reviews.submit(f.admin, verdict)).verdict, 'pass');
      assert.equal(
        (await f.reviews.submit(f.admin, verdict)).provenance?.hash,
        request.provenance?.hash,
      );
    },
  );

  test(
    `${backend}: every reviewer excluded is visible on the resolution task and pinned reviews survive Code unload`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
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
      f.unbind();
      f.unbindReviews();
      await assert.rejects(f.reviews.start(f.admin, request.id), { code: 'review_independence' });
      const independent = {
        projectId: f.admin.projectId,
        actorId: (await f.scope.issueActor(f.admin, { name: 'Independent', role: 'reviewer' }))
          .actor.id,
      };
      const certifiedClaim = await f.reviews.start(independent, request.id);
      assert.equal(
        (
          await f.reviews.submit(independent, {
            reviewId: request.id,
            claimId: certifiedClaim.claimId!,
            verdict: 'pass',
            notes: 'Checked',
            requestId: 'certified-pass',
          })
        ).verdict,
        'pass',
      );
    },
  );

  test(
    `${backend}: a resolution title names the contributing work on an intermediate union with bounded sides`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
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
      assert.ok(task.goal.includes('Implement D'));
      assert.deepEqual(
        (await f.workflows.dependencies(f.admin, waiter.id)).dependencies
          .filter((edge) => edge.kind === 'system')
          .map((edge) => edge.id),
        [task.id],
      );
    },
  );

  test(
    `${backend}: an open conflict and unchanged reconciles queue no work or prerequisite receipts`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const count = () =>
        f.state.read(async (sql) =>
          Number(
            (await sql.get<{ count: number | string }>(
              'SELECT COUNT(*) AS count FROM wf_system_requests',
            ))!.count,
          ),
        );
      const ordinary = await f.waiter([f.left]);
      for (let i = 0; i < 3; i++) await f.code.reconcileAll();
      assert.equal(await count(), 0);
      await f.waiter();
      await f.bases.work(f.admin.projectId);
      assert.deepEqual(await f.bases.due(), []);
      const receipts = await count();
      assert.equal(receipts, 1);
      for (let i = 0; i < 4; i++) {
        await f.state.transaction((tx) =>
          tx.run('UPDATE wf_instances SET revision=revision+1 WHERE id=?', ordinary.id),
        );
        await f.code.reconcileAll();
        assert.deepEqual(await f.bases.due(), []);
      }
      assert.equal(await count(), receipts);
    },
  );

  test(
    `${backend}: accepted resolution verification runs outside transactions and recovers after creating its ref`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
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
        changed: (tx, projectId) => f.units.imported(tx, projectId),
        sponsors: (tx, projectId, members) => f.units.baseSponsors(tx, projectId, members),
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
    },
  );

  test(
    `${backend}: Git failing to read a resolution lineage is not a verdict on the resolution`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
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
      await f.state.transaction((tx) =>
        f.bases.recordAcceptance(tx, f.admin.projectId, base, commit),
      );
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
    },
  );

  test(
    `${backend}: Code unload preserves an existing system prerequisite and blocker while workspace-free work proceeds`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
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
        decision.dependencies.some(
          (edge) => edge.id === id && edge.kind === 'system' && !edge.settled,
        ),
      );
      assert.deepEqual(await f.workflows.blockers(f.admin, waiter.id), blockers);
      assert.ok(
        decision.providerBlockers.some((blocker) =>
          blocker.related.some((record) => record.id === id),
        ),
      );
      assert.ok(
        (await f.sessions.stuck(f.admin)).items.some((item) => item.instanceId === waiter.id),
      );
      await assert.rejects(f.workflows.checkDependencies(f.admin, waiter.id), {
        code: 'dependencies_pending',
      });
      const note = await f.tasks.create(f.admin, {
        title: 'Note',
        goal: 'Write a note.',
        checks: ['The note exists.'],
        requestId: 'unloaded-note',
      });
      assert.equal(note.workflow.version, 2);
      assert.equal(
        await f.workflows.leaseRole(f.admin, { instanceId: note.id, expectedRevision: 0 }),
        'producer',
      );
      assert.deepEqual((await f.workflows.evaluate(f.admin, note.id)).blockers, []);
    },
  );
  test(
    `${backend}: one resolution task serves concurrent, indirect, and future waiters`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
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
      assert.equal(task.workflow.version, 6);
      assert.match(task.title, /^Merge ‘[AC]’ with ‘[AC]’$/);
      assert.ok(!task.title.includes(base.key.slice(0, 12)));
      assert.match(task.goal, /Implement A/);
      assert.match(task.goal, /Implement C/);
      assert.match(task.goal, /f.txt/);
      const [left] = await f.state.read((sql) => f.bases.inputs(sql, f.admin.projectId, base));
      const status = await f.state.transaction((tx) => f.code.baseStatus(f.admin, task.id, tx));
      assert.equal(status.status, 'ready');
      const superset = await f.waiter([f.left, f.right, f.extra]);
      for (const waiter of [...waiters, superset]) {
        const edges = (await f.workflows.dependencies(f.admin, waiter.id)).dependencies;
        assert.deepEqual(
          edges.filter((edge) => edge.kind === 'system').map((edge) => edge.id),
          [task.id],
        );
        await assert.rejects(f.workflows.checkDependencies(f.admin, waiter.id), {
          code: 'dependencies_pending',
        });
        const blockers = await f.workflows.blockers(f.admin, waiter.id);
        assert.ok(
          blockers.some(
            (blocker) =>
              blocker.related.some((record) => record.id === task.id) &&
              blocker.message.includes('in_progress'),
          ),
        );
      }
      const stuck = await f.sessions.stuck(f.admin);
      assert.ok(
        stuck.items.some((item) => item.instanceId === waiters[0].id && item.why.includes(task.id)),
      );
      for (let i = 0; i < 3; i++) await f.code.reconcileAll();
      assert.equal(
        (await f.tasks.list(f.admin)).filter((item) => item.workflow.version === 6).length,
        1,
      );
      const pin = await f.state.transaction((tx) =>
        f.code.pinBase(f.admin, { unitId: task.id, leaseId: 'resolution-pin' }, tx),
      );
      assert.equal(pin.reference, left);
      const resolved = await f.resolveCommit();
      await f.acceptResolution(resolved);
      assert.equal((await f.record())!.result?.method, 'task');
      assert.equal((await f.record())!.result?.commit, resolved);
      const future = await f.waiter();
      for (const waiter of [...waiters, future]) {
        await f.workflows.checkDependencies(f.admin, waiter.id);
        const pinned = await f.state.transaction((tx) =>
          f.code.pinBase(f.admin, { unitId: waiter.id, leaseId: waiter.id }, tx),
        );
        assert.equal(pinned.reference, resolved);
        assert.equal(pinned.kind, 'merged');
        assert.deepEqual(
          pinned.sources.map((item) => item.unitId).sort(),
          [f.left.id, f.right.id].sort(),
        );
        assert.equal(
          (await f.workflows.dependencies(f.admin, waiter.id)).dependencies.filter(
            (edge) => edge.kind === 'system',
          ).length,
          1,
        );
      }
      const combined = await f.state.transaction((tx) =>
        f.code.pinBase(f.admin, { unitId: superset.id, leaseId: superset.id }, tx),
      );
      for (const input of [resolved, f.d])
        assert.equal(
          (
            await f.repositories.git.run(
              ['merge-base', '--is-ancestor', input, combined.reference],
              { env: f.repositories.environment(f.admin.projectId) },
            )
          ).code,
          0,
        );
      assert.equal(
        (await f.tasks.list(f.admin)).filter((item) => item.workflow.version === 6).length,
        1,
      );
    },
  );

  test(
    `${backend}: conflict recovery creates and links the task atomically`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const provider = f.units.resolutionTasks!;
      f.units.resolutionTasks = undefined;
      const waiter = await f.waiter();
      await f.bases.work(f.admin.projectId);
      assert.equal((await f.record())!.state, 'awaiting_resolution');
      assert.equal((await f.record())!.resolutionTaskId, null);
      f.units.resolutionTasks = {
        create: async (input, tx) => {
          await provider.create(input, tx);
          throw new Error('Crash before linkage');
        },
      };
      await assert.rejects(f.code.reconcileAll(), /Crash before linkage/);
      assert.equal(
        (await f.tasks.list(f.admin)).filter((item) => item.workflow.version === 6).length,
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
        (await f.tasks.list(f.admin)).filter((item) => item.workflow.version === 6).length,
        1,
      );
      assert.equal(
        (await f.workflows.dependencies(f.admin, waiter.id)).dependencies.filter(
          (item) => item.kind === 'system',
        )[0].id,
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
    },
  );

  test(
    `${backend}: derivation ignores a system edge below a code-less success`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
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
            requestId: 'bridge-system',
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
        (await f.workflows.dependencies(f.admin, waiter.id)).dependencies.filter(
          (edge) => edge.kind === 'system',
        )[0].id,
        resolutionId,
      );
      assert.equal(
        (await f.state.read((sql) => f.bases.records(sql, f.admin.projectId))).length,
        1,
      );
    },
  );

  test(
    `${backend}: an accepted resolution missing an input never seals or replaces its task`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
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
          f.code.pinBase(f.admin, { unitId: waiter.id, leaseId: 'bad' }, tx),
        ),
        { code: 'code_merge_conflict' },
      );
    },
  );

  test(
    `${backend}: three resolution rounds retain one task, carry all feedback and suspend until a human extends the limit`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend, true);
      const waiter = await f.waiter();
      await f.bases.work(f.admin.projectId);
      const taskId = (await f.record())!.resolutionTaskId!;
      const commit = await f.resolveCommit();
      const identity = await f.scope.issueActor(f.admin, {
        name: 'Resolution worker machine',
        role: 'producer',
      });
      const runner = {
        projectId: f.admin.projectId,
        actorId: identity.actor.id,
        credentialId: identity.credential.id,
      };
      await f.sessions.heartbeatRunner(runner, {
        runnerId: 'round-runner',
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
            workflow: { name: 'task', version: 6, state: 'in_progress' },
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
        const submitted = await f.sessions.run(
          await f.sessions.prepare(worker, 'task.submit_delivery', delivery),
          (caller) => f.tasks.submitDelivery(caller, delivery),
        );
        submissions.push(submitted.deliveryCodeArtifactId!);
        const review = await f.reviews.start(f.admin, submitted.reviewId!);
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
        const returned = await f.tasks.submitReview(f.admin, assessment);
        assert.equal(returned.workflow.state, round === 3 ? 'suspended' : 'in_progress');
        await f.sessions.release(runner, { sessionId: session.id, runnerId: 'round-runner' });
        await f.events.drain();
        // The fixture plays the final handoff; real final capture is exercised by the driver tests.
        await f.state.transaction((tx) =>
          tx.run("UPDATE code_units SET writer_state='closed' WHERE unit_id=?", taskId),
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
      assert.ok(
        (await f.sessions.stuck(f.admin)).items.some(
          (item) => item.instanceId === waiter.id && item.why.includes('suspended'),
        ),
      );
      const grant = {
        instanceId: taskId,
        limit: 'review_rounds',
        additional: 1,
        reason: 'One more correction',
        requestId: 'extend',
      };
      await assert.rejects(f.workflows.extendLimit(runner, grant), { code: 'forbidden' });
      const machineAdmin = await f.scope.issueActor(f.admin, {
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

      await f.workflows.extendLimit(f.admin, grant);
      const resumed = await f.tasks.get(f.admin, taskId);
      assert.equal(resumed.workflow.state, 'in_progress');
      assert.deepEqual(resumed.workflow.data.rejectedReviewIds, ids);
      await f.workflows.extendLimit(f.admin, grant);
      assert.equal(
        (await f.tasks.get(f.admin, taskId)).workflow.revision,
        resumed.workflow.revision,
      );
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
        (await f.tasks.list(f.admin)).filter((task) => task.workflow.version === 6).length,
        1,
      );
      const stopped = await f.tasks.markFailed(f.admin, {
        taskId,
        expectedRevision: resumed.workflow.revision,
        requestId: 'suspend-again',
        reason: 'The next round was abandoned before submission.',
      });
      assert.equal(stopped.workflow.state, 'suspended');
      await f.workflows.extendLimit(f.admin, { ...grant, requestId: 'resume-again' });
      const continued = await f.tasks.get(f.admin, taskId);
      assert.equal(continued.workflow.state, 'in_progress');
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
    },
  );

  for (const shape of ['single parent', 'different second parent'] as const)
    test(
      `${backend}: ${shape} cannot seal a resolution and the refusal remains visible`,
      optional(backend),
      async (t) => {
        const f = await fixture(t, backend);
        const waiter = await f.waiter();
        await f.bases.work(f.admin.projectId);
        const base = (await f.record())!;
        const [left, right] = await f.state.read((sql) =>
          f.bases.inputs(sql, f.admin.projectId, base),
        );
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
        await f.state.transaction((tx) =>
          f.bases.recordAcceptance(tx, f.admin.projectId, base, head),
        );
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
      },
    );

  for (const verdict of ['pass', 'needs_changes', 'fail'] as const)
    test(
      `${backend}: service resolution uses the existing independent review path (${verdict})`,
      optional(backend),
      async (t) => {
        const f = await fixture(t, backend, true);
        await f.waiter();
        await f.bases.work(f.admin.projectId);
        const id = (await f.record())!.resolutionTaskId!;
        const task = await f.tasks.get(f.admin, id);
        const commit = await f.resolveCommit();
        const issued = await f.scope.issueActor(f.admin, {
          name: 'Producer runner',
          role: 'producer',
        });
        const runner = {
          projectId: f.admin.projectId,
          actorId: issued.actor.id,
          credentialId: issued.credential.id,
        };
        await f.sessions.heartbeatRunner(runner, {
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
        const base = (await f.state.transaction((tx) => f.code.basePin(f.admin, id, tx)))!
          .reference;
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
            workflow: { name: 'task', version: 6, state: 'in_progress' },
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
        const pending = await f.sessions.run(
          await f.sessions.prepare(worker, 'task.submit_delivery', delivery),
          (caller) => f.tasks.submitDelivery(caller, delivery),
        );
        const review = await f.reviews.get(f.admin, pending.reviewId!);
        assert.ok(review.excludedActorIds?.includes(task.producerId));
        assert.ok(review.excludedActorIds?.includes(runner.actorId));
        await assert.rejects(f.reviews.start(runner, review.id));
        await f.sessions.release(runner, { sessionId: session.id, runnerId: 'runner' });
        const reviewerIdentity = await f.scope.issueActor(f.admin, {
          name: 'Independent review runner',
          role: 'operator',
        });
        const reviewer = {
          projectId: f.admin.projectId,
          actorId: reviewerIdentity.actor.id,
          credentialId: reviewerIdentity.credential.id,
        };
        await f.sessions.heartbeatRunner(reviewer, {
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
        const result = await f.sessions.run(
          await f.sessions.prepare(reviewWorker, 'review.submit', assessment),
          (caller) => f.tasks.submitReview(caller, assessment),
        );
        assert.equal(
          result.workflow.state,
          verdict === 'pass' ? 'done' : verdict === 'fail' ? 'suspended' : 'in_progress',
        );
        await f.events.drain();
        if (verdict === 'needs_changes') {
          const [future] = await Promise.all([
            f.waiter(),
            f.code.reconcileAll(),
            f.code.reconcileAll(),
          ]);
          assert.equal((await f.tasks.get(f.admin, id)).workflow.state, 'in_progress');
          assert.deepEqual(
            (await f.workflows.dependencies(f.admin, future.id)).dependencies
              .filter((edge) => edge.kind === 'system')
              .map((edge) => edge.id),
            [id],
          );
        }
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
          (await f.tasks.list(f.admin)).filter((item) => item.workflow.version === 6).length,
          1,
        );
      },
    );

  test(
    `${backend}: project writers lease a service task as producers and mark_failed suspends a non-failing prerequisite`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
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

      await assert.rejects(f.scope.issueActorCredential(f.admin, { actorId: owner.actorId }), {
        code: 'member_actor',
      });
      const producer = await f.scope.issueActor(f.admin, { name: 'Runner', role: 'producer' });
      const runner = {
        projectId: f.admin.projectId,
        actorId: producer.actor.id,
        credentialId: producer.credential.id,
      };
      assert.equal(
        await f.workflows.leaseRole(runner, { instanceId: task.id, expectedRevision: 0 }),
        'producer',
      );
      await f.sessions.heartbeatRunner(runner, {
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
        await assert.rejects(f.sessions.prepare(worker, tool, {}));
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
    },
  );
}

for (const backend of backends) {
  test(
    `${backend}: base operator controls retain history, deny workers, and explain each disposition to waiters`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      t.mock.method(f.bases, 'soon', () => {});
      const waiter = await f.waiter();
      const key = (await f.record())!.key;
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
      const resolutionStatus = await f.state.transaction((tx) =>
        f.code.baseStatus(f.admin, task!, tx),
      );
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
      blocker = (await f.workflows.blockers(f.admin, waiter.id))[0]!;
      assert.equal(blocker.code, 'code_quarantined');
      const history = await f.state.read((sql) =>
        sql.all<{ payload_json: string }>(
          "SELECT payload_json FROM code_operations WHERE project_id=? AND kind='base-control' ORDER BY created_at,id",
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
    },
  );
  test(
    `${backend}: a base that merged cleanly and failed its check is briefed as that, not as a conflict`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      await f.state.transaction((tx) =>
        tx.run(
          'UPDATE code_projects SET limits_json=? WHERE project_id=?',
          JSON.stringify({
            format: 1,
            denyGlobs: [],
            secretExemptGlobs: [],
            check: {
              command: 'make test',
              timeoutSeconds: 600,
              image: { provider: 'thunder_compute', offerId: 'a6000_x1:thunder', snapshotId: null },
            },
          }),
          f.admin.projectId,
        ),
      );
      const isolation: SandboxCheckHandle['isolation'] = {
        network: 'on',
        sourceReadOnly: false,
        imagePinned: 'offer',
        facts: [],
      };
      const handle: SandboxCheckHandle = {
        sandboxId: 'sbx_1',
        jobId: null,
        objectId: 'obj_1',
        restoreJobId: null,
        sha256: 'a'.repeat(64),
        ready: false,
        environment: null,
        isolation,
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
          result: { exit: 7, bytes: 13, head: 'FAIL test_one', tail: '' },
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
    },
  );
  test(
    `${backend}: a resolved base reaches the existing mirror journal and an outage never changes it or its waiters`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
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
      assert.equal((await mirror.describe(f.admin.projectId)).pending, 0);
      const operations = await f.state.read((sql) =>
        sql.all<{ status: string }>("SELECT status FROM code_operations WHERE kind='mirror-base'"),
      );
      assert.deepEqual(
        operations.map((row) => row.status),
        ['completed'],
      );
    },
  );
}

for (const backend of backends)
  test(
    `${backend}: budget admission reaches the stuck report and consumes neither launch holds nor review rounds`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
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
      assert.equal(blockers[0]!.code, 'code_base_admission');
      const stuck = await f.sessions.stuck(f.admin);
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
    },
  );
