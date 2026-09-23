import {
  canonical,
  createService,
  digest,
  type WorkflowDefinition,
  type WorkflowPolicy,
  type WorkflowSnapshot,
} from '@merv/contracts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { WorkflowsService } from '@merv/workflows';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import { CodeService } from '@merv/code-research/service';
import { CodeRepositories } from '@merv/code/store/repository';
import type { CodeWriterService } from '@merv/code/writers';
import { CodeBaseService, INHERITED_QUARANTINE } from '../packages/code-research/src/bases.js';
import { openState } from './fixtures/state.js';

const oid = (char: string) => char.repeat(40);
const repository = 'runner-repository';

const definition: WorkflowDefinition = {
  name: 'build',
  version: 1,
  initial: 'building',
  states: ['building', 'built', 'dropped'],
  terminal: ['built', 'dropped'],
  edges: [
    { from: 'building', action: 'finish', to: 'built' },
    { from: 'building', action: 'abandon', to: 'dropped' },
  ],
};
/** `coded` declares a workspace on its one working state, which is all Code is told of it. */
const policy = (workspace: boolean, driver?: string): WorkflowPolicy => ({
  successStates: ['built'],
  actions: ['finish', 'abandon'].map((name) => ({
    name,
    tool: `build.${name}`,
    states: ['building'],
    transitions: [name],
    instruction: `The build may ${name}.`,
    check: () => {},
  })),
  assignments: [
    {
      state: 'building',
      check: () => {},
      build: () => {
        throw new Error('These tests render no assignment');
      },
      execution: {
        readOnly: false,
        tools: [],
        ...(workspace
          ? {
              workspace: {
                mode: 'ephemeral' as const,
                namespace: 'probe',
                base: 'central' as const,
                retain: false,
                ...(driver ? { driver } : {}),
              },
            }
          : {}),
      },
    },
  ],
});

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-automatic-base-'));
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const workflows = await createService(new WorkflowsService(state, scope));
  const events = await createService(new DurableEvents(state));
  const sessions = await createService(
    new LeasedSessions(state, scope, workflows, events, { sweepIntervalMs: 60_000 }),
  );
  const code = await createService(new CodeService(state, scope, sessions, artifacts, workflows));
  // The subscription the Code plugin makes, so a transition reaches Code as it does in the app.
  const unsubscribe = await events.subscribe({
    id: 'code.reconcile.v1',
    types: ['workflow.transition'],
    from: 'now',
    handle: async (event, tx) => await code.transitioned(event, tx),
  });
  t.after(async () => {
    await unsubscribe();
    await code.close();
    await sessions.close();
    await events.close();
    workflows.close();
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const principal = await scope.acceptVerifiedIdentity({
    issuer: 'https://identity.example/auth/v1',
    subject: 'owner',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  const project = await scope.createProject(principal, { name: 'Bases', requestId: 'one' });
  const admin = await scope.caller(principal, project.id);
  const plain = await workflows.register(definition, policy(false));
  const coded = await workflows.register({ ...definition, name: 'coded' }, policy(true));
  // `kept` names the driver that prepares its checkouts from Code's own repository.
  const kept = await workflows.register({ ...definition, name: 'kept' }, policy(true, 'code.v2'));
  let sequence = 0;
  const request = () => `request-${++sequence}`;
  const start = async (dependsOn: WorkflowSnapshot[] = [], workflow = 'build') =>
    await workflows.start(admin, {
      workflow,
      requestId: request(),
      dependsOn: dependsOn.map((item) => item.id),
    });
  const move = async (work: WorkflowSnapshot, action = 'finish') => {
    const moved = await workflows.transition(admin, {
      instanceId: work.id,
      action,
      requestId: request(),
      expectedRevision: (await workflows.get(admin, work.id)).revision,
    });
    await events.drain();
    return moved;
  };
  /**
   * An acceptance as an owner's review leaves it. The code-less one goes through acceptUnit; a
   * commit would need a runner's capture, so its row is written with the hash Code checks.
   */
  const accept = async (
    work: WorkflowSnapshot,
    commit: string | null,
    from = repository,
    storage = 'code',
  ) => {
    const ended = await workflows.get(admin, work.id);
    if (commit === null)
      return await state.transaction(
        async (tx) =>
          await code.acceptUnit(
            admin,
            {
              unitId: work.id,
              terminalRevision: ended.revision,
              submissionRef: 'submission',
              reviewRef: 'review',
              codeRef: null,
              reviewSessionId: null,
            },
            tx,
          ),
      );
    const body = {
      formatVersion: 1,
      unitId: work.id,
      workflow: ended.workflow,
      version: ended.version,
      terminalRevision: ended.revision,
      submissionRef: 'submission',
      reviewRef: 'review',
      acceptedBy: admin.actorId,
      code: {
        ref: { kind: 'code-commit', commandId: `command-${work.id}` },
        commit,
        tree: null,
        repositoryId: from,
        reviewAttached: true,
      },
      storage,
    };
    await state.transaction(
      async (tx) =>
        await tx.run(
          'INSERT INTO code_units (project_id,unit_id,workflow,version,declared_at,acceptance_json,acceptance_hash,accepted_at) VALUES (?,?,?,?,?,?,?,?)',
          project.id,
          work.id,
          ended.workflow,
          ended.version,
          'now',
          JSON.stringify(body),
          digest(body),
          'now',
        ),
    );
    return (await code.unit(admin, work.id)).acceptance!;
  };
  const succeeded = async (commit: string | null, dependsOn: WorkflowSnapshot[] = []) => {
    const work = await start(dependsOn, commit === null ? 'build' : 'coded');
    await move(work);
    return { work, acceptance: await accept(work, commit) };
  };
  const declare = async (dependsOn: WorkflowSnapshot[], workflow = 'kept') => {
    const work = await start(dependsOn, workflow);
    await state.transaction(async (tx) => await code.declareUnit(admin, work.id, tx));
    return work;
  };
  const bind = async (mainOid: string, expectedMainOid?: string, hosted = true) => {
    await code.bindLocal(admin, {
      repositoryId: repository,
      mainOid,
      ...(expectedMainOid === undefined ? {} : { expectedMainOid }),
      requestId: request(),
    });
    if (hosted) {
      await state.transaction(async (tx) => {
        await tx.run(
          'UPDATE code_projects SET store_json=COALESCE(store_json,?),main_json=? WHERE project_id=?',
          JSON.stringify({ format: 1, objectFormat: 'sha1', rootOid: mainOid }),
          JSON.stringify({ oid: mainOid, operationId: 'fixture', stored: true }),
          project.id,
        );
      });
      await code.reconcileAll();
    }
  };
  const pin = async (work: WorkflowSnapshot, leaseId = `lease-${work.id}`) =>
    await state.transaction(
      async (tx) => await code.pinBase(admin, { unitId: work.id, leaseId }, tx),
    );
  const published = async (work: WorkflowSnapshot) =>
    (await workflows.blockers(admin, work.id)).map((item) => [item.provider, item.code, item.key]);
  const edges = async (work: WorkflowSnapshot) =>
    (
      await state.read(
        async (sql) =>
          await sql.all<{ relation: string; target_ref: string }>(
            'SELECT relation,target_ref FROM code_edges WHERE project_id=? AND source_ref=? ORDER BY target_ref',
            project.id,
            `unit:${work.id}`,
          ),
      )
    ).map((row) => [row.relation, row.target_ref]);
  return {
    state,
    scope,
    sessions,
    workflows,
    code,
    admin,
    project,
    plain,
    coded,
    kept,
    request,
    start,
    move,
    accept,
    succeeded,
    declare,
    bind,
    pin,
    published,
    edges,
  };
}

test('a unit with no accepted code beneath it starts from the project’s pinned main', async (t) => {
  const f = await fixture(t);
  await f.bind(oid('a'));
  const note = await f.succeeded(null);
  const work = await f.declare([note.work]);
  assert.deepEqual(await f.published(work), []);
  assert.deepEqual((await f.code.unit(f.admin, work.id)).baseStatus, {
    status: 'ready',
    kind: 'main',
    sources: [],
  });

  // A refused offer rolls its transaction back, and the pin with it.
  await assert.rejects(
    f.state.transaction(async (tx) => {
      await f.code.pinBase(f.admin, { unitId: work.id, leaseId: 'refused' }, tx);
      throw new Error('the offer was refused after acquisition');
    }),
    /refused after acquisition/,
  );
  assert.equal((await f.code.unit(f.admin, work.id)).base, null);
  assert.equal(
    await f.state.transaction(async (tx) => await f.code.basePin(f.admin, work.id, tx)),
    null,
    'reading the pin derives nothing',
  );

  const first = await f.pin(work, 'first');
  assert.deepEqual(
    [first.kind, first.reference, first.sources, first.leaseId],
    ['main', oid('a'), [], 'first'],
  );
  assert.deepEqual(await f.edges(work), [['based_on', `main:${oid('a')}`]]);
  // Main moves on; the unit keeps the commit it copied, whichever lease asks next.
  await f.bind(oid('b'), oid('a'));
  assert.deepEqual(await f.pin(work, 'second'), first);
  assert.deepEqual(
    await f.state.transaction(async (tx) => await f.code.baseStatus(f.admin, work.id, tx)),
    { status: 'pinned', pin: first },
  );
  const later = await f.declare([]);
  assert.equal((await f.pin(later)).reference, oid('b'));

  // Declared dependencies are part of the pin.
  const extra = await f.succeeded(null);
  await f.kept.addDependencies(f.admin, {
    instanceId: work.id,
    dependsOn: [extra.work.id],
    expectedRevision: work.revision,
    requestId: f.request(),
  });
  await assert.rejects(f.pin(work, 'third'), { code: 'code_dependencies_changed' });
});

test('one accepted commit becomes the base, through code-less successes and however many paths lead to it', async (t) => {
  const f = await fixture(t);
  await f.bind(oid('a'));
  const harness = await f.succeeded(oid('c'));
  const notes = await f.succeeded(null, [harness.work]);
  const twin = await f.succeeded(oid('c'));
  const pending = await f.start();

  const waiting = await f.declare([notes.work, pending]);
  assert.deepEqual((await f.code.unit(f.admin, waiting.id)).baseStatus, { status: 'waiting' });
  assert.deepEqual(await f.published(waiting), [], 'Workflows already reports the wait');
  await assert.rejects(f.pin(waiting), { code: 'code_base_pending', status: 409 });

  // The notes carry no code, so the base is what they were built on.
  const through = await f.declare([notes.work]);
  const taken = await f.pin(through);
  assert.deepEqual(
    [taken.kind, taken.reference, taken.sources],
    ['accepted', oid('c'), [{ unitId: harness.work.id, acceptanceHash: harness.acceptance.hash }]],
  );

  // The same commit twice is one base that remembers both acceptances.
  const both = await f.declare([notes.work, twin.work]);
  const shared = await f.pin(both);
  assert.equal(shared.reference, oid('c'));
  assert.deepEqual(
    shared.sources.map((item) => item.unitId).sort(),
    [harness.work.id, twin.work.id].sort(),
  );
  assert.deepEqual(
    await f.edges(both),
    [
      ['based_on', `acceptance:${harness.work.id}@${harness.acceptance.hash}`],
      ['based_on', `acceptance:${twin.work.id}@${twin.acceptance.hash}`],
    ].sort((left, right) => left[1]!.localeCompare(right[1]!)),
  );
});

test('a success that cannot be verified blocks, whether or not its owner is loaded', async (t) => {
  const f = await fixture(t);
  await f.bind(oid('a'));
  // A workspace version that succeeded before acceptances existed left no row.
  const legacy = await f.start([], 'coded');
  await f.move(legacy);
  const elsewhere = await f.start([], 'coded');
  await f.move(elsewhere);
  await f.accept(elsewhere, oid('e'), 'another-repository');
  // A code-less success finished ahead of its own prerequisite.
  const unfinished = await f.start();
  const hasty = await f.start([unfinished]);
  await f.move(hasty);
  await f.accept(hasty, null);

  const work = await f.declare([legacy, elsewhere, hasty]);
  // The owner of `coded` unloads; the classification is Workflows' persisted fact.
  f.coded.dispose();
  const expected = [
    ['code', 'code_base_pending', `acceptance:${elsewhere.id}`],
    ['code', 'code_base_pending', `acceptance:${legacy.id}`],
    ['code', 'code_base_pending', `dependency:${unfinished.id}`],
  ].sort((a, b) => a[2]!.localeCompare(b[2]!));
  const sorted = async () => (await f.published(work)).sort((a, b) => a[2]!.localeCompare(b[2]!));
  assert.deepEqual(await sorted(), expected);
  await assert.rejects(f.pin(work), { code: 'code_base_pending' });
  assert.equal((await f.code.unit(f.admin, work.id)).base, null, 'never pinned on main');

  // What a start after an absence does: the same answer, written again without change.
  await f.state.transaction(
    async (tx) => await tx.run('DELETE FROM wf_blockers WHERE instance_id=?', work.id),
  );
  await f.code.reconcileAll();
  assert.deepEqual(await sorted(), expected);
});

test('a unit whose checkouts Code prepares starts only from what Code’s repository holds', async (t) => {
  const f = await fixture(t);
  await f.bind(oid('a'), undefined, false);
  const harness = await f.start([], 'coded');
  await f.move(harness);
  await f.accept(harness, oid('c'), repository, 'legacy-local');
  await f.state.transaction(async (tx) => {
    await tx.run(
      'UPDATE code_projects SET store_json=? WHERE project_id=?',
      JSON.stringify({ format: 1, objectFormat: 'sha1', rootOid: oid('a') }),
      f.project.id,
    );
  });
  const work = await f.declare([harness]);
  const run = async (sql: string, ...values: string[]) =>
    await f.state.transaction(async (tx) => {
      await tx.run(sql, ...values);
    });
  // The dependency was accepted from a runner's repository: its commit must be imported.
  assert.deepEqual(await f.published(work), [
    ['code', 'code_base_pending', `acceptance:${harness.id}`],
  ]);
  const [blocker] = await f.workflows.blockers(f.admin, work.id);
  assert.match(blocker!.next, /code-import/);
  await assert.rejects(f.pin(work), { code: 'code_base_pending', status: 409 });

  // An import whose tip is a descendant delivers the accepted commit as history it
  // contains. A tip is never an ancestor of itself, so waiting for one would wait forever.
  await run(
    "INSERT INTO code_operations (id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at,phase) VALUES ('cop_contains',?,'actor:fixture','contains','import','hash','{}','completed',?,'now','now','refs_applied')",
    f.project.id,
    canonical({ head: oid('d'), contained: [oid('c')] }),
  );
  await f.code.reconcileAll();
  assert.deepEqual(await f.published(work), []);

  await run(
    "INSERT INTO code_operations (id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at,phase) VALUES ('cop_import',?,'actor:fixture','import','import','hash','{}','completed',?,'now','now','refs_applied')",
    f.project.id,
    JSON.stringify({ head: oid('c') }),
  );
  await f.code.reconcileAll();
  assert.deepEqual(await f.published(work), []);
  assert.equal((await f.pin(work)).reference, oid('c'));

  // The same holds for main: named, but not held until an import or a bind says so.
  const fresh = await f.declare([], 'kept');
  assert.deepEqual(await f.published(fresh), [['code', 'code_base_pending', 'main']]);
  const main = await f.state.read(
    async (sql) =>
      await sql.get<{ main_json: string }>(
        'SELECT main_json FROM code_projects WHERE project_id=?',
        f.project.id,
      ),
  );
  await run(
    'UPDATE code_projects SET main_json=? WHERE project_id=?',
    JSON.stringify({ ...(JSON.parse(main!.main_json) as object), stored: true }),
    f.project.id,
  );
  await f.code.reconcileAll();
  assert.deepEqual(await f.published(fresh), []);
  assert.equal((await f.pin(fresh)).kind, 'main');
});

test('units waiting on the same two accepted commits get one merged base, and a conflict holds them visibly', async (t) => {
  const f = await fixture(t);
  // A real repository beside the fixture: the commits the dependencies are accepted with
  // have to exist for the server to merge them.
  const root = mkdtempSync(join(tmpdir(), 'merv-auto-merge-'));
  const repositories = new CodeRepositories({
    root: join(root, 'code'),
    quotaBytes: 1024 * 1024 * 1024,
    reservedFreeBytes: 1,
  });
  mkdirSync(join(root, 'code', 'tmp'), { recursive: true });
  mkdirSync(join(root, 'code', 'empty-template'));
  await repositories.ensure(f.project.id, repository, 'sha1');
  const bare = repositories.paths(f.project.id).repository;
  const work = join(root, 'work');
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: work,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  git('config', 'user.email', 'test@localhost');
  git('config', 'user.name', 'Test');
  for (const name of ['f', 'g']) writeFileSync(join(work, `${name}.txt`), 'base\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const commit = (branch: string, file: string, text: string) => {
    git('checkout', '-q', '-B', branch, 'main');
    writeFileSync(join(work, file), text);
    git('commit', '-q', '-am', branch);
    git('push', '-q', bare, `${branch}:refs/heads/${branch}`);
    return git('rev-parse', 'HEAD');
  };
  const [a, b, c] = [
    commit('a', 'f.txt', 'base\nA\n'),
    commit('b', 'g.txt', 'base\nB\n'),
    commit('c', 'f.txt', 'base\nC\n'),
  ];
  // The composition hands the units their base records; here the test is the composition.
  const units = (
    f.code as unknown as {
      unitStore: {
        bases?: CodeBaseService;
        imported(tx: unknown, projectId: string): Promise<void>;
        baseSponsors(
          tx: import('@merv/contracts').Transaction,
          projectId: string,
          members: string[],
        ): Promise<string[]>;
      };
    }
  ).unitStore;
  await f.sessions.setDispatch(f.admin, { enabled: true });
  const bases = new CodeBaseService(f.state, repositories, {
    changed: async (tx, projectId) => await units.imported(tx, projectId),
    sponsors: (tx, projectId, members) => units.baseSponsors(tx, projectId, members),
    serviceWork: f.sessions.serviceWork,
  });
  await bases.initialize();
  units.bases = bases;
  t.after(async () => {
    await bases.close();
    await repositories.close(1000);
    rmSync(root, { recursive: true, force: true });
  });

  await f.bind(oid('a'), undefined, false);
  await f.state.transaction(async (tx) => {
    await tx.run(
      'UPDATE code_projects SET store_json=? WHERE project_id=?',
      JSON.stringify({ format: 1, objectFormat: 'sha1', rootOid: a }),
      f.project.id,
    );
    for (const [index, head] of [a, b, c].entries())
      await tx.run(
        "INSERT INTO code_operations (id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at,phase) VALUES (?,?,'actor:fixture',?,'import','hash','{}','completed',?,'now','now','refs_applied')",
        `cop_import_${index}`,
        f.project.id,
        `import-${index}`,
        JSON.stringify({ head }),
      );
  });
  const [left, right, other] = [await f.succeeded(a), await f.succeeded(b), await f.succeeded(c)];

  // A deployment may still disable the switch; the same hosted work stays visibly blocked.
  const disabled = new CodeBaseService(
    f.state,
    repositories,
    {
      changed: (tx, id) => units.imported(tx, id),
      sponsors: (tx, id, members) => units.baseSponsors(tx, id, members),
      serviceWork: f.sessions.serviceWork,
    },
    false,
  );
  units.bases = disabled;
  const paused = await f.declare([left.work, right.work], 'kept');
  assert.deepEqual(await f.published(paused), [['code', 'code_merge_required', 'merge']]);
  await assert.rejects(f.pin(paused), { code: 'code_merge_required' });
  units.bases = bases;
  await f.state.transaction((tx) => units.imported(tx, f.project.id));
  await disabled.close();

  // Three units on the same two dependencies: one record, one merge, one base for all.
  const waiters = [paused];
  for (let index = 1; index < 3; index++)
    waiters.push(await f.declare([left.work, right.work], 'kept'));
  for (const waiter of waiters)
    assert.deepEqual(await f.published(waiter), [['code', 'code_base_wait', 'merge']]);
  await assert.rejects(f.pin(waiters[0]!), { code: 'code_base_wait', status: 409 });
  await bases.work(f.project.id);
  // The accepted commits the base was made from ride along with the ready state: that
  // set is how a reader joins a unit to a base record without asking for its key.
  const ready = (await f.code.unit(f.admin, waiters[0]!.id)).baseStatus;
  assert.ok(ready?.status === 'ready');
  assert.deepEqual(
    { kind: ready.kind, merge: [...(ready.merge ?? [])].sort() },
    { kind: 'merged', merge: [a, b].sort() },
  );
  const pins = [];
  for (const waiter of waiters) {
    assert.deepEqual(await f.published(waiter), [], 'the wait is lifted for every waiter');
    pins.push(await f.pin(waiter));
  }
  assert.deepEqual(new Set(pins.map((pin) => pin.kind)), new Set(['merged']));
  assert.equal(new Set(pins.map((pin) => pin.reference)).size, 1, 'the identical commit');
  assert.deepEqual(
    pins[0]!.sources.map((source) => source.unitId).sort(),
    [left.work.id, right.work.id].sort(),
  );
  const parents = execFileSync(
    'git',
    ['--git-dir', bare, 'rev-list', '--parents', '-n', '1', pins[0]!.reference],
    { encoding: 'utf8' },
  )
    .trim()
    .split(' ')
    .slice(1);
  assert.deepEqual(parents.sort(), [a, b].sort());
  const rows = await f.state.read(
    async (sql) =>
      await sql.all<{ attempts: number | string }>(
        'SELECT attempts FROM code_bases WHERE project_id=?',
        f.project.id,
      ),
  );
  assert.deepEqual(
    rows.map((row) => Number(row.attempts)),
    [1],
  );

  // Two commits that change the same lines: the unit is held, and says why.
  const clash = await f.declare([left.work, other.work], 'kept');
  await bases.work(f.project.id);
  assert.deepEqual(await f.published(clash), [['code', 'code_merge_conflict', 'merge']]);
  const [blocker] = await f.workflows.blockers(f.admin, clash.id);
  assert.match(blocker!.message, /f\.txt/);
  await assert.rejects(f.pin(clash), { code: 'code_merge_conflict', status: 409 });

  await f.state.transaction((tx) =>
    f.code.reserveWriter(f.admin, { unitId: waiters[0]!.id, leaseId: 'quarantine-lease' }, tx),
  );
  const merged = (await f.state.read((sql) => bases.find(sql, f.project.id, [a, b])))!;
  // Release tells an inherited quarantine from an operator's own by the reason it was
  // given, so an operator may not write a reason that would have their own quarantine
  // retracted by the release of some unrelated base.
  await assert.rejects(
    bases.control(f.scope, f.admin, {
      key: merged.key,
      action: 'quarantine',
      reason: `${INHERITED_QUARANTINE}${merged.key}`,
      requestId: 'quarantine-reserved',
    }),
    { code: 'code_base_changed', status: 409 },
  );
  await bases.control(f.scope, f.admin, {
    key: merged.key,
    action: 'quarantine',
    reason: 'Incorrect combined result',
    requestId: 'quarantine',
  });
  const writer = await f.state.transaction((tx) =>
    f.code.writerStatus(f.admin, waiters[0]!.id, tx),
  );
  assert.equal(writer.state, 'recovery_required');
  assert.equal(writer.blocked?.code, 'code_quarantined');
  await assert.rejects(
    f.state.transaction((tx) =>
      f.code.reserveWriter(f.admin, { unitId: waiters[0]!.id, leaseId: 'quarantine-lease' }, tx),
    ),
    { code: 'code_quarantined' },
  );
  for (const waiter of waiters) {
    await assert.rejects(f.pin(waiter), { code: 'code_quarantined' });
    assert.equal((await f.code.unit(f.admin, waiter.id)).baseStatus?.status, 'blocked');
  }
  assert.equal(
    (await f.state.read((sql) => bases.find(sql, f.project.id, [a, b])))!.result!.commit,
    pins[0]!.reference,
  );

  // A quarantine given by mistake is not a one-way door. Releasing the base an operator
  // named retracts everything that inherited from it, so the work it reached is usable
  // again; the generation it put into recovery still ends through code.unit.fence.
  await bases.control(f.scope, f.admin, {
    key: merged.key,
    action: 'release',
    reason: 'The combined result was verified correct',
    requestId: 'release',
  });
  assert.equal(
    (await f.state.read((sql) => bases.find(sql, f.project.id, [a, b])))!.quarantined,
    false,
  );
  for (const waiter of waiters) {
    assert.deepEqual(
      (await f.workflows.blockers(f.admin, waiter.id)).map((blocker) => blocker.code),
      waiter.id === waiters[0]!.id ? ['code_recovery_required'] : [],
    );
    assert.notEqual((await f.code.unit(f.admin, waiter.id)).baseStatus?.status, 'blocked');
  }
  const released = await f.state.transaction((tx) =>
    f.code.writerStatus(f.admin, waiters[0]!.id, tx),
  );
  assert.equal(released.state, 'recovery_required');
  assert.equal(released.blocked?.code, 'code_recovery_required');
  const nextWriter = () =>
    f.state.transaction((tx) =>
      f.code.reserveWriter(f.admin, { unitId: waiters[0]!.id, leaseId: 'after-release' }, tx),
    );
  await assert.rejects(nextWriter(), { code: 'code_recovery_required' });
  // This fixture composes bases without a hosted transfer service; use its same durable
  // writer capability for the operator fence, including the transaction's observer.
  const writers = (f.code as unknown as { writerStore: CodeWriterService }).writerStore;
  const fenced = await f.state.transaction((tx) =>
    writers.fence(f.admin, { unitId: waiters[0]!.id, requestId: 'release-fence' }, tx),
  );
  assert.equal(fenced.state, 'closed');
  assert.deepEqual(await f.workflows.blockers(f.admin, waiters[0]!.id), []);
  const next = await nextWriter();
  assert.equal(next.generation, released.generation + 1);
  assert.equal(next.state, 'reserved');
  assert.equal((await f.pin(waiters[0]!)).reference, pins[0]!.reference);
});
