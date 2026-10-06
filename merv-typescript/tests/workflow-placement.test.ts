/**
 * Where the engine's reads and commands run when no transaction is passed: in the caller's
 * ambient transaction if there is one; else a read in a read-only snapshot of its own, which
 * never waits for State's writer lock, and a command in a write transaction.
 */
import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import pg from 'pg';
import {
  createService,
  type Caller,
  type Transaction,
  type WorkflowDefinition,
  type WorkflowPolicy,
} from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { deferred } from './fixtures/deferred.js';
import { openState, postgresUrl, schemaFor } from './fixtures/state.js';

let observer: pg.Client | undefined;
after(async () => await observer?.end());

/** Whether any session waits for the writer lock of `schema` (see fixtures/writer-race.ts). */
async function lockWaiters(schema: string): Promise<number> {
  if (!observer) {
    observer = new pg.Client({ connectionString: postgresUrl });
    await observer.connect();
  }
  const { rows } = await observer.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_catalog.pg_locks
     WHERE locktype='advisory' AND NOT granted
       AND ((classid::bigint << 32) | objid::bigint) = pg_catalog.hashtextextended($1, 0)`,
    [`merv-state:${schema}`],
  );
  return rows[0]!.n;
}

const graph: WorkflowDefinition = {
  name: 'placed',
  version: 1,
  initial: 'open',
  states: ['open', 'done'],
  terminal: ['done'],
  edges: [{ from: 'open', action: 'finish', to: 'done' }],
};

async function fixture(t: TestContext) {
  const schema = schemaFor();
  const state = await openState(':memory:', { schema });
  const scope = await createService(new ProjectScope(state));
  const workflows = await createService(new WorkflowsService(state, scope));
  t.after(async () => {
    workflows.close();
    await state.close();
  });
  const boot = await scope.credentials.bootstrap({ projectName: 'Placement', actorName: 'Owner' });
  const owner: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  /** What the guard does to the instance it checks, on the transaction it is given. */
  const fault: { write?: (tx: Transaction, id: string) => Promise<unknown> } = {};
  const policy: WorkflowPolicy = {
    successStates: ['done'],
    limits: [{ name: 'finishes', from: 'open', actions: ['finish'], max: 1 }],
    actions: [
      {
        name: 'finish',
        states: ['open'],
        transitions: ['finish'],
        tool: 'placed.finish',
        instruction: 'Finish.',
        check: async ({ tx, snapshot }) => void (await fault.write?.(tx, snapshot.id)),
      },
    ],
    assignments: [
      {
        state: 'open',
        check: () => {},
        build: () => ({
          role: 'producer',
          label: 'Work',
          brief: 'Work.',
          references: [],
          handoff: { instruction: 'Finish.', tools: ['placed.finish'] },
          execution: { readOnly: false, tools: [] },
          context: null,
        }),
        execution: { readOnly: false, tools: [] },
        lease: {
          role: () => 'producer' as const,
          acquire: ({ leaseId }) => ({ leaseId }),
          check: () => {},
          release: () => {},
        },
      },
    ],
  };
  const handle = await workflows.register(graph, policy);
  const target = await handle.start(owner, { workflow: graph.name, requestId: 'target' });
  const instance = await handle.start(owner, {
    workflow: graph.name,
    requestId: 'instance',
    dependsOn: [target.id],
  });
  return { schema, state, workflows, owner, fault, handle, instance };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * Runs `operation` while another writer holds State's writer lock: 'free' when it settles on its
 * own, 'queued' as soon as it waits for the lock. Either way the writer then lets go and the
 * operation is awaited to its end, so its rejection still fails the test.
 */
async function whileWriterHeld(f: Fixture, operation: () => Promise<unknown>) {
  const locked = deferred();
  const release = deferred();
  const writer = f.state.transaction(async () => {
    locked.resolve();
    await release.promise;
  });
  await locked.promise;
  let settled = false;
  const running = operation().finally(() => {
    settled = true;
  });
  const queued = async () => {
    const deadline = Date.now() + 10_000;
    while (!settled) {
      if ((await lockWaiters(f.schema)) > 0) return 'queued' as const;
      if (Date.now() > deadline) throw new Error('The operation neither settled nor queued');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return 'free' as const;
  };
  try {
    return await Promise.race([running.then(() => 'free' as const), queued()]);
  } finally {
    release.resolve();
    await writer;
    await running;
  }
}

/** Every caller read, each checking what it returns. */
const reads: [string, (f: Fixture) => Promise<unknown>][] = [
  ['get', async (f) => assert.equal((await f.workflows.get(f.owner, f.instance.id)).revision, 0)],
  ['list', async (f) => assert.equal((await f.workflows.list(f.owner)).length, 2)],
  [
    'history',
    async (f) => assert.equal((await f.workflows.history(f.owner, f.instance.id)).length, 1),
  ],
  [
    'evaluate',
    async (f) =>
      assert.equal((await f.workflows.evaluate(f.owner, f.instance.id)).instanceId, f.instance.id),
  ],
  [
    'overview',
    async (f) => assert.equal((await f.workflows.overview(f.owner)).workflows.length, 2),
  ],
  [
    'process',
    async (f) => assert.equal((await f.workflows.process(f.owner, f.instance.id)).state, 'open'),
  ],
  [
    'assignment',
    async (f) => assert.equal((await f.workflows.assignment(f.owner, f.instance.id)).label, 'Work'),
  ],
  [
    'records',
    async (f) =>
      assert.equal(
        (await f.workflows.records(f.owner, [f.instance.id])).get(f.instance.id)?.dependencies
          .length,
        1,
      ),
  ],
  [
    'prerequisites',
    async (f) =>
      assert.equal(
        (await f.workflows.prerequisites(f.owner, [f.instance.id])).get(f.instance.id)?.length,
        1,
      ),
  ],
  [
    'limitStatusOf',
    async (f) =>
      assert.equal(
        (await f.workflows.limitStatusOf(f.owner, [f.instance.id], 'finishes')).get(f.instance.id)
          ?.remaining,
        1,
      ),
  ],
  [
    'dependencyClosure',
    async (f) =>
      assert.equal((await f.workflows.dependencyClosure(f.owner, f.instance.id)).length, 2),
  ],
  [
    'workStarts',
    async (f) => assert.deepEqual(await f.workflows.workStarts(f.owner, f.instance.id), []),
  ],
  ['blockers', async (f) => assert.deepEqual(await f.workflows.blockers(f.owner), [])],
  [
    'dispatchCandidates',
    async (f) => assert.equal((await f.workflows.dispatchCandidates(f.owner)).length, 2),
  ],
];

test('a read outside any transaction never waits for the writer lock; a command does', async (t) => {
  const f = await fixture(t);
  for (const [name, read] of reads)
    await t.test(name, async () => assert.equal(await whileWriterHeld(f, () => read(f)), 'free'));
  assert.equal(
    await whileWriterHeld(f, () =>
      f.workflows.begin(f.owner, { instanceId: f.instance.id, expectedRevision: 0 }),
    ),
    'queued',
  );
});

test('a read or command without a tx joins the transaction its caller is in', async (t) => {
  const f = await fixture(t);
  for (const [name, read] of reads)
    await t.test(name, async () => {
      await f.state.transaction(async () => await read(f));
    });
  // It sees that transaction's own writes.
  await f.state.transaction(async () => {
    await f.workflows.begin(f.owner, { instanceId: f.instance.id, expectedRevision: 0 });
    assert.equal((await f.workflows.workStarts(f.owner, f.instance.id)).length, 1);
    const moved = await f.handle.transition(f.owner, {
      instanceId: f.instance.id,
      expectedRevision: 0,
      action: 'finish',
      requestId: 'finish',
    });
    assert.equal((await f.workflows.process(f.owner, f.instance.id)).state, moved.state);
  });
});

test('in a plain read a command writes on the read connection and is still rechecked', async (t) => {
  const f = await fixture(t);
  const finish = () =>
    f.handle.transition(f.owner, {
      instanceId: f.instance.id,
      expectedRevision: 0,
      action: 'finish',
      requestId: 'finish',
    });
  f.fault.write = async (tx, id) =>
    await tx.run('UPDATE wf_instances SET data_json=? WHERE id=?', '{"tampered":true}', id);
  await assert.rejects(
    f.state.read(async () => await finish()),
    { code: 'invalid_workflow_policy', status: 500 },
  );
  f.fault.write = undefined;
  assert.equal((await f.state.read(async () => await finish())).state, 'done');
  assert.deepEqual((await f.workflows.get(f.owner, f.instance.id)).data, {});
});
