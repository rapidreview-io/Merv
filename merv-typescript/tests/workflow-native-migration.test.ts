import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  canonical,
  createService,
  digest,
  newId,
  now,
  sha256Hex,
  type Caller,
} from '@merv/contracts';
import { insert as insertArtifact } from '@merv/artifacts/content';
import { CodeService as CoreCode } from '@merv/code/service';
import { workRef } from '@merv/code/store/refs';
import { ExperimentService } from '@merv/experiments';
import { resumedOutputs } from '@merv/experiments/lease';
import type { ExperimentEvidence } from '@merv/experiments/types';
import { ProjectScope } from '@merv/scope';
import { TaskService } from '@merv/tasks';
import { WorkflowsService } from '@merv/workflows';
import { insertLease } from '@merv/workflows/lease-rows';
import {
  migrateNativeWorkflow,
  nativeRecoveryRevision,
  type NativeMigrationInput,
} from '@merv/workflows/native-migration';
import { createApp } from './fixtures/app.js';
import { currentTask, currentWork } from './fixtures/current-work.js';
import { git } from './fixtures/code-store.js';
import { waitForManagedCode } from './fixtures/managed-code.js';
import { openState } from './fixtures/state.js';
import { taskActors } from './fixtures/task-actors.js';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-native-migration-'));
  const app = await createApp({ directory, api: false });
  const { operator, producer } = await taskActors(app, 'Native migration');
  const source = producer.caller;
  const code = app.ctx.codeWork;
  const core = app.ctx.code as CoreCode;
  const state = app.ctx.state;
  const work = currentWork(app.ctx, { directory, source });
  t.after(async () => {
    await work.close();
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await waitForManagedCode(code, source);
  let sequence = 0;
  const request = () => `migration-${++sequence}`;
  const taskInput = () => ({
    title: request(),
    goal: 'Retain work.',
    checks: ['Work remains.'],
    requestId: request(),
  });
  // Recreate old declarations using the still-published handles. Do not rewrite immutable
  // code_units provenance or enable any legacy producer runtime in the fixture.
  const experiment = async (version = 41) => {
    const owner = app.ctx.experiments as ExperimentService;
    const current = owner.handles.get(45)!;
    owner.handles.set(45, owner.handles.get(version)!);
    try {
      return await owner.create(source, {
        name: request(),
        intent: 'Preserve the planned research.',
        requestId: request(),
      });
    } finally {
      owner.handles.set(45, current);
    }
  };
  const task = async () => {
    const owner = app.ctx.tasks as TaskService;
    const registration = owner.registration.bind(owner);
    const historical = registration(43);
    const mock = t.mock.method(owner, 'registration', (version: number) =>
      version !== 46
        ? registration(version)
        : {
            ...historical,
            start: (...[caller, input, tx]: Parameters<typeof historical.start>) =>
              historical.start(caller, { ...input, version: 43 }, tx),
          },
    );
    try {
      return await owner.create(source, taskInput());
    } finally {
      mock.mock.restore();
    }
  };
  const input = (unit: {
    id: string;
    workflow: { revision: number; version: number; workflow: string };
  }): NativeMigrationInput => ({
    projectId: source.projectId,
    instanceId: unit.id,
    expectedRevision: unit.workflow.revision,
    fromVersion: unit.workflow.version,
    toVersion: unit.workflow.workflow === 'task' ? 46 : 45,
    actorId: operator.actorId,
    reason: 'Preserve idle research and resume with native Git.',
  });
  const migrate = (value: NativeMigrationInput) =>
    state.transaction((tx) => migrateNativeWorkflow(tx, value));
  const history = (id: string) =>
    state.read((sql) =>
      sql.all('SELECT * FROM wf_history WHERE instance_id=? ORDER BY revision', id),
    );
  const snapshot = (id: string) => app.ctx.workflows.get(source, id);
  const retained = (id: string) =>
    state.read(async (sql) => ({
      unit: await sql.get('SELECT * FROM code_units WHERE unit_id=?', id),
      workspace: await sql.get('SELECT * FROM code_workspaces WHERE unit_id=?', id),
      dependencies: await sql.all(
        'SELECT * FROM wf_dependencies WHERE source_id=? OR target_id=? ORDER BY source_id,target_id',
        id,
        id,
      ),
      experiment: await sql.get('SELECT * FROM experiments WHERE id=?', id),
      attempts: await sql.all(
        'SELECT * FROM experiment_attempts WHERE experiment_id=? ORDER BY attempt_index',
        id,
      ),
      evidence: await sql.all(
        'SELECT * FROM experiment_evidence WHERE experiment_id=? ORDER BY sequence',
        id,
      ),
      slots: await sql.all(
        'SELECT * FROM experiment_slots WHERE experiment_id=? ORDER BY role,path',
        id,
      ),
      task: await sql.get('SELECT * FROM tasks WHERE id=?', id),
      artifacts: await sql.all(
        'SELECT id,created_by,hash,content,session_id FROM artifacts WHERE project_id=? ORDER BY id',
        source.projectId,
      ),
    }));
  const oldOutput = async (
    unit: Awaited<ReturnType<typeof experiment>>,
    options: { active?: boolean; wrongAuthor?: boolean; attach?: boolean } = {},
  ) => {
    const sessionId = newId('ms');
    return state.transaction(async (tx) => {
      await insertLease(tx, {
        id: sessionId,
        projectId: source.projectId,
        snapshot: unit.workflow,
        actorId: source.actorId,
        sourceActorId: operator.actorId,
        reviewId: null,
        claimId: null,
        receipt: { sessionId },
        details: { attemptIndex: 1, artifacts: [], recovery: [], inputs: {} },
      });
      if (!options.active)
        await tx.run('UPDATE wf_leases SET released_at=? WHERE id=?', now(), sessionId);
      const bytes = Buffer.from('# Plan\nPreserve the paired experiment and its measurements.\n');
      const author = {
        ...(options.wrongAuthor ? operator : source),
        session: { id: sessionId },
      } as Caller;
      const artifact = await insertArtifact(
        state,
        tx,
        author,
        {
          title: 'Retained plan',
          mediaType: 'text/markdown',
          hash: sha256Hex(bytes),
          size: bytes.length,
        },
        bytes,
      );
      if (options.attach) {
        const evidence: ExperimentEvidence = {
          id: newId('evidence'),
          experimentId: unit.id,
          attemptIndex: 1,
          role: 'plan',
          path: 'plan.md',
          artifactId: artifact.id,
          hash: artifact.hash,
          figureIds: [],
          createdBy: source.actorId,
          sessionId,
          createdAt: now(),
          sequence: 1,
          current: true,
          systemGenerated: false,
        };
        await tx.run(
          'INSERT INTO experiment_evidence(id,experiment_id,attempt_index,role,path,sequence,record) VALUES(?,?,1,?,?,1,?)',
          evidence.id,
          unit.id,
          evidence.role,
          evidence.path,
          canonical(evidence),
        );
        await tx.run(
          'INSERT INTO experiment_slots(experiment_id,attempt_index,role,path,evidence_id) VALUES(?,1,?,?,?)',
          unit.id,
          evidence.role,
          evidence.path,
          evidence.id,
        );
      }
      return { sessionId, artifact };
    });
  };
  return {
    app,
    source,
    operator,
    code,
    core,
    state,
    work,
    request,
    experiment,
    task,
    taskInput,
    input,
    migrate,
    history,
    snapshot,
    retained,
    oldOutput,
  };
}

for (const version of [40, 41, 43]) {
  const kind = version === 43 ? 'task' : 'experiment';
  test(`${kind}${version} migration retains data, dependencies, code provenance, pins, heads and evidence`, async (t) => {
    const f = await fixture(t);
    const unit = version === 43 ? await f.task() : await f.experiment(version);
    assert.equal(unit.workflow.version, version);
    if (version !== 43)
      await f.oldOutput(unit as Awaited<ReturnType<typeof f.experiment>>, { attach: true });
    const dependent = await currentTask(f.app.ctx, f.source, {
      ...f.taskInput(),
      dependsOn: unit.id,
    });
    const pinned = await f.state.transaction((tx) =>
      f.code.pinBase(f.source, { unitId: unit.id, leaseId: 'historical-pin', writer: false }, tx),
    );
    const repository = f.core.repositories.paths(f.source.projectId).repository;
    const base = pinned.reference;
    const head = git(repository, [
      '-c',
      'user.name=Historical worker',
      '-c',
      'user.email=worker@example.test',
      'commit-tree',
      `${base}^{tree}`,
      '-p',
      base,
      '-m',
      'Retained pre-migration progress',
    ]);
    git(repository, ['update-ref', workRef(unit.id), head]);
    await f.state.transaction((tx) =>
      tx.run('UPDATE code_workspaces SET head_oid=? WHERE unit_id=?', head, unit.id),
    );
    const before = {
      snapshot: await f.snapshot(unit.id),
      retained: await f.retained(unit.id),
      history: await f.history(unit.id),
    };
    const refs = git(repository, ['show-ref']);
    const migration = f.input(unit);
    const result = await f.migrate(migration);
    const after = await f.snapshot(unit.id);
    assert.deepEqual(result, {
      version: migration.toVersion,
      revision: before.snapshot.revision + 1,
    });
    assert.deepEqual(after.data, before.snapshot.data);
    assert.equal(after.state, before.snapshot.state);
    assert.equal(after.createdAt, before.snapshot.createdAt);
    assert.deepEqual(await f.retained(unit.id), before.retained);
    assert.equal(git(repository, ['show-ref']), refs);
    assert.equal((await f.code.unit(f.source, unit.id)).canonicalHead, head);
    const dependencies = (await f.app.ctx.workflows.prerequisites(f.source, [dependent.id])).get(
      dependent.id,
    )!;
    assert.equal(dependencies[0]!.settled, false);
    assert.equal(dependencies[0]!.failed, false);
    assert.deepEqual((await f.history(unit.id)).slice(0, -1), before.history);
    const audit = await f.state.read((sql) =>
      sql.get<{ source_json: string; source_hash: string }>(
        'SELECT source_json,source_hash FROM wf_protocol_migrations WHERE instance_id=?',
        unit.id,
      ),
    );
    assert.equal(audit!.source_hash, digest(JSON.parse(audit!.source_json)));
    assert.equal(JSON.parse(audit!.source_json).version, version);
    assert.equal(JSON.parse(audit!.source_json).data_json, canonical(before.snapshot.data));
  });
}

test('migration replay is exact and concurrent retries write one retained audit boundary', async (t) => {
  const f = await fixture(t);
  const unit = await f.experiment();
  const input = f.input(unit);
  const [first, second] = await Promise.all([f.migrate(input), f.migrate(input)]);
  assert.deepEqual(second, first);
  for (const change of [
    { fromVersion: 40 },
    { toVersion: 46 },
    { actorId: f.source.actorId },
    { reason: 'Different operation' },
  ])
    await assert.rejects(f.migrate({ ...input, ...change }), { code: 'migration_conflict' });
  const audit = await f.state.read((sql) =>
    sql.all('SELECT * FROM wf_protocol_migrations WHERE instance_id=?', unit.id),
  );
  assert.equal(audit.length, 1);
  assert.equal(
    (await f.history(unit.id)).filter((row) => row.action === 'migrate_native_git').length,
    1,
  );
  assert.equal(
    (
      await f.state.read((sql) =>
        sql.all(
          "SELECT * FROM events WHERE subject_id=? AND type='workflow.protocol_migrated'",
          unit.id,
        ),
      )
    ).length,
    1,
  );
  for (const statement of [
    'UPDATE wf_protocol_migrations SET reason=reason',
    'DELETE FROM wf_protocol_migrations',
    'TRUNCATE wf_protocol_migrations',
  ])
    await assert.rejects(
      f.state.transaction((tx) => tx.run(statement)),
      { code: 'state_constraint' },
    );
  assert.deepEqual(
    await f.state.read((sql) =>
      sql.all('SELECT * FROM wf_protocol_migrations WHERE instance_id=?', unit.id),
    ),
    audit,
  );
});

test('migration refuses live leases, all unfinished writer states and pending reviews without changing evidence', async (t) => {
  const f = await fixture(t);
  const leased = await f.experiment();
  await f.oldOutput(leased, { active: true });
  const leasedBefore = await f.snapshot(leased.id);
  await assert.rejects(f.migrate(f.input(leased)), { code: 'migration_busy' });
  assert.deepEqual(await f.snapshot(leased.id), leasedBefore);
  const writing = await f.task();
  await f.state.transaction((tx) =>
    f.code.pinBase(
      f.source,
      { unitId: writing.id, leaseId: 'historical-writer', writer: true },
      tx,
    ),
  );
  for (const state of ['reserved', 'active', 'closing', 'recovery_required']) {
    await f.state.transaction((tx) =>
      tx.run('UPDATE code_workspaces SET writer_state=? WHERE unit_id=?', state, writing.id),
    );
    await assert.rejects(f.migrate(f.input(writing)), { code: 'migration_busy' });
  }
  const reviewing = await f.experiment();
  const proof = await f.app.ctx.artifacts.create(f.source, {
    title: 'Pending review',
    content: 'Retained content.',
  });
  await f.app.ctx.reviews.request(f.source, {
    subjectId: reviewing.id,
    subjectRevision: 0,
    producerId: f.source.actorId,
    artifactIds: [proof.id],
    criteria: ['Check the retained content.'],
    requestId: f.request(),
  });
  const before = await f.retained(reviewing.id);
  await assert.rejects(f.migrate(f.input(reviewing)), { code: 'migration_review_pending' });
  assert.deepEqual(await f.retained(reviewing.id), before);
  assert.deepEqual(
    await f.state.read((sql) => sql.all('SELECT * FROM wf_protocol_migrations')),
    [],
  );
});

test('a failed combined transaction rolls back the protocol switch, audit, history and event', async (t) => {
  const f = await fixture(t);
  const unit = await f.experiment();
  const before = {
    snapshot: await f.snapshot(unit.id),
    history: await f.history(unit.id),
    retained: await f.retained(unit.id),
  };
  await assert.rejects(
    f.state.transaction(async (tx) => {
      await migrateNativeWorkflow(tx, f.input(unit));
      throw new Error('Later cutover validation failed');
    }),
    /Later cutover validation failed/,
  );
  assert.deepEqual(await f.snapshot(unit.id), before.snapshot);
  assert.deepEqual(await f.history(unit.id), before.history);
  assert.deepEqual(await f.retained(unit.id), before.retained);
  assert.deepEqual(
    await f.state.read((sql) => sql.all('SELECT * FROM wf_protocol_migrations')),
    [],
  );
  assert.deepEqual(
    await f.state.read((sql) =>
      sql.all("SELECT * FROM events WHERE type='workflow.protocol_migrated'"),
    ),
    [],
  );
  await f.migrate(f.input(unit));
});

test('migration rejects a target with incompatible graph or dependency success semantics', async (t) => {
  for (const changed of ['graph', 'success'] as const) {
    const state = await openState();
    const scope = await createService(new ProjectScope(state));
    const workflows = await createService(new WorkflowsService(state, scope));
    t.after(async () => {
      workflows.close();
      await state.close();
    });
    const boot = await scope.credentials.bootstrap({ projectName: changed, actorName: 'Owner' });
    const caller = { projectId: boot.project.id, actorId: boot.actor.id };
    const definition = {
      name: 'experiment',
      version: 40,
      initial: 'planned',
      states: ['planned', 'done', 'failed'],
      terminal: ['done', 'failed'],
      edges: [
        { from: 'planned', action: 'finish', to: 'done' },
        { from: 'planned', action: 'fail', to: 'failed' },
      ],
    };
    const policy = (edges: typeof definition.edges, successStates: string[]) => ({
      successStates,
      actions: edges.map((edge) => ({
        name: edge.action,
        states: [edge.from],
        transitions: [edge.action],
        tool: 'migration.' + edge.action,
        instruction: edge.action,
        check: () => {},
      })),
    });
    const source = await workflows.register(definition, policy(definition.edges, ['done']));
    const targetEdges =
      changed === 'graph'
        ? [...definition.edges, { from: 'planned', action: 'retry', to: 'planned' }]
        : definition.edges;
    await workflows.register(
      {
        ...definition,
        version: 45,
        edges: targetEdges,
      },
      policy(targetEdges, changed === 'success' ? ['failed'] : ['done']),
    );
    const unit = await source.start(caller, { workflow: 'experiment', requestId: 'start' });
    await assert.rejects(
      state.transaction((tx) =>
        migrateNativeWorkflow(tx, {
          projectId: caller.projectId,
          instanceId: unit.id,
          expectedRevision: unit.revision,
          fromVersion: 40,
          toVersion: 45,
          actorId: caller.actorId,
          reason: 'Incompatible target probe',
        }),
      ),
      { code: 'migration_contract_conflict' },
    );
    assert.equal((await workflows.get(caller, unit.id)).version, 40);
  }
});

test('a migrated planner can reuse only its released predecessor outputs, across exactly the migration boundary', async (t) => {
  const f = await fixture(t);
  const original = await f.experiment(41);
  const kept = await f.oldOutput(original);
  const forged = await f.oldOutput(original, { wrongAuthor: true });
  const other = await f.experiment(41);
  const unrelated = await f.oldOutput(other);
  await f.migrate(f.input(original));
  const migrated = await f.app.ctx.experiments.get(f.source, original.id);
  const held = await f.work.lease(migrated);
  const outputs = await f.state.transaction((tx) =>
    resumedOutputs({ artifacts: f.app.ctx.artifacts }, held.worker, migrated.workflow, tx),
  );
  assert.ok(outputs.includes(kept.artifact.id));
  assert.equal(outputs.includes(forged.artifact.id), false);
  assert.equal(outputs.includes(unrelated.artifact.id), false);
  assert.equal(
    await f.state.read((tx) =>
      nativeRecoveryRevision(tx, f.source.projectId, original.id, migrated.workflow.revision),
    ),
    original.workflow.revision,
  );
  const attached = await f.app.ctx.experiments.attach(held.worker, {
    experimentId: original.id,
    expectedRevision: migrated.workflow.revision,
    attemptIndex: 1,
    artifactId: kept.artifact.id,
    role: 'plan',
    path: 'plan.md',
    requestId: f.request(),
  });
  assert.equal(attached.artifactId, kept.artifact.id);
  const later = await f.state.transaction((tx) =>
    resumedOutputs(
      { artifacts: f.app.ctx.artifacts },
      held.worker,
      { id: original.id, revision: migrated.workflow.revision + 1 },
      tx,
    ),
  );
  assert.equal(
    later.includes(kept.artifact.id),
    false,
    'ordinary revision changes do not inherit this recovery exemption',
  );
  await f.work.release(held);
});
