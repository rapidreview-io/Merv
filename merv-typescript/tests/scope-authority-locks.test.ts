/**
 * Where Scope's decisions and listings run, and whether they wait for State's writer lock.
 * A read decision or listing made outside any scope must not queue behind another writer; inside
 * a caller's scope it must use that scope rather than open a second transaction. Cases that fail
 * today are marked with the plan step that turns them on.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import pg from 'pg';
import { createService, type Caller, type DelegationSource, type Principal } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import type { ExactToolPolicy } from '@merv/scope/tool-policy';
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

async function fixture() {
  const schema = schemaFor();
  const state = await openState(':memory:', { schema });
  const scope = await createService(new ProjectScope(state));
  const boot = await scope.bootstrap({ projectName: 'Authority locks', actorName: 'Owner' });
  const owner: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const source = await scope.delegationSource(owner);
  const worker = await state.transaction((tx) =>
    scope.createSessionActor(
      source,
      { sessionId: 'session_locks', name: 'Worker', role: 'producer' },
      tx,
    ),
  );
  const session: Caller = {
    actorId: worker.id,
    projectId: worker.projectId,
    session: { id: 'session_locks' },
  };
  // Stub providers vouch for the owner. With `writes` set, the session provider also writes on
  // the transaction it is handed, which a read decision must refuse.
  const providers = { writes: false };
  scope.registerSessionAuthority({
    require: async (_caller, tx) => {
      if (providers.writes)
        await tx.run('UPDATE projects SET name=name WHERE id=?', boot.project.id);
      return source;
    },
  });
  scope.registerConversationAuthority({ require: async () => source });
  scope.registerManagedRunnerAuthority({ require: async () => source });
  const conversation: Caller = {
    actorId: owner.actorId,
    projectId: owner.projectId,
    conversation: {
      id: 'conversation_locks',
      epoch: 1,
      commandId: 'command_locks',
      runtimeId: 'runtime_locks',
    },
  };
  const managed: Caller = {
    actorId: owner.actorId,
    projectId: owner.projectId,
    managed: { allocationId: 'allocation_locks', epoch: 1, credentialHash: 'a'.repeat(64) },
  };
  const service = await scope.serviceActor('fixture', owner.projectId);
  const serviceSource: DelegationSource = { ...service, kind: 'service', vouchedBy: source };
  (scope.toolPolicy as ExactToolPolicy).replace([
    { projectId: owner.projectId, actorId: owner.actorId, mountId: 'fixture', tools: ['look'] },
  ]);
  const alice = await scope.acceptVerifiedIdentity({
    issuer: 'https://identity.example/auth/v1',
    subject: 'alice',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const project = await scope.createProject(alice, { name: 'Listings', requestId: 'listings' });
  const key: Principal = {
    kind: 'key',
    key: (await scope.createKey(alice, { projectId: project.id })).key,
  };
  return {
    schema,
    state,
    scope,
    owner,
    worker,
    session,
    conversation,
    managed,
    service,
    serviceSource,
    providers,
    alice,
    project,
    key,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Operation = (f: Fixture) => Promise<unknown>;

/**
 * Runs `operation` while another writer holds State's writer lock. 'free' when it settles on its
 * own; 'queued' as soon as it waits for the lock. Either way the writer then lets go and the
 * operation, with its own assertions, is awaited to its end.
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
    // A 'queued' operation settles only now; its rejection must still fail the test.
    await running;
  }
}

/** Group A: every provider-backed decision family, each checking what it returns. */
const decisions: [string, Operation][] = [
  [
    "require(session, 'read')",
    async (f) => assert.equal((await f.scope.require(f.session, 'read')).id, f.worker.id),
  ],
  [
    'authorityActor(session)',
    async (f) => assert.equal((await f.scope.authorityActor(f.session)).id, f.owner.actorId),
  ],
  [
    'toolPolicy.allows(session)',
    async (f) => assert.equal(await f.scope.toolPolicy.allows(f.session, 'fixture', 'look'), true),
  ],
  [
    "require(conversation, 'read')",
    async (f) => assert.equal((await f.scope.require(f.conversation, 'read')).id, f.owner.actorId),
  ],
  [
    "require(managed, 'read')",
    async (f) => assert.equal((await f.scope.require(f.managed, 'read')).id, f.owner.actorId),
  ],
  [
    "require(managed, 'write') refuses",
    async (f) =>
      await assert.rejects(f.scope.require(f.managed, 'write'), {
        code: 'managed_runner_forbidden',
        status: 403,
      }),
  ],
  [
    "requireDelegation(service source, 'read')",
    async (f) =>
      assert.equal(
        (await f.scope.requireDelegation(f.serviceSource, 'read')).id,
        f.service.actorId,
      ),
  ],
];

