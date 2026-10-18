/**
 * Where Scope's decisions and listings run, and whether they wait for State's writer lock.
 * A read decision or listing made outside any scope must not queue behind another writer; inside
 * a caller's scope it must use that scope rather than open a second transaction. Cases that fail
 * today are marked with the plan step that turns them on.
 */
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  createService,
  type Caller,
  type DelegationSource,
  type Principal,
  type Transaction,
} from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { ExactToolPolicy } from '@merv/scope/tool-policy';
import { ApiServer } from '../packages/api/src/http.js';
import { ToolRegistry } from '../packages/api/src/registry.js';
import { deferred } from './fixtures/deferred.js';
import { openState, schemaFor, testLimits, whileWriterHeld } from './fixtures/state.js';

async function fixture() {
  const schema = schemaFor();
  const state = await openState(':memory:', { schema });
  const scope = await createService(new ProjectScope(state));
  const boot = await scope.credentials.bootstrap({
    projectName: 'Authority locks',
    actorName: 'Owner',
  });
  const owner: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const source = await scope.delegationSource(owner);
  const worker = await state.transaction((tx) =>
    scope.createSessionActor(
      source,
      { threadId: 'session_locks', name: 'Worker', role: 'producer' },
      tx,
    ),
  );
  const session: Caller = {
    actorId: worker.id,
    projectId: worker.projectId,
    session: { id: 'session_locks', threadId: 'session_locks' },
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
      return { source };
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
  const other = (await scope.credentials.issueActor(owner, { name: 'Other', role: 'producer' }))
    .actor;
  const serviceSource: DelegationSource = { ...service, kind: 'service', vouchedBy: source };
  (scope.toolPolicy as ExactToolPolicy).replace([
    { projectId: owner.projectId, actorId: owner.actorId, mountId: 'fixture', tools: ['look'] },
  ]);
  const alice = await scope.members.acceptVerifiedIdentity({
    issuer: 'https://identity.example/auth/v1',
    subject: 'alice',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const project = await scope.members.createProject(alice, {
    name: 'Listings',
    requestId: 'listings',
  });
  const key: Principal = {
    kind: 'key',
    key: (await scope.userKeys.create(alice, { projectId: project.id })).key,
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
    'toolPolicy.granted(session)',
    async (f) =>
      assert.equal((await f.scope.toolPolicy.granted(f.session))('fixture', 'look'), true),
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
  ['keys(human)', async (f) => assert.equal((await f.scope.userKeys.keys(f.alice)).length, 1)],
  [
    'memberships(human)',
    async (f) => assert.equal((await f.scope.members.memberships(f.alice, f.project.id)).length, 1),
  ],
  [
    'actorCredentials(owner)',
    async (f) => assert.equal((await f.scope.credentials.actorCredentials(f.owner)).length, 1),
  ],
  [
    'actorCredentials(owner, another actor)',
    async (f) =>
      assert.equal((await f.scope.credentials.actorCredentials(f.owner, f.other.id)).length, 1),
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
    [
      'granted',
      async () => assert.equal((await policy.granted(f.session))('fixture', 'look'), true),
    ],
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

/**
 * A tool call's Scope decisions, counted where Scope makes them: a deciding caller resolution, a
 * read requirement, and the tool policy's grant check, which decides through Scope once. A tool
 * call's transport only names its caller; the registry decides once, where the tool acts: a
 * read inside its snapshot, a write or open-world read right before its handler, a mounted tool
 * by its grant check (founder, 2026-10-14). An open-world read is decided again after its
 * handler, a different moment. A listing is not a call: it still decides per part.
 */
async function calls(t: TestContext) {
  const state = await openState(':memory:');
  const scope = await createService(new ProjectScope(state));
  const boot = await scope.credentials.bootstrap({ projectName: 'Decisions', actorName: 'Owner' });
  const owner: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  // Twenty granted mounted tools, so a listing shows what its grant check costs.
  const mounted = Array.from({ length: 20 }, (_, n) => (n ? `look${n}` : 'look'));
  (scope.toolPolicy as ExactToolPolicy).replace([
    { projectId: owner.projectId, actorId: owner.actorId, mountId: 'fixture', tools: mounted },
  ]);
  const tools = new ToolRegistry(scope, scope.toolPolicy, (fn) => state.snapshot(fn));
  // A person signs in with `human.<subject>`.
  const issuer = 'https://identity.example/auth/v1';
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const identity = {
    verify: async (token: string) => ({ issuer, subject: token.slice(6), expiresAt }),
    configuration: () => ({}) as never,
  };
  const api = new ApiServer(scope, tools, { port: 0 }, identity);
  const url = await api.start();
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await api.stop();
    await tools.close();
    await state.close();
  });
  let ran = 0;
  const empty = z.object({}).strict();
  const native = (name: string, fields: object, handler = (_caller: Caller): unknown => ({})) =>
    tools.register({
      name,
      description: name,
      inputSchema: empty,
      handler: (caller: Caller) => (ran++, handler(caller)),
      ...fields,
    });
  native('fixture.read', { readOnly: true });
  native('fixture.write', {});
  native('fixture.open', { readOnly: true, openWorld: true });
  native('fixture.nest', { readOnly: true }, (caller) => tools.call('fixture.read', caller, {}));
  await tools.createCatalog('fixture').replace(
    mounted.map((name) => ({
      kind: 'mcp' as const,
      name,
      inputSchema: { type: 'object' as const },
      handler: async () => (ran++, { content: [] }),
    })),
  );
  // Alice runs a project where Bob produces; each has a key to it.
  const [alice, bob] = await Promise.all(
    ['alice', 'bob'].map((subject) =>
      scope.members.acceptVerifiedIdentity({ issuer, subject, expiresAt }),
    ),
  );
  const project = await scope.members.createProject(alice!, { name: 'People', requestId: 'p' });
  await scope.members.addMember(alice!, project.id, { subject: 'bob', role: 'producer' });
  const key = async (person: typeof alice) =>
    (await scope.userKeys.create(person!, { projectId: project.id })).token;
  // A decision that asks Scope again inside itself (caller resolution requires read) is one; a
  // resolution that only names the caller is none. `after` runs once a caller has been named.
  const deciding = new AsyncLocalStorage<true>();
  const counted = { decisions: 0, after: undefined as (() => Promise<unknown>) | undefined };
  for (const method of ['caller', 'require', 'authorityActor'] as const) {
    const decide = scope[method].bind(scope) as (...args: unknown[]) => Promise<unknown>;
    t.mock.method(scope, method, async (...args: unknown[]) => {
      const naming = method === 'caller' && args[2] === false;
      if (!deciding.getStore() && !naming) counted.decisions++;
      const value = await deciding.run(true, () => decide(...args));
      const after = naming ? counted.after : undefined;
      counted.after = undefined;
      await after?.();
      return value;
    });
  }
  const post = async (name: string, token: string) => {
    const response = await fetch(`${url}/tools/${name}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(token.startsWith('human.') && { 'x-merv-project-id': project.id }),
      },
      body: '{}',
    });
    return {
      status: response.status,
      body: (await response.json()) as { error?: { code: string } },
    };
  };
  const list = async (token: string) => {
    const response = await fetch(`${url}/tools`, { headers: { authorization: `Bearer ${token}` } });
    return { status: response.status, body: (await response.json()) as { tools?: unknown[] } };
  };
  const mcp = async (token: string) => {
    const client = new Client({ name: 'decisions', version: '1' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  };
  return {
    scope,
    boot,
    owner,
    tools,
    counted,
    post,
    list,
    mcp,
    alice,
    bob,
    project,
    key,
    ran: () => ran,
  };
}
const paths = ['fixture.read', 'fixture.write', 'fixture.open', 'fixture.nest', '_fixture.look'];

test('a tool call makes one Scope decision on every path', async (t) => {
  const f = await calls(t);
  const client = await f.mcp(f.boot.token);
  const decisions = async (request: () => Promise<unknown>) => {
    f.counted.decisions = 0;
    await request();
    return f.counted.decisions;
  };
  const post = (name: string, token: string) => async () =>
    assert.equal((await f.post(name, token)).status, 200);
  const call = (name: string) => async () =>
    assert.equal((await client.callTool({ name, arguments: {} })).isError, undefined);
  const counts: Record<string, number> = {};
  for (const name of paths) counts[`POST ${name}`] = await decisions(post(name, f.boot.token));
  counts['POST, as a person'] = await decisions(post('fixture.read', 'human.bob'));
  counts['POST, by user key'] = await decisions(post('fixture.read', await f.key(f.alice)));
  for (const name of paths)
    counts[`in-process ${name}`] = await decisions(() => f.tools.call(name, f.owner, {}));
  counts['MCP tools/list'] = await decisions(async () =>
    assert.equal((await client.listTools()).tools.length, 24),
  );
  counts['GET /tools'] = await decisions(async () =>
    assert.equal((await f.list(f.boot.token)).body.tools?.length, 24),
  );
  // Mounts' own connection pool adds its two when the tool is a real mount.
  for (const name of ['fixture.read', '_fixture.look'])
    counts[`MCP ${name}`] = await decisions(call(name));
  assert.deepEqual(counts, {
    ...Object.fromEntries(
      Object.keys(counts).map((path) => [
        path,
        // One for each call: a nested call shares its caller's snapshot, where Scope keeps the
        // outer decision, so it reads nothing again. An open-world read is also decided after
        // its handler, as a revocation while it waited withholds its result.
        path.endsWith('fixture.nest') || path.endsWith('fixture.open') ? 2 : 1,
      ]),
    ),
    // A listing's own, and one grant check for all twenty mounted tools.
    'MCP tools/list': 2,
    'GET /tools': 2,
  });
});

test('a credential or membership revoked after its call named it is refused, on every path', async (t) => {
  const f = await calls(t);
  // A fresh credential of the owner per path, revoked once the transport has named its caller.
  const credential = async () => {
    const issued = await f.scope.credentials.issueActorCredential(f.owner, {
      actorId: f.owner.actorId,
    });
    const caller = { ...f.owner, credentialId: issued.credential.id };
    const revoke = () => f.scope.credentials.revokeCredential(f.owner, issued.credential.id);
    return { token: issued.token, caller, revoke };
  };
  const refused = async (path: string, request: (token: string) => Promise<unknown>) => {
    const { token, revoke } = await credential();
    f.counted.after = revoke;
    const before = f.ran();
    await request(token);
    assert.equal(f.counted.after, undefined, `${path}: its caller was named before the decision`);
    assert.equal(f.ran(), before, `${path}: no handler ran`);
  };
  const forbidden = {
    code: 'forbidden',
    message: 'Credential cannot authorize this actor in this project',
  };
  for (const name of paths)
    await t.test(`POST ${name}`, async () => {
      await refused(name, async (token) =>
        assert.deepEqual(await f.post(name, token), { status: 403, body: { error: forbidden } }),
      );
    });
  for (const name of ['fixture.read', '_fixture.look'])
    await t.test(`MCP ${name}`, async () => {
      await refused(name, async (token) =>
        assert.deepEqual(await (await f.mcp(token)).callTool({ name, arguments: {} }), {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: forbidden }) }],
        }),
      );
    });
  await t.test('MCP tools/list', async () => {
    await refused('tools/list', async (token) =>
      assert.rejects((await f.mcp(token)).listTools(), { code: -32600, data: forbidden }),
    );
  });
  for (const name of paths)
    await t.test(`in-process ${name}`, async () => {
      const { caller, revoke } = await credential();
      await revoke();
      const before = f.ran();
      await assert.rejects(f.tools.call(name, caller, {}), { code: 'forbidden', status: 403 });
      assert.equal(f.ran(), before, 'no handler ran');
    });
  await t.test('a person, or their key, removed from the project', async () => {
    for (const token of ['human.bob', await f.key(f.bob)])
      for (const name of ['fixture.read', 'fixture.write']) {
        f.counted.after = () => f.scope.members.removeMember(f.alice!, f.project.id, 'bob');
        const before = f.ran();
        assert.equal((await f.post(name, token)).status, 403, name);
        assert.equal(f.counted.after, undefined);
        assert.equal(f.ran(), before, 'no handler ran');
        // Removed before the call, resolution refuses it already.
        const { body } = await f.post(name, token);
        assert.equal(body.error?.code, 'membership_required', name);
        await f.scope.members.addMember(f.alice!, f.project.id, {
          subject: 'bob',
          role: 'producer',
        });
      }
  });
});
