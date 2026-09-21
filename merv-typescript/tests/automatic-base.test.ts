import {
  createService,
  digest,
  type WorkflowDefinition,
  type WorkflowPolicy,
  type WorkflowSnapshot,
} from '@merv/contracts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { Pool } from 'pg';
import { PostgresState, SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { WorkflowsService } from '@merv/workflows';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import { CodeService } from '@merv/code/service';

const oid = (char: string) => char.repeat(40);
const repository = 'runner-repository';
const postgresUrl = process.env.MERV_TEST_POSTGRES_URL;
const backends = ['sqlite', 'postgres'] as const;
const optional = (backend: (typeof backends)[number]) => ({
  skip: backend === 'postgres' && !postgresUrl,
});

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
const policy = (workspace: boolean): WorkflowPolicy => ({
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
              },
            }
          : {}),
      },
    },
  ],
});

async function fixture(t: TestContext, backend: (typeof backends)[number]) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-automatic-base-'));
  const schema = `automatic_base_${randomUUID().replaceAll('-', '')}`;
  const state =
    backend === 'sqlite'
      ? new SqliteState(join(directory, 'state.sqlite'))
      : await PostgresState.open({ connectionString: postgresUrl!, schema });
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
    if (backend === 'sqlite') return;
    const pool = new Pool({ connectionString: postgresUrl });
    try {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
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
  const accept = async (work: WorkflowSnapshot, commit: string | null, from = repository) => {
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
      storage: 'legacy-local',
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
  const declare = async (dependsOn: WorkflowSnapshot[]) => {
    const work = await start(dependsOn, 'coded');
    await state.transaction(async (tx) => await code.declareUnit(admin, work.id, tx));
    return work;
  };
  const bind = async (mainOid: string, expectedMainOid?: string) =>
    await code.bindLocal(admin, {
      repositoryId: repository,
      mainOid,
      ...(expectedMainOid === undefined ? {} : { expectedMainOid }),
      requestId: request(),
    });
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
    workflows,
    code,
    admin,
    project,
    plain,
    coded,
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

for (const backend of backends) {
  test(
    `${backend}: a unit with no accepted code beneath it starts from the project’s pinned main`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const note = await f.succeeded(null);
      const work = await f.declare([note.work]);
      // Unbound, nothing can be derived; the blocker is there from the moment the unit exists.
      assert.deepEqual(await f.published(work), [['code', 'code_base_pending', 'main']]);
      await assert.rejects(f.pin(work), { code: 'code_base_pending', status: 409 });
      const gated = await f.workflows.evaluate(f.admin, work.id);
      assert.deepEqual([gated.currentGate, gated.nextAction], ['code_base_pending', null]);
      assert.match(gated.instruction, /code\.local\.bind/);

      await f.bind(oid('a'));
      assert.deepEqual(await f.published(work), [], 'binding derives every waiting unit again');
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
      await f.coded.addDependencies(f.admin, {
        instanceId: work.id,
        dependsOn: [extra.work.id],
        expectedRevision: work.revision,
        requestId: f.request(),
      });
      await assert.rejects(f.pin(work, 'third'), { code: 'code_dependencies_changed' });
    },
  );

  test(
    `${backend}: one accepted commit becomes the base, through code-less successes and however many paths lead to it`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
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
        [
          'accepted',
          oid('c'),
          [{ unitId: harness.work.id, acceptanceHash: harness.acceptance.hash }],
        ],
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
    },
  );

  test(
    `${backend}: different accepted commits wait for a merge, and the blocker follows the work that ends`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      await f.bind(oid('a'));
      const left = await f.succeeded(oid('c'));
      const right = await f.start([], 'coded');
      const work = await f.declare([left.work, right]);
      assert.deepEqual(await f.published(work), []);

      // The second dependency ends while nobody is looking at the unit. An owner writes the
      // acceptance in the transaction of that transition, so it is there before the consumer
      // of the event derives what waits on the ended work; the next drain delivers it.
      const ended = await f.workflows.transition(f.admin, {
        instanceId: right.id,
        action: 'finish',
        requestId: f.request(),
        expectedRevision: 0,
      });
      await f.accept(ended, oid('d'));
      await f.move(await f.start());
      assert.deepEqual(await f.published(work), [['code', 'code_merge_required', 'merge']]);
      const [blocker] = await f.workflows.blockers(f.admin, work.id);
      assert.deepEqual(
        blocker!.related.map((item) => item.id).sort(),
        [left.work.id, right.id].sort(),
      );
      assert.match(blocker!.next, /baseTaskId/);
      await assert.rejects(f.pin(work), { code: 'code_merge_required', status: 409 });
      assert.equal((await f.code.unit(f.admin, work.id)).base, null);
      const overview = await f.workflows.overview(f.admin);
      assert.ok(overview.blocked.includes(work.id));
      assert.ok(!overview.ready.includes(work.id));

      // Ending the blocked work is still possible, and takes its blockers with it.
      await f.move(work, 'abandon');
      assert.deepEqual(await f.published(work), []);
      assert.equal((await f.code.unit(f.admin, work.id)).baseStatus, null);
    },
  );

  test(
    `${backend}: a success that cannot be verified blocks, whether or not its owner is loaded`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
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
      const sorted = async () =>
        (await f.published(work)).sort((a, b) => a[2]!.localeCompare(b[2]!));
      assert.deepEqual(await sorted(), expected);
      await assert.rejects(f.pin(work), { code: 'code_base_pending' });
      assert.equal((await f.code.unit(f.admin, work.id)).base, null, 'never pinned on main');

      // What a start after an absence does: the same answer, written again without change.
      await f.state.transaction(
        async (tx) => await tx.run('DELETE FROM wf_blockers WHERE instance_id=?', work.id),
      );
      await f.code.reconcileAll();
      assert.deepEqual(await sorted(), expected);
    },
  );
}