/** Group B: listings and caller resolution, each checking what it returns. */
const listings: [string, Operation][] = [
  [
    'caller(human)',
    async (f) =>
      assert.equal((await f.scope.caller(f.alice, f.project.id)).projectId, f.project.id),
  ],
  ['caller(key)', async (f) => assert.equal((await f.scope.caller(f.key)).projectId, f.project.id)],
  [
    'projects(human)',
    async (f) =>
      assert.deepEqual(
        (await f.scope.projects(f.alice)).map((value) => value.id),
        [f.project.id],
      ),
  ],
  ['keys(human)', async (f) => assert.equal((await f.scope.keys(f.alice)).length, 1)],
  [
    'memberships(human)',
    async (f) => assert.equal((await f.scope.memberships(f.alice, f.project.id)).length, 1),
  ],
  [
    'actorCredentials(owner)',
    async (f) => assert.equal((await f.scope.actorCredentials(f.owner)).length, 1),
  ],
];

/** The scopes a caller may already be in when it asks Scope, with no transaction passed. */
const contexts = {
  ambient: (f: Fixture, run: () => Promise<unknown>) => f.state.transaction(() => run()),
  snapshot: (f: Fixture, run: () => Promise<unknown>) => f.state.snapshot(() => run()),
  openRead: (f: Fixture, run: () => Promise<unknown>) =>
    f.state.snapshot(() => f.state.transaction(() => run())),
  read: (f: Fixture, run: () => Promise<unknown>) => f.state.read(() => run()),
};

test('read decisions outside any scope never wait for the writer lock', async (t) => {
  const f = await fixture();
  for (const [name, operation] of decisions)
    await t.test(
      name,
      // A managed runner's refusal comes before its provider is asked, so it never waited.
      { todo: name.includes("'write'") ? false : 'step 3' },
      async () => assert.equal(await whileWriterHeld(f, () => operation(f)), 'free'),
    );
});

test('read decisions use the scope their caller is already in', async (t) => {
  const f = await fixture();
  for (const [name, operation] of decisions) {
    await t.test(`${name} in an ambient transaction`, async () => {
      await contexts.ambient(f, () => operation(f));
    });
    await t.test(`${name} in a bare snapshot, without the writer lock`, async () => {
      assert.equal(
        await whileWriterHeld(f, () => contexts.snapshot(f, () => operation(f))),
        'free',
      );
    });
    await t.test(
      `${name} in a snapshot with an open read transaction, without the writer lock`,
      async () => {
        assert.equal(
          await whileWriterHeld(f, () => contexts.openRead(f, () => operation(f))),
          'free',
        );
      },
    );
    // A plain read scope gets a child write transaction on its own connection, as before.
    await t.test(`${name} in a plain read`, async () => {
      await contexts.read(f, () => operation(f));
    });
  }
});

test('sibling read decisions share one snapshot without colliding', async (t) => {
  const f = await fixture();
  const siblings = () =>
    Promise.all(
      decisions.filter(([name]) => !name.includes("'write'")).map(([, operation]) => operation(f)),
    );
  for (const context of ['snapshot', 'openRead'] as const)
    await t.test(context, async () => {
      assert.equal(await whileWriterHeld(f, () => contexts[context](f, siblings)), 'free');
    });
});

test('listings and caller resolution never wait for the writer lock', async (t) => {
  const f = await fixture();
  for (const [name, operation] of listings) {
    await t.test(`${name} outside any scope`, { todo: 'step 4' }, async () => {
      assert.equal(await whileWriterHeld(f, () => operation(f)), 'free');
    });
    await t.test(`${name} in a bare snapshot`, async () => {
      assert.equal(
        await whileWriterHeld(f, () => contexts.snapshot(f, () => operation(f))),
        'free',
      );
    });
    // Both fail today with nested_transaction.
    await t.test(`${name} in an ambient transaction`, { todo: 'step 4' }, async () => {
      await contexts.ambient(f, () => operation(f));
    });
    await t.test(
      `${name} in a snapshot with an open read transaction`,
      { todo: 'step 4' },
      async () => {
        assert.equal(
          await whileWriterHeld(f, () => contexts.openRead(f, () => operation(f))),
          'free',
        );
      },
    );
  }
});

test('a repeat serviceActor never waits for the writer lock', { todo: 'step 9' }, async () => {
  const f = await fixture();
  assert.equal(
    await whileWriterHeld(f, async () =>
      assert.deepEqual(await f.scope.serviceActor('fixture', f.owner.projectId), f.service),
    ),
    'free',
  );
});

test('a provider-backed write decision still waits for the writer lock', async () => {
  const f = await fixture();
  assert.equal(
    await whileWriterHeld(f, async () =>
      assert.equal((await f.scope.require(f.session, 'write')).id, f.worker.id),
    ),
    'queued',
  );
});

test('a provider cannot write on a read decision', async (t) => {
  const f = await fixture();
  const refused = async () => {
    f.providers.writes = true;
    try {
      await assert.rejects(f.scope.require(f.session, 'read'), {
        code: 'read_only_scope',
        status: 409,
      });
    } finally {
      f.providers.writes = false;
    }
  };
  await t.test('outside any scope', { todo: 'step 3' }, refused);
  await t.test('in a bare snapshot', async () => {
    await contexts.snapshot(f, refused);
  });
});
