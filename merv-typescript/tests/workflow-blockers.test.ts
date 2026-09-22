import { createService } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  MervError,
  type Caller,
  type WorkflowDefinition,
  type WorkflowPolicy,
  type WorkflowProvidedBlockerInput,
} from '@merv/contracts';
import { Pool } from 'pg';
import { PostgresState, SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';

const definition: WorkflowDefinition = {
  name: 'build',
  version: 1,
  initial: 'building',
  states: ['building', 'built', 'abandoned'],
  terminal: ['built', 'abandoned'],
  edges: [
    { from: 'building', action: 'finish', to: 'built' },
    { from: 'building', action: 'abandon', to: 'abandoned' },
  ],
};
const policy = (workspace: boolean): WorkflowPolicy => ({
  successStates: ['built'],
  actions: [
    {
      name: 'finish',
      tool: 'build.finish',
      states: ['building'],
      transitions: ['finish'],
      instruction: 'Finish the build.',
      check: () => {},
    },
    {
      name: 'abandon',
      tool: 'build.abandon',
      states: ['building'],
      transitions: ['abandon'],
      suggested: false,
      instruction: 'Abandon the build.',
      check: () => {},
    },
  ],
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

const postgresUrl = process.env.MERV_TEST_POSTGRES_URL;
const backends = ['sqlite', 'postgres'] as const;
const optional = (backend: (typeof backends)[number]) => ({
  skip: backend === 'postgres' && !postgresUrl,
});
const refused = (code: string, status: number) => (error: unknown) =>
  error instanceof MervError && error.code === code && error.status === status;

async function fixture(t: TestContext, backend: (typeof backends)[number], schemaVersion?: number) {
  const schema = `blockers_test_${randomUUID().replaceAll('-', '')}`;
  const state =
    backend === 'sqlite'
      ? new SqliteState(':memory:')
      : await PostgresState.open({ connectionString: postgresUrl!, schema });
  const migrate = state.migrate.bind(state);
  const scope = await createService(new ProjectScope(state));
  const open = async (upTo?: number) => {
    state.migrate =
      upTo === undefined
        ? migrate
        : async (component, migrations) =>
            await migrate(
              component,
              component === 'workflows'
                ? migrations.filter((item) => item.version <= upTo)
                : migrations,
            );
    try {
      return await createService(new WorkflowsService(state, scope));
    } finally {
      state.migrate = migrate;
    }
  };
  let workflows = await open(schemaVersion);
  t.after(async () => {
    workflows.close();
    await state.close();
    if (backend === 'sqlite') return;
    const pool = new Pool({ connectionString: postgresUrl });
    try {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
  });
  const boot = await scope.bootstrap({ projectName: 'Blockers', actorName: 'Owner' });
  const owner: Caller = { actorId: boot.actor.id, projectId: boot.project.id };
  const publish = async (
    instanceId: string,
    blockers: WorkflowProvidedBlockerInput[],
    provider = 'probe',
  ) =>
    await state.transaction(
      async (tx) =>
        await workflows.replaceBlockers(
          { projectId: owner.projectId, instanceId, provider, blockers },
          tx,
        ),
    );
  return {
    state,
    owner,
    publish,
    get workflows() {
      return workflows;
    },
    reopen: async () => {
      workflows.close();
      workflows = await open();
    },
  };
}

const merge: WorkflowProvidedBlockerInput = {
  key: 'merge',
  code: 'probe_merge_required',
  message: 'Two accepted results must be combined first.',
  status: 409,
  next: 'Recreate the work on one of them.',
};

for (const backend of backends) {
  test(
    `${backend}: a published blocker gates the read and the overview, and leaves a named action alone`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      await f.workflows.register(definition, policy(false));
      const work = await f.workflows.start(f.owner, { workflow: 'build', requestId: 'start' });
      const free = await f.workflows.start(f.owner, { workflow: 'build', requestId: 'free' });
      assert.deepEqual(
        (await f.workflows.overview(f.owner)).ready.sort(),
        [work.id, free.id].sort(),
      );

      await f.publish(work.id, [
        { ...merge, related: [{ kind: 'build', id: free.id, label: 'The other build' }] },
      ]);
      const blocked = await f.workflows.evaluate(f.owner, work.id);
      assert.equal(blocked.nextAction, null);
      assert.equal(blocked.currentGate, 'probe_merge_required');
      assert.equal(
        blocked.instruction,
        'Two accepted results must be combined first. Recreate the work on one of them.',
      );
      assert.deepEqual(blocked.blockers[0], {
        code: 'probe_merge_required',
        message: merge.message,
        status: 409,
      });
      const [shown] = blocked.providerBlockers;
      assert.deepEqual(
        [shown.instanceId, shown.provider, shown.key, shown.next, shown.related],
        [
          work.id,
          'probe',
          'merge',
          merge.next,
          [{ kind: 'build', id: free.id, label: 'The other build' }],
        ],
      );
      const overview = await f.workflows.overview(f.owner);
      assert.deepEqual([overview.ready, overview.blocked], [[free.id], [work.id]]);
      assert.deepEqual(await f.workflows.blockers(f.owner), [shown]);
      assert.deepEqual(await f.workflows.blockers(f.owner, free.id), []);

      // Ending blocked work is asked about by name and answered on its own terms.
      const abandon = await f.workflows.evaluate(f.owner, work.id, { action: 'abandon' });
      assert.equal(abandon.nextAction?.action, 'abandon');
      assert.equal(abandon.providerBlockers.length, 1);

      // The age belongs to the code: a reworded opinion keeps it, a different code restarts it.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await f.publish(work.id, [{ ...merge, message: 'Reworded.' }]);
      const [reworded] = await f.workflows.blockers(f.owner, work.id);
      assert.equal(reworded.since, shown.since);
      assert.notEqual(reworded.updatedAt, shown.updatedAt);
      await f.publish(work.id, [{ ...merge, message: 'Reworded.' }]);
      assert.deepEqual(await f.workflows.blockers(f.owner, work.id), [reworded]);
      await f.publish(work.id, [{ ...merge, code: 'probe_other' }]);
      assert.notEqual((await f.workflows.blockers(f.owner, work.id))[0].since, shown.since);

      // One provider replaces only its own opinion.
      await f.publish(work.id, [{ ...merge, key: 'other' }], 'second');
      await f.publish(work.id, []);
      assert.deepEqual(
        (await f.workflows.blockers(f.owner, work.id)).map((item) => item.provider),
        ['second'],
      );

      await f.workflows.transition(f.owner, {
        instanceId: work.id,
        action: 'abandon',
        requestId: 'abandon',
        expectedRevision: work.revision,
      });
      assert.deepEqual(await f.workflows.blockers(f.owner), []);
      // Ending clears what was said while the work was open; a provider may still say what
      // ended work is waiting on afterwards, and ending it again never leaves that behind.
      await f.publish(work.id, [merge]);
      assert.deepEqual(
        (await f.workflows.blockers(f.owner)).map((item) => item.key),
        [merge.key],
      );
      assert.equal((await f.workflows.evaluate(f.owner, work.id)).currentGate, 'terminal');
      await f.publish(work.id, []);
      assert.deepEqual(await f.workflows.blockers(f.owner), []);

      await assert.rejects(
        f.publish(free.id, [{ ...merge, status: 200 }]),
        refused('invalid_blocker', 500),
      );
      await assert.rejects(f.publish(free.id, [merge, merge]), refused('invalid_blocker', 500));
      await assert.rejects(f.publish('missing', [merge]), refused('not_found', 404));
      const stranger: Caller = { actorId: 'nobody', projectId: f.owner.projectId };
      await assert.rejects(f.workflows.blockers(stranger));
    },
  );

  test(
    `${backend}: the blocker table arrives on a populated database and keeps its identity`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend, 5);
      await f.workflows.register(definition, policy(false));
      const work = await f.workflows.start(f.owner, { workflow: 'build', requestId: 'start' });
      await f.reopen();
      await f.workflows.register(definition, policy(false));
      assert.equal((await f.workflows.get(f.owner, work.id)).state, 'building');
      await f.publish(work.id, [merge]);
      await assert.rejects(
        f.state.transaction(
          async (tx) =>
            await tx.run("UPDATE wf_blockers SET provider='other' WHERE instance_id=?", work.id),
        ),
        // SQLite reports the trigger's words; PostgreSQL reports a refused constraint.
        /immutable|constraint/,
      );
      // Re-running the pinned migrations changes nothing.
      await f.reopen();
      assert.equal((await f.workflows.blockers(f.owner)).length, 1);
    },
  );

  test(
    `${backend}: a provider reads dependencies with the workspace fact of each persisted version`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      await f.workflows.register(definition, policy(false));
      const coded = await f.workflows.register({ ...definition, name: 'coded' }, policy(true));
      const plain = await f.workflows.start(f.owner, { workflow: 'build', requestId: 'plain' });
      const git = await f.workflows.start(f.owner, { workflow: 'coded', requestId: 'git' });
      const top = await f.workflows.start(f.owner, {
        workflow: 'build',
        requestId: 'top',
        dependsOn: [plain.id, git.id],
      });
      await f.workflows.transition(f.owner, {
        instanceId: git.id,
        action: 'finish',
        requestId: 'finish',
        expectedRevision: git.revision,
      });
      // The owning registration is withdrawn: the answer comes from the stored manifests.
      coded.dispose();
      const read = await f.state.transaction(
        async (tx) => await f.workflows.dependencyRelations(f.owner.projectId, top.id, tx),
      );
      assert.ok(read);
      assert.deepEqual(
        [
          read.instance.id,
          read.instance.settled,
          read.instance.terminal,
          read.instance.declaresWorkspace,
        ],
        [top.id, false, false, false],
      );
      assert.deepEqual(
        Object.fromEntries(
          read.dependencies.map((item) => [
            item.id,
            [item.settled, item.terminal, item.revision, item.declaresWorkspace],
          ]),
        ),
        { [plain.id]: [false, false, 0, false], [git.id]: [true, true, 1, true] },
      );
      const below = await f.state.transaction(
        async (tx) => await f.workflows.dependencyRelations(f.owner.projectId, git.id, tx),
      );
      assert.deepEqual(
        below?.dependents.map((item) => item.id),
        [top.id],
      );
      assert.equal(
        await f.state.transaction(
          async (tx) => await f.workflows.dependencyRelations(f.owner.projectId, 'missing', tx),
        ),
        null,
      );
    },
  );
}
