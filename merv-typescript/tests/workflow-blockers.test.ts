import { createService, migrationList } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  MervError,
  type Caller,
  type WorkflowDefinition,
  type WorkflowPolicy,
  type WorkflowProvidedBlockerInput,
} from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { openState } from './fixtures/state.js';

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
                base: 'reference:base' as const,
                retain: false,
                driver: 'probe.v1',
              },
            }
          : {}),
      },
    },
  ],
});

const refused = (code: string, status: number) => (error: unknown) =>
  error instanceof MervError && error.code === code && error.status === status;

async function fixture(t: TestContext, schemaVersion?: number) {
  const state = await openState();
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
                ? migrationList(migrations).filter((item) => item.version <= upTo)
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
  });
  const boot = await scope.credentials.bootstrap({ projectName: 'Blockers', actorName: 'Owner' });
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

test('a published blocker gates the read and the overview, and leaves a named action alone', async (t) => {
  const f = await fixture(t);
  const build = await f.workflows.register(definition, policy(false));
  const work = await build.start(f.owner, { workflow: 'build', requestId: 'start' });
  const free = await build.start(f.owner, { workflow: 'build', requestId: 'free' });
  assert.deepEqual((await f.workflows.overview(f.owner)).ready.sort(), [work.id, free.id].sort());

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

  // A cause is stored unread and read back as given; changing it alone is a new opinion, and
  // an opinion that names none has none.
  assert.equal(shown.cause, undefined);
  await f.publish(work.id, [{ ...merge, cause: 'budget_exceeded' }]);
  const [caused] = await f.workflows.blockers(f.owner, work.id);
  assert.equal(caused.cause, 'budget_exceeded');
  await new Promise((resolve) => setTimeout(resolve, 5));
  await f.publish(work.id, [{ ...merge, cause: 'capacity_full' }]);
  const [recaused] = await f.workflows.blockers(f.owner, work.id);
  assert.deepEqual([recaused.cause, recaused.since], ['capacity_full', caused.since]);
  assert.notEqual(recaused.updatedAt, caused.updatedAt);
  await f.publish(work.id, [merge]);
  assert.equal('cause' in (await f.workflows.blockers(f.owner, work.id))[0], false);
  await assert.rejects(
    f.publish(work.id, [{ ...merge, cause: '' }]),
    refused('invalid_blocker', 500),
  );

  // One provider replaces only its own opinion.
  await f.publish(work.id, [{ ...merge, key: 'other' }], 'second');
  await f.publish(work.id, []);
  assert.deepEqual(
    (await f.workflows.blockers(f.owner, work.id)).map((item) => item.provider),
    ['second'],
  );

  await build.transition(f.owner, {
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
});

test('the blocker table arrives on a populated database and keeps its identity', async (t) => {
  const f = await fixture(t, 5);
  const build = await f.workflows.register(definition, policy(false));
  const work = await build.start(f.owner, { workflow: 'build', requestId: 'start' });
  await f.reopen();
  await f.workflows.register(definition, policy(false));
  assert.equal((await f.workflows.get(f.owner, work.id)).state, 'building');
  await f.publish(work.id, [merge]);
  await assert.rejects(
    f.state.transaction(
      async (tx) =>
        await tx.run("UPDATE wf_blockers SET provider='other' WHERE instance_id=?", work.id),
    ),
    // The trigger refuses it; PostgreSQL keeps the reason inside the store.
    { code: 'state_constraint' },
  );
  // Re-running the pinned migrations changes nothing.
  await f.reopen();
  assert.equal((await f.workflows.blockers(f.owner)).length, 1);
});

test('a provider reads an instance, its edges and the pinned manifests of their versions', async (t) => {
  const f = await fixture(t);
  const build = await f.workflows.register(definition, policy(false));
  const coded = await f.workflows.register({ ...definition, name: 'coded' }, policy(true));
  const bare = await f.workflows.register(
    { ...definition, name: 'bare' },
    { ...policy(false), assignments: [] },
  );
  const none = policy(false);
  none.assignments![0]!.execution!.workspace = { mode: 'none' };
  const off = await f.workflows.register({ ...definition, name: 'off' }, none);
  const plain = await build.start(f.owner, { workflow: 'build', requestId: 'plain' });
  const git = await coded.start(f.owner, { workflow: 'coded', requestId: 'git' });
  const named = await off.start(f.owner, { workflow: 'off', requestId: 'off' });
  const unmanifested = await bare.start(f.owner, { workflow: 'bare', requestId: 'bare' });
  await bare.transition(f.owner, {
    instanceId: unmanifested.id,
    action: 'finish',
    requestId: 'finish-bare',
    expectedRevision: unmanifested.revision,
  });
  const top = await build.start(f.owner, {
    workflow: 'build',
    requestId: 'top',
    data: { goal: 'Ship the build' },
    dependsOn: [plain.id, git.id, unmanifested.id, named.id],
  });
  await coded.transition(f.owner, {
    instanceId: git.id,
    action: 'finish',
    requestId: 'finish',
    expectedRevision: git.revision,
  });
  // The owning registration is withdrawn: the answer comes from the stored manifests.
  coded.dispose();
  const read = await f.state.transaction(
    async (tx) => await f.workflows.relations(f.owner.projectId, top.id, tx),
  );
  assert.ok(read);
  // The engine's view is domain-free: the instance carries its data, not a goal. Whether a
  // version declares a workspace comes from its pinned manifests, the withdrawn one's too.
  assert.deepEqual(read.instance, {
    id: top.id,
    workflow: 'build',
    version: 1,
    name: 'build',
    state: 'building',
    revision: 0,
    settled: false,
    terminal: false,
    failed: false,
    declaresWorkspace: false,
    data: { goal: 'Ship the build' },
  });
  assert.deepEqual(
    Object.fromEntries(
      read.dependencies.map((item) => [
        item.id,
        [item.settled, item.terminal, item.revision, item.declaresWorkspace],
      ]),
    ),
    {
      [plain.id]: [false, false, 0, false],
      [git.id]: [true, true, 1, true],
      // A terminal dependency whose version pins no manifest declares no workspace.
      [unmanifested.id]: [true, true, 1, false],
      // A manifest that names the mode `none` declares none either.
      [named.id]: [false, false, 0, false],
    },
  );
  assert.equal(
    (await f.workflows.pinned('coded', 1))?.execution.building?.workspace?.mode,
    'ephemeral',
  );
  assert.equal(await f.workflows.pinned('coded', 2), null);
  // A version with no assignment pins that no state has a manifest.
  assert.deepEqual((await f.workflows.pinned('bare', 1))?.execution, { building: null });
  const below = await f.state.transaction(
    async (tx) => await f.workflows.relations(f.owner.projectId, git.id, tx),
  );
  assert.deepEqual(
    below?.dependents.map((item) => [item.id, item.declaresWorkspace]),
    [[top.id, false]],
  );
  assert.equal(below?.instance.declaresWorkspace, true);
  assert.equal(
    await f.state.transaction(
      async (tx) => await f.workflows.relations(f.owner.projectId, 'missing', tx),
    ),
    null,
  );
});

test('one write transaction reads an instance afresh after each move, and each reader gets a copy', async (t) => {
  const f = await fixture(t);
  const build = await f.workflows.register(definition, policy(false));
  const below = await build.start(f.owner, { workflow: 'build', requestId: 'below' });
  const above = await build.start(f.owner, { workflow: 'build', requestId: 'above' });
  const { projectId } = f.owner;
  await f.state.transaction(async (tx) => {
    const first = (await f.workflows.relations(projectId, above.id, tx))!;
    first.instance.data.changed = true;
    first.dependencies.push(first.instance);
    (await f.workflows.get(f.owner, above.id, tx)).data.changed = true;
    assert.deepEqual((await f.workflows.relations(projectId, above.id, tx))?.dependencies, []);
    assert.deepEqual((await f.workflows.get(f.owner, above.id, tx)).data, {});
    await build.addDependencies(
      f.owner,
      { instanceId: above.id, dependsOn: [below.id], expectedRevision: 0, requestId: 'add' },
      tx,
    );
    assert.equal((await f.workflows.get(f.owner, above.id, tx)).revision, 1);
    assert.deepEqual(
      (await f.workflows.relations(projectId, above.id, tx))?.dependencies.map((item) => [
        item.id,
        item.settled,
      ]),
      [[below.id, false]],
    );
    await build.transition(
      f.owner,
      { instanceId: below.id, action: 'finish', requestId: 'finish', expectedRevision: 0 },
      tx,
    );
    assert.deepEqual(
      (await f.workflows.relations(projectId, above.id, tx))?.dependencies.map((item) => [
        item.id,
        item.settled,
      ]),
      [[below.id, true]],
    );
    assert.equal((await f.workflows.get(f.owner, below.id, tx)).state, 'built');
  });
});

test('system reads name where instances stand and count the moves that recorded a value', async (t) => {
  const f = await fixture(t);
  const build = await f.workflows.register(definition, policy(false));
  const one = await build.start(f.owner, { workflow: 'build', requestId: 'one' });
  const two = await build.start(f.owner, { workflow: 'build', requestId: 'two' });
  await build.transition(f.owner, {
    instanceId: one.id,
    action: 'finish',
    requestId: 'finish',
    expectedRevision: 0,
    data: { sheetId: 'art_sheet', other: 'art_other' },
  });
  const { projectId } = f.owner;
  const read = await f.state.transaction(
    async (tx) => await f.workflows.revisions(projectId, [one.id, two.id, one.id, 'missing'], tx),
  );
  assert.deepEqual(
    Object.fromEntries(
      [...read].map(([key, { id, workflow, version, state, revision }]) => [
        key,
        { id, workflow, version, state, revision },
      ]),
    ),
    {
      [one.id]: { id: one.id, workflow: 'build', version: 1, state: 'built', revision: 1 },
      [two.id]: { id: two.id, workflow: 'build', version: 1, state: 'building', revision: 0 },
    },
  );
  assert.equal('data' in read.get(one.id)!, false);
  assert.equal(read.get(two.id)!.updatedAt, two.updatedAt);
  assert.equal((await f.workflows.revisions('elsewhere', [one.id])).size, 0);
  const moves = async (keys: string[], values: string[], action = 'finish') =>
    await f.workflows.moves(projectId, { action, keys, values });
  assert.equal(await moves(['sheetId'], ['art_sheet']), 1);
  assert.equal(await moves(['other', 'sheetId'], ['art_none', 'art_other']), 1);
  // The value must be the one recorded under a key named, by a move of the action named.
  assert.equal(await moves(['sheetId'], ['art_other']), 0);
  assert.equal(await moves(['sheetId'], ['art_sheet'], 'abandon'), 0);
  assert.equal(await moves(['sheetId'], []), 0);
  assert.equal(
    await f.workflows.moves('elsewhere', {
      action: 'finish',
      keys: ['sheetId'],
      values: ['art_sheet'],
    }),
    0,
  );
});

test('blockers are replaced only in a live transaction, and a closed service reads nothing', async (t) => {
  const f = await fixture(t);
  const build = await f.workflows.register(definition, policy(false));
  const work = await build.start(f.owner, { workflow: 'build', requestId: 'start' });
  const input = { projectId: f.owner.projectId, instanceId: work.id, provider: 'probe' };
  // A plain read's handle is no transaction: its statements would commit one at a time.
  await assert.rejects(
    f.state.read(
      async (sql) =>
        await f.workflows.replaceBlockers({ ...input, blockers: [merge] }, sql as never),
    ),
    refused('invalid_transaction', 400),
  );
  assert.deepEqual(await f.workflows.blockers(f.owner, work.id), []);

  f.workflows.close();
  await assert.rejects(f.workflows.open('build', null), refused('workflow_unavailable', 503));
  await assert.rejects(f.workflows.movedBy(work.id, 1), refused('workflow_unavailable', 503));
});
