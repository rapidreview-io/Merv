import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import test, { type TestContext } from 'node:test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  createService,
  digest,
  type Caller,
  type Data,
  type WorkflowSnapshot,
} from '@merv/contracts';
import { CodeService } from '@merv/code/service';
import { CodeConsolidation } from '../packages/code/src/consolidation.js';
import { CodeRepositories } from '@merv/code/store/repository';
import type { CodeCapture, CodeCandidateDecision, CodeReconciliation } from '@merv/code/types';
import { ConsolidationService } from '@merv/consolidation';
import type {
  ConsolidationCreate,
  ConsolidationRecord,
  ConsolidationSubmit,
} from '@merv/consolidation/types';
import { backends, optional, gitSource, git, type Backend } from './fixtures/code-store.js';
import { resolutionFixture } from './fixtures/resolution.js';
import { boundProject } from './fixtures/code-binding.js';
import { CodeBaseService } from '../packages/code/src/bases.js';
import type { CodeUnitService } from '../packages/code/src/units.js';
import { enqueueMirror } from '@merv/code/store/mirror';
import { pendingMerge, verifyResolution } from '../packages/code/src/pending-merge.js';

async function fixture(t: TestContext, backend: Backend, historyLength = 0) {
  const f = await resolutionFixture(t, backend);
  await f.sessions.setDispatch(f.admin, { enabled: true });
  const code = await createService(
    new CodeService(f.state, f.scope, f.sessions, f.artifacts, f.workflows),
  );
  const root = join(f.directory, 'code');
  mkdirSync(join(root, 'tmp'), { recursive: true });
  mkdirSync(join(root, 'empty-template'));
  const repositories = new CodeRepositories({ root, quotaBytes: 1024 ** 3, reservedFreeBytes: 1 });
  await repositories.ensure(f.admin.projectId, 'repository', 'sha1');
  // The real candidate service needs Git reads, not the transport's socket writer lock.
  (code as unknown as { consolidationStore: CodeConsolidation }).consolidationStore =
    new CodeConsolidation(
      f.state,
      f.scope,
      f.workflows,
      f.sessions,
      () => repositories,
      () => bases,
    );
  const units = (code as unknown as { unitStore: CodeUnitService }).unitStore;
  const bases = new CodeBaseService(f.state, repositories, {
    changed: (tx, projectId) => units.imported(tx, projectId),
    sponsors: (tx, projectId, members) => units.baseSponsors(tx, projectId, members),
    serviceWork: f.sessions.serviceWork,
    resolved: (tx, id, key, commit) => enqueueMirror(tx, id, 'mirror-base', key, commit),
  });
  await bases.initialize();
  units.bases = bases;
  f.beforeClose.push(f.tasks.bindCode(code), () => bases.close());
  const consolidation = await createService(
    new ConsolidationService(
      f.state,
      f.scope,
      f.artifacts,
      f.workflows,
      f.reviews,
      f.context,
      code,
    ),
  );
  const unbind = code.bindReviews(f.reviews);
  f.beforeClose.push(
    () => {
      consolidation.close();
      unbind();
      repositories.git.close();
    },
    () => code.close(),
  );
  const databaseScope = new AsyncLocalStorage<boolean>();
  const transaction = f.state.transaction.bind(f.state);
  t.mock.method(f.state, 'transaction', (fn: Parameters<typeof transaction>[0]) =>
    transaction((tx) => databaseScope.run(true, () => fn(tx))),
  );
  const read = f.state.read.bind(f.state);
  t.mock.method(f.state, 'read', (fn: Parameters<typeof read>[0]) =>
    read((sql) => databaseScope.run(true, () => fn(sql))),
  );
  const gitRun = repositories.git.run.bind(repositories.git);
  const walks: { args: string[]; input: unknown; commits: string[] }[] = [];
  let gitCalls = 0;
  t.mock.method(repositories.git, 'run', async (...args: Parameters<typeof gitRun>) => {
    assert.equal(databaseScope.getStore(), undefined, 'Git must never run in a database scope');
    gitCalls++;
    const result = await gitRun(...args);
    if (args[0][0] === 'rev-list')
      walks.push({
        args: args[0],
        input: args[1]?.input,
        commits: result.stdout
          .toString('utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => line.split(' ')[0]),
      });
    return result;
  });
  const source = gitSource(t);
  const history = Array.from({ length: historyLength }, (_, i) =>
    source.commit({ 'history.txt': String(i) }),
  );
  const main = source.commit({ 'main.txt': 'main' });
  const ancestor = source.commit({ 'ancestor.txt': 'ancestor' });
  const leaf = source.commit({ 'leaf.txt': 'leaf' });
  source.git('checkout', '--detach', main);
  const replacement = source.commit({ 'replacement.txt': 'replacement' });
  const bare = repositories.paths(f.admin.projectId).repository;
  for (const [name, commit] of Object.entries({ main, ancestor, leaf, replacement }))
    source.git('push', bare, `${commit}:refs/heads/${name}`);
  await boundProject(f.state, f.admin.projectId, main, 'repository');
  await f.state.transaction((tx) =>
    tx.run(
      'UPDATE code_projects SET store_json=?,main_json=? WHERE project_id=?',
      JSON.stringify({ format: 1, objectFormat: 'sha1', rootOid: main }),
      JSON.stringify({ oid: main, operationId: 'fixture', stored: true }),
      f.admin.projectId,
    ),
  );
  const actor = async (name: string, role: 'operator' | 'producer' | 'reviewer' = 'operator') => {
    const issued = await f.scope.issueActor(f.admin, { name, role });
    return {
      projectId: f.admin.projectId,
      actorId: issued.actor.id,
      credentialId: issued.credential.id,
    };
  };
  const producer = await actor('Consolidation producer', 'producer');
  const author = await actor('Candidate author');
  const authority = await actor('Candidate authority');
  const reviewer = await actor('Independent reviewer');
  let sequence = 0;
  const id = () => `request-${++sequence}`;
  const handles = new Map();
  for (const name of ['experiment', 'task']) {
    const version = name === 'task' ? 90 : 1;
    handles.set(
      name,
      await f.workflows.register(
        {
          name,
          version,
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
              tool: 'fixture.accept',
              instruction: 'Accept.',
              states: ['working'],
              transitions: ['accept'],
              check: () => {},
            },
          ],
        },
      ),
    );
  }
  const captures = new Map<string, CodeCapture>();
  const capture = code.capture.bind(code);
  t.mock.method(code, 'capture', async (...args: Parameters<typeof capture>) =>
    args[1].kind === 'code-commit' && captures.has(args[1].commandId)
      ? captures.get(args[1].commandId)!
      : capture(...args),
  );
  const contribution = async (
    unitId: string,
    actorId = author.actorId,
    authorityId = authority.actorId,
  ) => {
    const sessionId = id();
    await f.state.transaction((tx) =>
      tx.run(
        "INSERT INTO worker_sessions(id,project_id,actor_id,instance_id,revision,owner_hash,runner_id,request_id,token_hash,fingerprint,status,session_json) VALUES (?,?,?,?,0,?,?,?,?,?,'released',?)",
        sessionId,
        f.admin.projectId,
        actorId,
        unitId,
        sessionId,
        sessionId,
        sessionId,
        sessionId,
        sessionId,
        JSON.stringify({
          id: sessionId,
          projectId: f.admin.projectId,
          actorId,
          instanceId: unitId,
          expectedRevision: 0,
          status: 'released',
          source: { actorId: authorityId },
          execution: { policy: { readOnly: false } },
        }),
      ),
    );
  };
  const unit = async (
    name: 'task' | 'experiment',
    commit: string | null,
    dependsOn: string[] = [],
    accepted = true,
    caller: Caller = f.admin,
  ) => {
    const handle = handles.get(name)!;
    let work: WorkflowSnapshot = await handle.start(caller, {
      workflow: name,
      version: name === 'task' ? 90 : 1,
      dependsOn,
      requestId: id(),
    });
    if (!accepted) return work;
    work = await handle.transition(caller, {
      instanceId: work.id,
      expectedRevision: 0,
      action: 'accept',
      requestId: id(),
    });
    const commandId = id();
    if (commit)
      captures.set(commandId, {
        ref: { kind: 'code-commit', commandId },
        status: 'ready',
        provenance: {
          projectId: caller.projectId,
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
          stats: { commitCount: 1, filesChanged: 1, insertions: 1, deletions: 0 },
        },
        observedAt: 'now',
        eventId: null,
      });
    await f.state.transaction((tx) =>
      code.acceptUnit(
        caller,
        {
          unitId: work.id,
          terminalRevision: work.revision,
          submissionRef: commandId,
          reviewRef: id(),
          codeRef: commit ? { kind: 'code-commit', commandId } : null,
          reviewSessionId: null,
        },
        tx,
      ),
    );
    if (commit)
      await f.state.transaction((tx) =>
        tx.run(
          "INSERT INTO code_operations(id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at) VALUES (?,?,'fixture',?,'import','hash','{}','completed',?,'now','now')",
          commandId,
          caller.projectId,
          commandId,
          JSON.stringify({ head: commit }),
        ),
      );
    if (caller.projectId === f.admin.projectId) await contribution(work.id);
    return work;
  };
  const inputArtifact = await f.artifacts.create(f.admin, {
    title: 'Source',
    content: 'Frozen scientific conclusions.',
  });
  const create = (
    experimentIds: string[],
    taskIds: string[] = [],
    extra: Partial<ConsolidationCreate> = {},
  ) =>
    consolidation.create(producer, {
      version: 5,
      name: 'Consolidate',
      workspace: 'git',
      sourceArtifactIds: [inputArtifact.id],
      experimentIds,
      taskIds,
      requestId: id(),
      ...extra,
    });
  const inspect = (
    record: ConsolidationRecord,
    decisions: CodeCandidateDecision[],
    reconciliations: CodeReconciliation[] = [],
  ) => code.inspectCandidates(producer, record.candidates!, decisions, reconciliations);
  const run = <T>(
    caller: Caller,
    tool: string,
    input: Data,
    handler: (caller: Caller, input: Data) => Promise<T>,
  ) =>
    f.sessions.prepare(caller, tool, input).then((prepared) => f.sessions.run(prepared, handler));
  const decide = (
    record: ConsolidationRecord,
    decisions: CodeCandidateDecision[],
    reconciliations: CodeReconciliation[] = [],
    requestId = id(),
  ) =>
    consolidation.decide(producer, {
      consolidationId: record.id,
      expectedRevision: record.workflow.revision,
      decisions,
      reconciliations,
      requestId,
    });
  const heartbeat = (caller: Caller) =>
    f.sessions.heartbeatRunner(caller, {
      runnerId: 'test',
      machine: { hostname: 'fixture', system: 'test', architecture: 'test' },
      platforms: [{ name: 'codex', harness: 'codex', enabled: true, parallelism: 4 }],
      capacity: 4,
      capabilities: ['code.v2'],
    });
  const worker = async (record: ConsolidationRecord, head = leaf, director = producer) => {
    await heartbeat(director);
    const secret = `ms_${randomBytes(32).toString('base64url')}`;
    const session = await f.sessions.offer(director, {
      instanceId: record.id,
      expectedRevision: record.workflow.revision,
      runnerId: 'test',
      secret,
      requestId: id(),
    });
    const caller = await f.sessions.authenticate(secret);
    const base = (await code.unit(producer, record.id)).base!.reference;
    assert.ok((await code.unit(producer, record.id)).generation >= 1);
    const policy = session.execution.policy.workspace;
    assert.ok(policy && policy.mode === 'persistent');
    assert.equal(policy.driver, 'code.v2');
    const checkout = join(f.directory, id());
    git(f.directory, ['clone', '--no-checkout', bare, checkout]);
    git(checkout, ['checkout', '--detach', base]);
    assert.equal(git(checkout, ['rev-parse', 'HEAD']), base);
    const control = { sessionId: session.id, runnerId: 'test', hostRef: 'launch' };
    await f.sessions.attach(director, {
      ...control,
      workspace: {
        repositoryId: 'repository',
        workspaceId: record.id,
        mode: 'persistent',
        branch: 'codex/consolidation',
        baseOid: base,
        headOid: base,
        stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
      },
    });
    const operation = await run(
      caller,
      'code.commit',
      { expectedHead: base, message: 'Consolidated', requestId: id() },
      (caller, input) =>
        code.commit(caller, input as unknown as Parameters<CodeService['commit']>[1]),
    );
    const command = await code.nextCommand(director, control);
    assert.equal(command!.id, operation.command.id);
    // The fixture supplies the durable upload fact; the actual objects are in the real repository.
    await f.state.transaction((tx) =>
      tx.run(
        "INSERT INTO code_operations(id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at,unit_id) VALUES (?,?,?,?,'upload','hash','{}','completed',?,'now','now',?)",
        id(),
        producer.projectId,
        `session:${session.id}`,
        command!.id,
        JSON.stringify({ head }),
        record.id,
      ),
    );
    await code.completeCommand(director, {
      ...control,
      commandId: command!.id,
      receipt: {
        commandId: command!.id,
        repositoryId: 'repository',
        workspaceId: record.id,
        baseOid: base,
        parentOid: base,
        headOid: head,
        treeOid: git(bare, ['rev-parse', `${head}^{tree}`]),
        stats: { commitCount: 2, filesChanged: 2, insertions: 2, deletions: 0 },
      },
    });
    const report = await run(
      caller,
      'artifact.create',
      { title: 'Report', content: 'Retained behavior and reconciled ancestry checked.' },
      (caller, input) =>
        f.artifacts.create(caller, input as unknown as { title: string; content: string }),
    );
    const submit = (
      decisions: CodeCandidateDecision[],
      reconciliations: CodeReconciliation[] = [],
      requestId = id(),
    ) => {
      const input: ConsolidationSubmit = {
        consolidationId: record.id,
        expectedRevision: record.workflow.revision,
        commandId: command!.id,
        reportArtifactId: report.id,
        decisions,
        reconciliations,
        requestId,
      };
      return run(caller, 'consolidation.submit', input as unknown as Data, (caller, input) =>
        consolidation.submit(caller, input as unknown as ConsolidationSubmit),
      );
    };
    return { caller, session, report, submit, base, checkout };
  };
  const reviewWorker = async (record: ConsolidationRecord) => {
    await heartbeat(reviewer);
    const secret = `ms_${randomBytes(32).toString('base64url')}`;
    const session = await f.sessions.offer(reviewer, {
      instanceId: record.id,
      expectedRevision: record.workflow.revision,
      runnerId: 'test',
      secret,
      requestId: id(),
    });
    const caller = await f.sessions.authenticate(secret);
    const head = record.submissions.at(-1)!.proposal!.receipt.headOid;
    assert.deepEqual(session.execution.policy.workspace, {
      mode: 'ephemeral',
      namespace: 'consolidation-reviews',
      base: 'reference:code',
      retain: false,
      driver: 'code.v2',
    });
    assert.ok(
      !session.execution.policy.tools.some((tool) =>
        ['code.commit', 'code.operation'].includes(tool.name),
      ),
    );
    const checkout = join(f.directory, id());
    git(f.directory, ['clone', '--no-checkout', bare, checkout]);
    git(checkout, ['checkout', '--detach', head]);
    const attachment = {
      sessionId: session.id,
      runnerId: 'test',
      hostRef: 'review',
      workspace: {
        repositoryId: 'repository',
        workspaceId: session.id,
        mode: 'ephemeral' as const,
        branch: null,
        baseOid: head,
        headOid: head,
        stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
      },
    };
    await assert.rejects(
      f.sessions.attach(reviewer, {
        ...attachment,
        workspace: { ...attachment.workspace, baseOid: main },
      }),
      { code: 'workspace_base_conflict' },
    );
    await f.sessions.attach(reviewer, attachment);
    assert.equal(git(checkout, ['rev-parse', 'HEAD']), head);
    return {
      caller,
      session,
      review: await f.reviews.get(caller, record.reviewId!),
      apply: (input: Parameters<typeof f.reviews.apply>[1]) =>
        run(caller, 'review.submit', input as unknown as Data, (caller) =>
          f.reviews.apply(caller, input),
        ),
    };
  };
  return {
    ...f,
    code,
    bases,
    decide,
    run,
    reviewWorker,
    captures,
    consolidation,
    source,
    repositories,
    walks,
    history,
    gitCalls: () => gitCalls,
    main,
    ancestor,
    leaf,
    replacement,
    author,
    authority,
    producer,
    reviewer,
    actor,
    id,
    unit,
    contribution,
    create,
    inspect,
    worker,
    unbindReviews: unbind,
  };
}

