/**
 * Where Scope's decisions and listings run, and whether they wait for State's writer lock.
 * A read decision or listing made outside any scope must not queue behind another writer; inside
 * a caller's scope it must use that scope rather than open a second transaction. Cases that fail
 * today are marked with the plan step that turns them on.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import pg from 'pg';
import {
  createService,
  type Caller,
  type DelegationSource,
  type Principal,
  type Transaction,
} from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { ExactToolPolicy } from '@merv/scope/tool-policy';
import { deferred } from './fixtures/deferred.js';
import { openState, postgresUrl, schemaFor, testLimits } from './fixtures/state.js';

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
  // the transaction it is handed, which a read decision must refuse. It records that transaction.
  const providers: { writes: boolean; handed?: { tx: Transaction; readScope: boolean } } = {
    writes: false,
  };
  scope.registerSessionAuthority({
    require: async (_caller, tx) => {
      providers.handed = { tx, readScope: state.readScope };
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
  // Another actor of the owner's project, whose credentials the owner lists as an administrator.
  const other = (await scope.issueActor(owner, { name: 'Other', role: 'producer' })).actor;
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
    other,
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
  [
    'projects(key)',
    async (f) =>
      assert.deepEqual(
        (await f.scope.projects(f.key)).map((value) => value.id),
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
  [
    'actorCredentials(owner, another actor)',
    async (f) => assert.equal((await f.scope.actorCredentials(f.owner, f.other.id)).length, 1),
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
    await t.test(name, async () =>
      assert.equal(await whileWriterHeld(f, () => operation(f)), 'free'),
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
    // A plain read opens a read-only snapshot on its own connection.
    await t.test(`${name} in a plain read, without the writer lock`, async () => {
      assert.equal(await whileWriterHeld(f, () => contexts.read(f, () => operation(f))), 'free');
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
    await t.test(`${name} outside any scope`, async () => {
      assert.equal(await whileWriterHeld(f, () => operation(f)), 'free');
    });
    await t.test(`${name} in a bare snapshot`, async () => {
      assert.equal(
        await whileWriterHeld(f, () => contexts.snapshot(f, () => operation(f))),
        'free',
      );
    });
    await t.test(`${name} in an ambient transaction`, async () => {
      await contexts.ambient(f, () => operation(f));
    });
    await t.test(`${name} in a snapshot with an open read transaction`, async () => {
      assert.equal(
        await whileWriterHeld(f, () => contexts.openRead(f, () => operation(f))),
        'free',
      );
    });
    await t.test(`${name} in a plain read`, async () => {
      assert.equal(await whileWriterHeld(f, () => contexts.read(f, () => operation(f))), 'free');
    });
  }
});

test('a listing in a transaction reads on that transaction', async () => {
  const f = await fixture();
  await f.state.transaction(async (tx) => {
    await tx.run('UPDATE projects SET name=? WHERE id=?', 'Renamed', f.project.id);
    assert.deepEqual(
      (await f.scope.projects(f.alice)).map((value) => value.name),
      ['Renamed'],
    );
  });
});

test('a repeat serviceActor never waits for the writer lock', async () => {
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

/** Where a session decision runs, by the scope its caller is in: the rows of the step 3 table. */
test('a provider decides on the transaction its caller is in', async (t) => {
  const f = await fixture();
  /** What the session provider was handed while `run` decided. */
  const asked = async (run: () => Promise<unknown>) => {
    f.providers.handed = undefined;
    await run();
    const { handed } = f.providers as Fixture['providers'];
    assert.ok(handed, 'the session provider was asked');
    return handed;
  };
  const decide = (permission: 'read' | 'write') => async () =>
    assert.equal((await f.scope.require(f.session, permission)).id, f.worker.id);
  await t.test('outside any scope, a read decision reads on a snapshot of its own', async () => {
    const { readScope } = await asked(decide('read'));
    assert.equal(readScope, true);
  });
  await t.test(
    'outside any scope, a write decision takes a write transaction of its own',
    async () => {
      // Every reader connection is held, so a write transaction nested in a plain read would wait.
      const release = deferred();
      const reads: Promise<unknown>[] = [];
      for (let n = 0; n < testLimits.readConnections; n++) {
        const held = deferred();
        reads.push(
          f.state.read(async () => {
            held.resolve();
            await release.promise;
          }),
        );
        await held.promise;
      }
      let timer: NodeJS.Timeout | undefined;
      try {
        const waiting = new Promise<'waiting for a reader'>((resolve) => {
          timer = setTimeout(resolve, 5_000, 'waiting for a reader');
        });
        const handed = await Promise.race([asked(decide('write')), waiting]);
        if (handed === 'waiting for a reader') assert.fail('The decision waited for a reader');
        assert.equal(handed.readScope, false);
      } finally {
        clearTimeout(timer);
        release.resolve();
        await Promise.all(reads);
      }
    },
  );
  for (const permission of ['read', 'write'] as const) {
    await t.test(`a ${permission} decision joins an ambient transaction`, async () => {
      await f.state.transaction(async (tx) => {
        assert.equal((await asked(decide(permission))).tx, tx);
      });
    });
    await t.test(`a ${permission} decision joins a snapshot's open read transaction`, async () => {
      await f.state.snapshot(() =>
        f.state.transaction(async (tx) => {
          assert.equal((await asked(decide(permission))).tx, tx);
        }),
      );
    });
    await t.test(`a ${permission} decision in a bare snapshot reads on it`, async () => {
      await f.state.snapshot(async () => {
        const { tx, readScope } = await asked(decide(permission));
        assert.ok(tx.transactionId);
        assert.equal(readScope, true);
      });
    });
    // Both on the read's own connection: a read decision on a read-only snapshot of its own.
    await t.test(
      `a ${permission} decision in a plain read takes a ${permission === 'read' ? 'read-only' : 'write'} transaction`,
      async () => {
        await f.state.read(async () => {
          const { tx, readScope } = await asked(decide(permission));
          assert.ok(tx.transactionId);
          assert.equal(readScope, permission === 'read');
        });
      },
    );
  }
  await t.test('a write decision in a plain read waits for the writer lock', async () => {
    assert.equal(await whileWriterHeld(f, () => f.state.read(decide('write'))), 'queued');
  });
  const vouched = async () =>
    assert.equal((await f.scope.authorityActor(f.session)).id, f.owner.actorId);
  await t.test('authorityActor outside any scope reads on a snapshot of its own', async () => {
    assert.equal((await asked(vouched)).readScope, true);
  });
  await t.test('authorityActor in a plain read reads on a snapshot of its own', async () => {
    await f.state.read(async () => assert.equal((await asked(vouched)).readScope, true));
  });
  await t.test('authorityActor joins an ambient transaction', async () => {
    await f.state.transaction(async (tx) => {
      assert.equal((await asked(vouched)).tx, tx);
    });
  });
});

