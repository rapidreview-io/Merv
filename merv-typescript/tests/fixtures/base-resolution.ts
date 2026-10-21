import { CodeService as CoreCodeService } from '@merv/code/service';
import { pendingMerge, verifyResolution } from '../../packages/code/src/pending-merge.js';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createService, type Caller, type Transaction } from '@merv/contracts';
import type { WorkflowSnapshot } from '@merv/workflows/models';
import { CodeService } from '@merv/code-work/service';
import { CodeRepositories } from '@merv/code/store/repository';
import type { CodeCapture } from '@merv/code-work/types';
import { CodeBaseService } from '../../packages/code-work/src/bases.js';
import type { CodeUnitService } from '../../packages/code-work/src/units.js';
import { seededSource } from './code-store.js';
import { resolutionFixture } from './resolution.js';
import { assessment as reviewAssessment } from './review-verdict.js';
import { boundProject } from './code-binding.js';
import { fixtureThread } from './threads.js';

/**
 * A hosted project with three accepted inputs on one main: A and C clash on f.txt, D touches
 * g.txt. The test drives its own base worker, whose Git it watches never run in a transaction.
 */
export async function baseResolutionFixture(
  t: TestContext,
  human = false,
  options: { mainLanding?: boolean } = {},
) {
  const f = await resolutionFixture(t, { human });
  await f.sessions.dispatch.setDispatch(f.admin, { enabled: true });
  const root = join(f.directory, 'code');
  const core = await createService(
    new CoreCodeService(f.state, f.scope, {
      repositories: { root, quotaBytes: 1024 ** 3, reservedFreeBytes: 1 },
    }),
  );
  const code = await createService(
    new CodeService(f.state, f.scope, f.sessions, f.workflows, f.reviews, core, {}, options),
  );
  const units = (code as unknown as { unitStore: CodeUnitService }).unitStore;
  // These tests drive their own base worker, whose Git they watch: Code's own one stops.
  await units.bases.close();
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
    changed: (tx, projectId) => units.changed(tx, projectId),
    sponsors: (tx, projectId) => units.baseSponsors(tx, projectId),
    serviceWork: f.sessions.serviceWork,
    resolved: async () => {},
  });
  await bases.initialize();
  units.bases = bases;
  const unbind = f.bindCode(code);
  const inputAuthor = {
    projectId: f.admin.projectId,
    actorId: (
      await f.scope.credentials.issueActor(f.admin, { name: 'Input author', role: 'operator' })
    ).actor.id,
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
        "INSERT INTO worker_sessions(id,project_id,actor_id,thread_id,instance_id,revision,owner_hash,runner_id,request_id,token_hash,fingerprint,status,session_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,'released',?)",
        id,
        f.admin.projectId,
        actorId,
        await fixtureThread(tx, f.admin.projectId, actorId),
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
  const {
    source,
    value: { main, a, c, d },
  } = seededSource(t, 'code-base-resolution', (source) => {
    const main = source.commit({ 'f.txt': 'base\n', 'g.txt': 'base\n' });
    const a = source.commit({ 'f.txt': 'A\n' });
    source.git('checkout', '--detach', main);
    const c = source.commit({ 'f.txt': 'C\n' });
    source.git('checkout', '--detach', main);
    const d = source.commit({ 'g.txt': 'D\n' });
    return { main, a, c, d };
  });
  const bare = repositories.paths(f.admin.projectId).repository;
  source.git(
    'push',
    bare,
    ...Object.entries({ main, a, c, d }).map(([name, commit]) => `${commit}:refs/heads/${name}`),
  );
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
        "UPDATE code_workspaces SET generation=CASE WHEN generation=0 THEN 1 ELSE generation END,writer_state=CASE WHEN generation=0 THEN 'closed' ELSE writer_state END,head_oid=? WHERE project_id=? AND unit_id=?",
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
      // Fixture inputs are retained in the real repository; the closed writer generation and
      // its upload journal stand for Code having admitted the reviewed commit.
      await tx.run(
        "INSERT INTO code_workspaces(project_id,unit_id,declared_at,generation,writer_state) VALUES (?,?,'now',1,'closed') ON CONFLICT(project_id,unit_id) DO UPDATE SET generation=CASE WHEN code_workspaces.generation=0 THEN 1 ELSE code_workspaces.generation END,writer_state=CASE WHEN code_workspaces.generation=0 THEN 'closed' ELSE code_workspaces.writer_state END",
        f.admin.projectId,
        work.id,
      );
      if (
        !(await tx.get(
          "SELECT id FROM code_operations WHERE project_id=? AND unit_id=? AND kind='upload' AND status='completed' AND result_json::jsonb->>'head'=?",
          f.admin.projectId,
          work.id,
          commit,
        ))
      )
        await tx.run(
          "INSERT INTO code_operations(id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at,unit_id) VALUES (?,?,'fixture',?,'upload','hash','{}','completed',?,'now','now',?)",
          commandId,
          f.admin.projectId,
          commandId,
          JSON.stringify({ head: commit }),
          work.id,
        );
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
  const record = (members = [a, c]) =>
    f.state.read((sql) => bases.find(sql, f.admin.projectId, members));
  const resolveCommit = async (members?: string[]) => {
    const base = (await record(members))!;
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
  const acceptResolution = async (commit: string, members?: string[]) => {
    const taskId = (await record(members))!.resolutionTaskId!;
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
      ...reviewAssessment(claim),
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
    await core.close();
  });
  return {
    ...f,
    code,
    units,
    bases,
    source,
    main,
    bare,
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
    unsubscribe,
  };
}