const decision = (
  unitId: string,
  decision: CodeCandidateDecision['decision'],
  replacementUnitId?: string,
): CodeCandidateDecision => ({
  unitId,
  decision,
  rationale: 'Checked against the retained evidence.',
  ...(replacementUnitId ? { replacementUnitId } : {}),
});

for (const backend of backends) {
  test(
    `${backend}: workspace-free decisions produce one merged Code branch and immutable inputs`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const left = await f.unit('experiment', f.leaf);
      const right = await f.unit('task', f.replacement);
      const record = await f.create([left.id], [right.id], { version: undefined });
      assert.equal(record.workflow.version, 5);
      assert.equal(record.workflow.state, 'deciding');
      const secret = `ms_${randomBytes(32).toString('base64url')}`;
      const session = await f.sessions.offer(f.producer, {
        instanceId: record.id,
        expectedRevision: 0,
        runnerId: 'decisions',
        secret,
        requestId: f.id(),
      });
      assert.deepEqual(session.execution.policy.workspace, { mode: 'none' });
      assert.ok(
        !session.execution.policy.tools.some((tool) =>
          ['code.commit', 'code.operation'].includes(tool.name),
        ),
      );
      const absent = await f.state.read((sql) =>
        sql.get('SELECT 1 FROM code_units WHERE unit_id=?', record.id),
      );
      assert.equal(absent, undefined);
      const caller = await f.sessions.authenticate(secret);
      const input = {
        consolidationId: record.id,
        expectedRevision: 0,
        decisions: [decision(left.id, 'retain'), decision(right.id, 'retain')],
        requestId: f.id(),
      };
      const decided = await f.run(
        caller,
        'consolidation.decide',
        input as unknown as Data,
        (worker) => f.consolidation.decide(worker, input),
      );
      assert.equal(decided.workflow.state, 'consolidating');
      await assert.rejects(
        f.state.transaction((tx) => f.code.declareUnit(f.admin, record.id, tx, f.main)),
        { code: 'code_base_conflict' },
      );
      await f.sessions.release(f.producer, { sessionId: session.id, runnerId: 'decisions' });
      await f.bases.work(f.admin.projectId);
      const base = await f.state.read((sql) =>
        f.bases.find(sql, f.admin.projectId, [f.leaf, f.replacement]),
      );
      assert.equal(base?.state, 'resolved', JSON.stringify(base));
      assert.equal(base.result?.method, 'auto');
      const head = base.result!.commit;
      await assert.rejects(f.decide(decided, input.decisions), {
        code: 'consolidation_decisions_frozen',
      });
      const worker = await f.worker(decided, head);
      assert.equal(worker.base, head);
      assert.equal(readFileSync(join(worker.checkout, 'leaf.txt'), 'utf8'), 'leaf');
      assert.equal(readFileSync(join(worker.checkout, 'replacement.txt'), 'utf8'), 'replacement');
      assert.deepEqual(
        (await f.code.unit(f.producer, record.id))
          .base!.sources.map((entry) => entry.unitId)
          .sort(),
        [left.id, right.id].sort(),
      );

      for (const [table, field, value] of [
        ['consolidations', 'decisions', '{}'],
        ['code_unit_frontiers', 'inputs_json', '[]'],
      ]) {
        await assert.rejects(
          f.state.transaction((tx) =>
            tx.run(
              `UPDATE ${table} SET ${field}=? WHERE ${table === 'consolidations' ? 'id' : 'unit_id'}=?`,
              value,
              record.id,
            ),
          ),
          backend === 'sqlite' ? /immutable/ : { code: /^state_/ },
        );
        await assert.rejects(
          f.state.transaction((tx) =>
            tx.run(
              `DELETE FROM ${table} WHERE ${table === 'consolidations' ? 'id' : 'unit_id'}=?`,
              record.id,
            ),
          ),
          backend === 'sqlite' ? /retained/ : { code: /^state_/ },
        );
      }
      const submitted = await worker.submit(input.decisions);
      const reviewer = await f.reviewWorker(submitted);
      assert.equal(reviewer.session.execution.references.code, head);
    },
  );

  test(
    `${backend}: conflicting frontier waits visibly on a system resolution and then checks out its accepted result`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const bare = f.repositories.paths(f.admin.projectId).repository;
      const commits: string[] = [];
      for (const name of ['left', 'right']) {
        f.source.git('checkout', '--detach', f.main);
        const commit = f.source.commit({ 'main.txt': name });
        f.source.git('push', bare, `${commit}:refs/heads/${name}`);
        commits.push(commit);
      }
      const left = await f.unit('experiment', commits[0]);
      const right = await f.unit('task', commits[1]);
      const record = await f.create([left.id], [right.id]);
      const decided = await f.decide(record, [
        decision(left.id, 'retain'),
        decision(right.id, 'retain'),
      ]);
      await f.bases.work(f.admin.projectId);
      const base = (await f.state.read((sql) => f.bases.find(sql, f.admin.projectId, commits)))!;
      assert.equal(base.state, 'awaiting_resolution', JSON.stringify(base));
      const taskId = base.resolutionTaskId!;
      const status = await f.workflows.evaluate(f.producer, record.id);
      assert.ok(
        status.dependencies.some(
          (edge) => edge.id === taskId && edge.kind === 'system' && !edge.settled,
        ),
      );
      assert.ok(
        status.providerBlockers.some((blocker) => blocker.related.some((ref) => ref.id === taskId)),
      );
      assert.ok(
        (await f.sessions.stuck(f.admin)).items.some((item) => item.instanceId === record.id),
      );
      await assert.rejects(f.worker(decided), { code: 'dependencies_pending' });
      const pending = (await f.state.read((sql) => pendingMerge(sql, f.admin.projectId, taskId)))!;
      const commit = f.source.git(
        'commit-tree',
        f.source.git('rev-parse', `${commits[0]}^{tree}`),
        '-p',
        pending.firstParent,
        '-p',
        pending.secondParent,
        '-m',
        'Resolved',
      );
      f.source.git('push', bare, `${commit}:refs/heads/resolved`);
      const proof = await verifyResolution(
        f.repositories.git,
        f.repositories.environment(f.admin.projectId),
        pending.firstParent,
        pending.secondParent,
        commit,
      );
      assert.equal(proof.error, null);
      const resolver = await f.actor('Resolution author');
      await f.contribution(taskId, resolver.actorId, resolver.actorId);
      const report = await f.artifacts.create(f.author, {
        title: 'Resolution',
        content: 'Both conflicting inputs reviewed.',
      });
      const request = await f.reviews.request(f.author, {
        subjectId: taskId,
        subjectRevision: 0,
        producerId: f.author.actorId,
        artifactIds: [report.id],
        criteria: ['The conflict is resolved.'],
        provenanceOwner: 'code',
        requestId: f.id(),
      });
      const claim = await f.reviews.start(f.reviewer, request.id);
      await f.reviews.submit(f.reviewer, {
        reviewId: request.id,
        claimId: claim.claimId!,
        verdict: 'pass',
        notes: 'Verified.',
        requestId: f.id(),
      });
      const commandId = f.id();
      f.captures.set(commandId, {
        ref: { kind: 'code-commit', commandId },
        status: 'ready',
        provenance: {
          projectId: f.admin.projectId,
          instanceId: taskId,
          readOnly: false,
        } as CodeCapture['provenance'],
        workspace: {
          repositoryId: 'repository',
          workspaceId: taskId,
          mode: 'persistent',
          branch: null,
          baseOid: pending.firstParent,
          headOid: commit,
          stats: { commitCount: 1, filesChanged: 1, insertions: 1, deletions: 1 },
        },
        observedAt: 'now',
        eventId: null,
      });
      // Play the resolution owner's terminal delivery and durable upload boundary, as in the base-resolution suite.
      // Code still verifies the independent certificate, admitted merge proof and actual Git parents.
      await f.state.transaction(async (tx) => {
        await tx.run("UPDATE wf_instances SET state='done',revision=1 WHERE id=?", taskId);
        await tx.run(
          "UPDATE code_units SET generation=1,writer_state='closed',head_oid=? WHERE unit_id=?",
          commit,
          taskId,
        );
        await tx.run(
          'UPDATE code_pending_merges SET head_oid=?,first_merge=? WHERE unit_id=?',
          commit,
          proof.firstMerge,
          taskId,
        );
        await tx.run(
          "INSERT INTO code_operations(id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at,unit_id) VALUES (?,?,'fixture',?,'upload','hash','{}','completed',?,'now','now',?)",
          commandId,
          f.admin.projectId,
          commandId,
          JSON.stringify({
            head: commit,
            merge: {
              plan: pending.plan,
              left: pending.firstParent,
              right: pending.secondParent,
              firstMerge: proof.firstMerge,
            },
          }),
          taskId,
        );
        await f.code.acceptUnit(
          f.reviewer,
          {
            unitId: taskId,
            terminalRevision: 1,
            submissionRef: request.snapshotHash,
            reviewRef: request.id,
            codeRef: { kind: 'code-commit', commandId },
            reviewSessionId: null,
          },
          tx,
        );
      });
      await f.code.reconcileAll();
      await f.bases.work(f.admin.projectId);
      await f.workflows.checkDependencies(f.producer, record.id);
      assert.deepEqual(await f.workflows.blockers(f.producer, record.id), []);
      const worker = await f.worker(decided, commit);
      assert.equal(worker.base, commit);
      assert.equal((await f.code.unit(f.producer, record.id)).base?.reference, commit);
      const submitted = await worker.submit(decided.manifest!.decisions);
      const review = await f.reviews.get(f.reviewer, submitted.reviewId!);
      assert.ok(review.provenance?.excludedActorIds.includes(resolver.actorId));
      await assert.rejects(f.reviews.start(resolver, review.id), { code: 'review_independence' });
    },
  );

  test(
    `${backend}: ancestry stops at frozen main history and preserves older candidates and branches`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend, 40);
      f.source.git('checkout', '--detach', f.history[20]);
      const olderBranch = f.source.commit({ 'older-branch.txt': 'branch' });
      f.source.git(
        'push',
        f.repositories.paths(f.admin.projectId).repository,
        `${olderBranch}:refs/heads/older-branch`,
      );
      const onMain = await f.unit('task', f.history[10]);
      const inherited = await f.unit('task', f.history[5]);
      const oldAuthor = await f.actor('Author predating main');
      await f.contribution(inherited.id, oldAuthor.actorId, oldAuthor.actorId);
      await f.unit('task', 'f'.repeat(40));
      const older = await f.unit('task', olderBranch);
      const leaf = await f.unit('experiment', f.leaf);
      const record = await f.create([leaf.id], [onMain.id, older.id]);
      const manifest = await f.inspect(record, [
        decision(onMain.id, 'drop'),
        decision(older.id, 'retain'),
        decision(leaf.id, 'retain'),
      ]);
      assert.deepEqual(manifest.frontier.sort(), [older.id, leaf.id].sort());
      assert.deepEqual(
        manifest.conflicts.map((c) => [c.kind, c.unitId]),
        [['on_main', onMain.id]],
      );
      assert.ok(
        manifest.contributors.references.includes(f.history[5]),
        'A pre-main ancestor outside the candidate set still contributes',
      );
      assert.ok(manifest.contributors.excludedActorIds.includes(oldAuthor.actorId));
      assert.equal(f.walks.length, 1);
      assert.deepEqual(f.walks[0].commits.sort(), [f.ancestor, f.leaf, olderBranch].sort());
      assert.ok(String(f.walks[0].input).includes(`^${f.main}\n`));
      assert.ok(f.history.every((commit) => !f.walks[0].commits.includes(commit)));

      const past = await f.create([], [onMain.id, inherited.id]);
      const pastManifest = await f.inspect(past, [
        decision(onMain.id, 'retain'),
        decision(inherited.id, 'retain'),
      ]);
      assert.deepEqual(pastManifest.frontier, [onMain.id]);
      assert.deepEqual(f.walks[1].commits, [], 'All-main candidates return no historical graph');

      f.source.git('checkout', '--orphan', 'unrelated');
      const unrelated = f.source.commit({ 'unrelated.txt': 'foreign history' });
      f.source.git(
        'push',
        f.repositories.paths(f.admin.projectId).repository,
        `${unrelated}:refs/heads/unrelated`,
      );
      const foreign = await f.unit('task', unrelated);
      const invalid = await f.create([], [foreign.id]);
      await assert.rejects(f.inspect(invalid, [decision(foreign.id, 'retain')]), {
        code: 'code_candidate_invalid',
      });
      assert.equal(f.walks.length, 2, 'Unrelated history is refused before returning a graph');
    },
  );

  test(
    `${backend}: proof checks refuse changed inputs without Git and preparation releases the writer`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const parent = await f.unit('task', f.ancestor);
      const leaf = await f.unit('experiment', f.leaf, [parent.id]);
      const record = await f.create([leaf.id]);
      const decisions = [decision(parent.id, 'drop'), decision(leaf.id, 'retain')];
      const reconciliation = [
        { unitId: parent.id, retainedUnitId: leaf.id, rationale: 'Preserved deliberately.' },
      ];
      const manifest = await f.inspect(record, decisions, reconciliation);
      const verify = (
        frozen = record.candidates!,
        submitted = decisions,
        proof = manifest,
        reconciliations = reconciliation,
      ) =>
        f.state.transaction((tx) =>
          f.code.verifyCandidates(f.producer, frozen, submitted, reconciliations, proof, tx),
        );
      const calls = f.gitCalls();
      await verify();
      await assert.rejects(verify({ ...record.candidates!, hash: digest('changed') }), {
        code: 'code_candidate_invalid',
      });
      await assert.rejects(
        verify(undefined, [decision(parent.id, 'retain'), decision(leaf.id, 'retain')]),
        { code: 'code_candidate_invalid' },
      );
      await assert.rejects(verify(undefined, undefined, { ...manifest, frontier: [] }), {
        code: 'code_candidate_invalid',
      });
      await assert.rejects(verify(undefined, undefined, undefined, []), {
        code: 'code_candidate_invalid',
      });
      assert.equal(f.gitCalls(), calls, 'Proof verification never walks Git');
      const missing = await f.inspect(record, decisions);
      await assert.rejects(verify(undefined, undefined, missing, []), {
        code: 'consolidation_reconciliation',
      });
      const before = f.gitCalls();
      await assert.rejects(
        f.state.transaction(() => f.inspect(record, decisions)),
        { code: 'nested_transaction' },
      );
      assert.equal(f.gitCalls(), before);

      const run = f.repositories.git.run.bind(f.repositories.git);
      let release!: () => void;
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      t.mock.method(f.repositories.git, 'run', async (...args: Parameters<typeof run>) => {
        entered();
        await gate;
        return await run(...args);
      });
      const pending = f.inspect(record, decisions, reconciliation);
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        release();
      }, 2000);
      try {
        await waiting;
        await f.state.transaction((tx) =>
          tx.run(
            'UPDATE code_projects SET main_json=main_json WHERE project_id=?',
            f.admin.projectId,
          ),
        );
        assert.equal(timedOut, false, 'Another writer finishes while Git is paused');
      } finally {
        clearTimeout(timeout);
        release();
      }
      await pending;
    },
  );

  test(
    `${backend}: freezes accepted dependency tasks and cycle tasks once, with replay and immutable payloads`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const task = await f.unit('task', f.ancestor);
      const experiment = await f.unit('experiment', f.leaf, [task.id]);
      const cycleTask = await f.unit('task', null);
      const unfinished = await f.unit('task', null, [], false);
      const record = await f.create([experiment.id], [cycleTask.id, unfinished.id], {
        requestId: 'freeze',
      });
      assert.deepEqual(
        record.candidates!.candidates.map((c) => c.unitId).sort(),
        [task.id, experiment.id, cycleTask.id].sort(),
      );
      assert.equal(record.candidates!.integrationBase, f.main);
      await f.state.transaction((tx) =>
        tx.run(
          'UPDATE code_projects SET main_json=? WHERE project_id=?',
          JSON.stringify({ oid: f.leaf, operationId: 'later-main', stored: true }),
          f.admin.projectId,
        ),
      );
      await f.unit('task', f.replacement);
      assert.deepEqual(
        await f.create([experiment.id], [cycleTask.id, unfinished.id], { requestId: 'freeze' }),
        record,
      );
      await assert.rejects(f.create([experiment.id], [], { requestId: 'freeze' }), {
        code: 'request_conflict',
      });
      await assert.rejects(
        f.state.transaction((tx) =>
          tx.run('UPDATE consolidations SET record=? WHERE id=?', '{}', record.id),
        ),
        backend === 'sqlite' ? /immutable/ : { code: /^state_/ },
      );
      const manifest = await f.inspect(record, [
        decision(task.id, 'drop'),
        decision(experiment.id, 'retain'),
        decision(cycleTask.id, 'no_code'),
      ]);
      assert.deepEqual(manifest.frontier, [experiment.id]);
      assert.deepEqual(
        manifest.conflicts.map((c) => c.kind),
        ['carried'],
      );
      await assert.rejects(
        f.inspect(record, [
          decision(task.id, 'drop'),
          decision(experiment.id, 'retain'),
          decision(cycleTask.id, 'retain'),
        ]),
        { code: 'consolidation_decisions' },
      );
    },
  );

  test(
    `${backend}: dropped ancestor requires explicit reconciliation, visible in the exact pinned review`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const parent = await f.unit('task', f.ancestor);
      const leaf = await f.unit('experiment', f.leaf, [parent.id]);
      const record = await f.create([leaf.id]);
      const decisions = [decision(parent.id, 'drop'), decision(leaf.id, 'retain')];
      await assert.rejects(f.decide(record, decisions), { code: 'consolidation_reconciliation' });
      assert.equal((await f.consolidation.get(f.producer, record.id)).submissions.length, 0);
      const reconciliations = [
        {
          unitId: parent.id,
          retainedUnitId: leaf.id,
          rationale:
            'The leaf deliberately preserves the safe ancestor effect; this is not a removal.',
        },
      ];
      const decided = await f.decide(record, decisions, reconciliations, 'decide');
      assert.deepEqual(await f.decide(record, decisions, reconciliations, 'decide'), decided);
      await assert.rejects(f.decide(record, decisions, [], 'decide'), { code: 'request_conflict' });
      const credential = await f.state.read((sql) =>
        sql.get<{ id: string }>(
          'SELECT id FROM actor_credentials WHERE actor_id=?',
          f.admin.actorId,
        ),
      );
      const director = { ...f.admin, credentialId: credential!.id };
      const earlier = await f.worker(decided, f.leaf, director);
      await f.sessions.release(director, { sessionId: earlier.session.id, runnerId: 'test' });
      // The fixture plays final capture after its admitted upload, as in the resolution tests.
      await f.state.transaction((tx) =>
        tx.run(
          "UPDATE code_units SET writer_state='closed',head_oid=? WHERE unit_id=?",
          f.leaf,
          record.id,
        ),
      );
      const worker = await f.worker(decided);
      assert.equal((await f.code.unit(f.producer, record.id)).generation, 2);
      const submitted = await worker.submit(decisions, reconciliations, 'submit');
      const submission = submitted.submissions[0];
      const review = await f.reviews.get(f.reviewer, submitted.reviewId!);
      assert.ok(review.provenance?.revalidate);
      assert.ok(review.provenance.excludedActorIds.includes(f.author.actorId));
      assert.ok(review.provenance.excludedActorIds.includes(f.authority.actorId));
      assert.ok(review.provenance.excludedActorIds.includes(earlier.caller.actorId));
      assert.ok(review.provenance.excludedActorIds.includes(f.admin.actorId));
      assert.ok(review.provenance.excludedActorIds.includes(worker.caller.actorId));
      for (const caller of [f.author, f.authority, f.producer, f.admin])
        await assert.rejects(f.reviews.start(caller, review.id), {
          code: caller === f.producer ? 'forbidden' : 'review_independence',
        });
      const content = await f.artifacts.read(f.reviewer, submission.proposal!.manifestArtifact.id);
      const pinned = JSON.parse(content.content);
      assert.equal(pinned.provenance.candidates.hash, record.candidates!.hash);
      assert.equal(pinned.provenance.manifest.hash, submission.manifest!.hash);
      assert.deepEqual(pinned.provenance.manifest.reconciliations, reconciliations);
      assert.equal(pinned.receipt.headOid, f.leaf);
      assert.equal(pinned.receipt.treeOid, f.source.git('rev-parse', `${f.leaf}^{tree}`));
      const calls = f.gitCalls();
      const reviewing = await f.reviewWorker(submitted);
      const claim = reviewing.review;
      await assert.rejects(
        f.state.transaction((tx) =>
          tx.run('UPDATE consolidation_submissions SET record=? WHERE id=?', '{}', submission.id),
        ),
        backend === 'sqlite' ? /immutable/ : { code: /^state_/ },
      );
      const application = {
        reviewId: review.id,
        claimId: claim.claimId!,
        expectedRevision: submitted.workflow.revision,
        verdict: 'pass' as const,
        notes: 'Verified the exact result and explicit reconciliation.',
        synopsis:
          'The retained effects and their explicit reconciliation match the exact submitted result.',
        findings: review.criteria.map((_, i) => ({
          criterionNumber: i + 1,
          status: 'met' as const,
          evidenceIds: [worker.report.id],
          notes: 'Checked.',
        })),
        requestId: 'approve',
      };
      await assert.rejects(
        reviewing.apply({
          ...application,
          requestId: 'waive',
          findings: application.findings.map((finding) => ({
            ...finding,
            status: 'waived' as const,
          })),
        }),
        { code: 'criterion_not_waivable' },
      );
      const complete = (await reviewing.apply(application)) as ConsolidationRecord;
      assert.equal(complete.workflow.state, 'complete');
      assert.equal(complete.completion?.centralGit, 'not-published');
      const accepted = (await f.code.unit(f.producer, record.id)).acceptance!;
      assert.equal(accepted.reference, f.leaf);
      assert.equal(accepted.storage, 'code');
      assert.equal(accepted.reviewAttached, true);

      assert.equal(f.gitCalls(), calls, 'Claim and verdict reuse the pinned ancestry');
    },
  );

  test(
    `${backend}: already-on-main drop records remaining effects; adaptations require accepted frozen retained replacements`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const onMain = await f.unit('task', f.main);
      const old = await f.unit('experiment', f.ancestor);
      const replacement = await f.unit('task', f.replacement);
      const unaccepted = await f.unit('task', f.replacement, [], false);
      const record = await f.create([old.id], [onMain.id, replacement.id, unaccepted.id]);
      const retained = [decision(onMain.id, 'drop'), decision(replacement.id, 'retain')];
      const manifest = await f.inspect(record, [
        ...retained,
        decision(old.id, 'adapt', replacement.id),
      ]);
      assert.deepEqual(manifest.frontier, [replacement.id]);
      assert.equal(manifest.conflicts[0].kind, 'on_main');
      assert.match(
        manifest.conflicts[0].message,
        /Effects remain; removal needs a corrective change/,
      );
      const foreign = await f.scope.bootstrap({
        projectName: 'Foreign project',
        actorName: 'Foreign owner',
      });
      const foreignUnit = await f.unit('task', f.replacement, [], true, {
        projectId: foreign.project.id,
        actorId: foreign.actor.id,
      });
      await assert.rejects(f.create([], [foreignUnit.id]), { code: 'not_found' });
      for (const id of [unaccepted.id, foreignUnit.id, old.id])
        await assert.rejects(f.inspect(record, [...retained, decision(old.id, 'adapt', id)]), {
          code: 'consolidation_adaptation',
        });
      await assert.rejects(
        f.inspect(record, [
          decision(onMain.id, 'drop'),
          decision(replacement.id, 'drop'),
          decision(old.id, 'adapt', replacement.id),
        ]),
        { code: 'consolidation_adaptation' },
      );
    },
  );

  test(
    `${backend}: contributor changes and a different sealed head refuse the pinned review at claim and verdict`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const leaf = await f.unit('experiment', f.leaf);
      const record = await f.create([leaf.id]);
      const worker = await f.worker(await f.decide(record, [decision(leaf.id, 'retain')]));
      const submitted = await worker.submit([decision(leaf.id, 'retain')]);
      const review = await f.reviews.start(f.reviewer, submitted.reviewId!);
      const later = await f.actor('Later contributor');
      await f.contribution(leaf.id, later.actorId, later.actorId);
      await assert.rejects(f.reviews.checkStart(f.reviewer, review.id), {
        code: 'review_provenance_changed',
      });
      await assert.rejects(f.reviews.checkSubmit(f.reviewer, review.id), {
        code: 'review_provenance_changed',
      });
      // A second immutable proposal stands in for an erroneously admitted newer submission.
      // It must never inherit the first proposal's review, even with identical decisions.
      for (const claimed of [false, true]) {
        const freshRecord = await f.create([leaf.id]);
        const freshWorker = await f.worker(
          await f.decide(freshRecord, [decision(leaf.id, 'retain')]),
        );
        const fresh = await freshWorker.submit([decision(leaf.id, 'retain')]);
        if (claimed) await f.reviews.start(f.reviewer, fresh.reviewId!);
        const pinned = fresh.submissions[0].proposal!;
        const changed = {
          ...pinned,
          id: `different-proposal-${claimed}`,
          revision: 2,
          receipt: { ...pinned.receipt, headOid: f.replacement },
          manifestHash: digest('different-head'),
        };
        await f.state.transaction((tx) =>
          tx.run(
            'INSERT INTO code_proposals(id,project_id,instance_id,revision,session_id,request_id,input_hash,proposal_json) VALUES(?,?,?,?,?,?,?,?)',
            changed.id,
            f.admin.projectId,
            fresh.id,
            2,
            freshWorker.session.id,
            'different',
            'different',
            JSON.stringify(changed),
          ),
        );
        await assert.rejects(f.reviews.start(f.reviewer, fresh.reviewId!), {
          code: 'review_provenance_changed',
        });
        if (claimed)
          await assert.rejects(f.reviews.checkSubmit(f.reviewer, fresh.reviewId!), {
            code: 'review_provenance_changed',
          });
        assert.equal(
          (await f.reviews.get(f.reviewer, fresh.reviewId!)).status,
          claimed ? 'started' : 'requested',
        );
        if (claimed) {
          f.unbindReviews();
          assert.ok((await f.reviews.get(f.reviewer, fresh.reviewId!)).provenance);
          await assert.rejects(f.reviews.checkSubmit(f.reviewer, fresh.reviewId!), {
            code: 'review_owner_unavailable',
          });
        }
      }
    },
  );

  test(
    `${backend}: Code absent preserves default version 4 creation and refuses explicit version 5; published definitions and policies stay exact`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const unbind = f.consolidation.bindCode(f.code);
      unbind();
      const report = await f.artifacts.create(f.producer, { title: 'Source', content: 'Source' });
      const input = {
        name: 'Legacy',
        sourceArtifactIds: [report.id],
        workspace: 'git' as const,
        requestId: 'legacy',
      };
      const legacy = await f.consolidation.create(f.producer, input);
      assert.equal(legacy.workflow.version, 4);
      await assert.rejects(
        f.consolidation.create(f.producer, { ...input, version: 5, requestId: 'unavailable' }),
        { code: 'code_unavailable' },
      );
      f.consolidation.bindCode(f.code);
      await f.state.transaction((tx) =>
        tx.run(
          'UPDATE code_projects SET main_json=? WHERE project_id=?',
          JSON.stringify({ oid: f.main, operationId: 'fixture', stored: false }),
          f.admin.projectId,
        ),
      );
      await assert.rejects(
        f.consolidation.create(f.producer, { ...input, version: 5, requestId: 'unhosted' }),
        { code: 'code_consolidation_unhosted' },
      );
      const published = JSON.parse(
        readFileSync(new URL('./fixtures/published-policies.json', import.meta.url), 'utf8'),
      );
      for (const row of published.definitions.filter(
        (row: { name: string }) => row.name === 'consolidation',
      )) {
        const stored = await f.state.read((sql) =>
          sql.get<{ fingerprint: string }>(
            'SELECT fingerprint FROM wf_definitions WHERE name=? AND version=?',
            row.name,
            row.version,
          ),
        );
        assert.equal(stored?.fingerprint, row.fingerprint);
      }
      for (const row of published.recipes.filter((row: { type: string }) =>
        row.type.startsWith('consolidation.'),
      )) {
        const stored = await f.state.read((sql) =>
          sql.get<{ hash: string }>(
            'SELECT hash FROM context_recipes WHERE type=? AND version=?',
            row.type,
            row.version,
          ),
        );
        assert.equal(stored?.hash, row.hash);
      }
      for (const row of published.policies.filter(
        (row: { workflow: string }) => row.workflow === 'consolidation',
      )) {
        const stored = await f.state.read((sql) =>
          sql.get<{ fingerprint: string }>(
            'SELECT fingerprint FROM wf_execution_policies WHERE workflow=? AND version=? AND state=?',
            row.workflow,
            row.version,
            row.state,
          ),
        );
        assert.equal(stored?.fingerprint, row.fingerprint);
      }
    },
  );
}