test('the tool policy authorizes a session once, without the writer lock', async (t) => {
  const f = await fixture();
  const calls = { require: 0, authorityActor: 0 };
  const policy = new ExactToolPolicy(
    {
      require: async (...args) => {
        calls.require++;
        return await f.scope.require(...args);
      },
      authorityActor: async (...args) => {
        calls.authorityActor++;
        return await f.scope.authorityActor(...args);
      },
    },
    [
      {
        projectId: f.owner.projectId,
        actorId: f.owner.actorId,
        mountId: 'fixture',
        tools: ['look'],
      },
    ],
  );
  const checks: [string, () => Promise<unknown>][] = [
    ['allows', async () => assert.equal(await policy.allows(f.session, 'fixture', 'look'), true)],
    ['require', async () => await policy.require(f.session, 'fixture', 'look')],
  ];
  for (const [name, check] of checks)
    await t.test(name, async () => {
      calls.require = calls.authorityActor = 0;
      assert.equal(await whileWriterHeld(f, check), 'free');
      assert.deepEqual(calls, { require: 0, authorityActor: 1 });
    });
});

test('a plain write decision reads without the writer lock, as before', async () => {
  const f = await fixture();
  assert.equal(
    await whileWriterHeld(f, async () =>
      assert.equal((await f.scope.require(f.owner, 'write')).id, f.owner.actorId),
    ),
    'free',
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
  await t.test('outside any scope', refused);
  await t.test('in a bare snapshot', async () => {
    await contexts.snapshot(f, refused);
  });
  await t.test('in a plain read', async () => {
    await contexts.read(f, refused);
  });
});
