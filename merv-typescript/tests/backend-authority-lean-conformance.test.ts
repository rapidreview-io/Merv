import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CredentialStore, tokenDigest } from '@merv/identity/credentials';
import { Bindings } from '../packages/mounts/src/credentials.js';
import { Invocations } from '../packages/mounts/src/upstream.js';
import { MountRuntime } from '../packages/mounts/src/runtime.js';
import { CredentialServer } from './fixtures/credential-server.js';
import { randomBytes } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';
import {
  check,
  createService,
  type Caller,
  type WorkflowDefinition,
  type WorkflowPolicy,
} from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import { ToolRegistry } from '@merv/api';
import { openState } from './fixtures/state.js';
import { deferred } from './fixtures/deferred.js';

const secret = () => `ms_${randomBytes(32).toString('base64url')}`;
function barrier() {
  const entered = deferred(),
    release = deferred();
  return {
    entered: entered.promise,
    release: () => release.resolve(),
    hold: async () => {
      entered.resolve();
      await release.promise;
    },
  };
}
async function enteredBeforeCompletion(entered: Promise<void>, pending: Promise<unknown>) {
  await Promise.race([
    entered,
    pending.then(() => {
      throw new Error('Invocation completed before the required barrier');
    }),
  ]);
}

async function fixture(t: TestContext, member = false) {
  const origin = Date.now();
  let time = 0;
  const state = await openState();
  const scope = await createService(new ProjectScope(state, () => origin + time));
  const workflows = await createService(new WorkflowsService(state, scope));
  const events = await createService(new DurableEvents(state));
  const boot = await scope.bootstrap({ projectName: 'Composed authority', actorName: 'Owner' });
  let owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const issued = await scope.issueActor(owner, { name: 'Source', role: 'producer' });
  let source: Caller = {
    projectId: owner.projectId,
    actorId: issued.actor.id,
    credentialId: issued.credential.id,
  };
  const admin = await scope.acceptVerifiedIdentity({
    issuer: 'https://authority.test',
    subject: 'admin',
    expiresAt: new Date(origin + 1_000_000).toISOString(),
  });
  const user = await scope.acceptVerifiedIdentity({
    issuer: 'https://authority.test',
    subject: 'member',
    expiresAt: new Date(origin + 1_000_000).toISOString(),
  });
  if (member) {
    const project = await scope.createProject(admin, {
      name: 'Member authority',
      requestId: 'member-project',
    });
    await scope.addMember(admin, project.id, { subject: 'member', role: 'producer' });
    owner = await scope.caller(admin, project.id);
    source = await scope.caller(user, project.id);
  }
  await state.transaction(async (tx) => {
    await tx.run(
      'CREATE TABLE authority_leases(id TEXT PRIMARY KEY, actor TEXT NOT NULL, released BOOLEAN NOT NULL DEFAULT FALSE)',
    );
    await tx.run(
      'CREATE TABLE authority_effects(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor TEXT NOT NULL)',
    );
  });
  const definition: WorkflowDefinition = {
    name: 'authority_probe',
    version: 1,
    managed: true,
    initial: 'working',
    states: ['working'],
    terminal: [],
    edges: [],
  };
  const policy: WorkflowPolicy = {
    actions: [],
    assignments: [
      {
        state: 'working',
        check: async ({ caller, tx }) => {
          await scope.require(caller, 'write', tx);
        },
        build: async () => ({
          role: 'producer',
          label: 'Probe',
          brief: 'Composed backend authority',
          references: [],
          handoff: { instruction: 'Probe', tools: ['authority.write'] },
          execution: { readOnly: false, tools: [] },
          context: null,
        }),
        execution: {
          readOnly: false,
          tools: ['authority.write', '_bridge.mutate', '_bridge.inspect'].map((name) => ({
            name,
            alternatives: [{}],
          })),
        },
        references: async () => ({}),
        lease: {
          role: async ({ caller, tx }) => {
            await scope.require(caller, 'write', tx);
            return 'producer' as const;
          },
          acquire: async ({ caller, tx, leaseId }) => {
            await tx.run(
              'INSERT INTO authority_leases(id,actor) VALUES(?,?)',
              leaseId,
              caller.actorId,
            );
            return { leaseId };
          },
          check: async ({ caller, tx }, receipt) => {
            check(
              await tx.get(
                'SELECT id FROM authority_leases WHERE id=? AND actor=? AND released=FALSE',
                receipt.leaseId as string,
                caller.actorId,
              ),
              'stale_lease',
              'Exact lease required',
              409,
            );
          },
          release: async ({ lease, tx }) => {
            await tx.run(
              'UPDATE authority_leases SET released=TRUE WHERE id=? AND actor=?',
              lease.leaseId,
              lease.actorId,
            );
          },
        },
      },
    ],
  };
  let handle = await workflows.register(definition, policy);
  const sessions = await createService(
    new LeasedSessions(state, scope, workflows, events, {
      clock: () => origin + time,
      sweepIntervalMs: 60_000,
    }),
  );
  const callers: Caller[] = [],
    tokens: string[] = [];
  for (let i = 0; i < 2; i++) {
    const agent = await sessions.registerAgent(source, {
      name: `Agent ${i}`,
      runnerId: `runner-${i}`,
      requestId: `agent-${i}`,
      secret: secret(),
    });
    const target = await handle.start(source, {
      workflow: definition.name,
      requestId: `target-${i}`,
    });
    const token = secret();
    await sessions.offer(source, {
      instanceId: target.id,
      expectedRevision: 0,
      runnerId: `runner-${i}`,
      agentId: agent.id,
      requestId: `offer-${i}`,
      secret: token,
      hardDeadlineSeconds: 300,
    });
    tokens.push(token);
    callers.push(await sessions.authenticate(token));
  }
  const registry = new ToolRegistry(scope, scope.toolPolicy);
  let dispose = registry.registerSessionPolicy(sessions);
  const effect = async (caller: Caller) => {
    // A real effect sink, not an authorization oracle. Native writers independently check
    // transactional scope; the remote sink intentionally trusts registry admission.
    await state.transaction((tx) =>
      tx.run('INSERT INTO authority_effects(actor) VALUES(?)', caller.actorId),
    );
    return { content: [{ type: 'text' as const, text: 'effect' }] };
  };
  registry.register({
    name: 'authority.write',
    description: 'Authorized effect',
    inputSchema: z.object({}).strict(),
    handler: async (caller) =>
      state.transaction(async (tx) => {
        await scope.require(caller, 'write', tx);
        await tx.run('INSERT INTO authority_effects(actor) VALUES(?)', caller.actorId);
        return 'effect';
      }),
  });
  const catalog = registry.createCatalog('bridge');
  await catalog.replace([
    {
      kind: 'mcp',
      name: 'mutate',
      inputSchema: { type: 'object', additionalProperties: false },
      handler: effect,
    },
  ]);
  scope.toolPolicy.replace([
    {
      projectId: source.projectId,
      actorId: source.actorId,
      mountId: 'bridge',
      tools: ['mutate', 'inspect'],
    },
  ]);
  t.after(async () => {
    await registry.close();
    await sessions.close();
    await events.close();
    await workflows.close();
    await state.close();
  });
  return {
    state,
    scope,
    workflows,
    sessions,
    registry,
    source,
    owner,
    callers,
    tokens,
    issued,
    catalog,
    effect,
    admin,
    user,
    count: async () =>
      Number(
        (await state.read((sql) =>
          sql.get<{ n: string }>('SELECT count(*) AS n FROM authority_effects'),
        ))!.n,
      ),
    advance: (now: number) => {
      time = now;
    },
    replaceProvider: (install = true) => {
      dispose();
      if (install) dispose = registry.registerSessionPolicy(sessions);
    },
    reload: async () => {
      handle.dispose();
      handle = await workflows.register(definition, policy);
    },
  };
}

test('a real prepared invocation cannot validate as another live session', async (t) => {
  const f = await fixture(t);
  const invocation = await f.sessions.prepare(f.callers[0]!, 'authority.write', {});
  const substituted: Caller = {
    ...f.callers[1]!,
    session: { ...f.callers[1]!.session!, invocationId: invocation.caller.session!.invocationId },
  };
  await assert.rejects(f.sessions.validate(substituted, invocation.tool, {}), {
    code: 'session_invocation',
  });
  await f.sessions.validate(invocation.caller, invocation.tool, {});
  await f.sessions.run(invocation, (caller) => f.effect(caller));
  assert.equal(await f.count(), 1);
});

for (const install of [false, true])
  test(`remote dispatch fences a real Sessions provider ${install ? 'reinstalled' : 'removed'} during the final grant await`, async (t) => {
    const f = await fixture(t),
      held = barrier();
    t.after(held.release);
    const requirePolicy = f.scope.toolPolicy.require.bind(f.scope.toolPolicy);
    let calls = 0;
    t.mock.method(
      f.scope.toolPolicy,
      'require',
      async (...args: Parameters<typeof requirePolicy>) => {
        if (++calls === 2) await held.hold();
        await requirePolicy(...args);
      },
    );
    const pending = f.registry.call('_bridge.mutate', f.callers[0]!, {});
    const rejected = assert.rejects(pending, { code: 'session_unavailable' });
    await enteredBeforeCompletion(held.entered, pending);
    f.replaceProvider(install);
    held.release();
    await rejected;
    assert.equal(await f.count(), 0);
    if (install) {
      await f.registry.call('_bridge.mutate', f.callers[0]!, {});
      assert.equal(await f.count(), 1);
    }
  });

const modelDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../verification/lean');
const binary = resolve(modelDirectory, '.lake/build/bin/backend_authority_model');
const leanOptions = {
  timeout: 30_000,
  skip:
    !existsSync(binary) && process.env.MERV_REQUIRE_LEAN !== '1'
      ? 'Build backend_authority_model'
      : undefined,
};
type ModelRequest = { project: number; actor: number; credential: number; session: number | null };
type ModelCommand = { kind: string; [key: string]: unknown };
type Observation = { outcome: string; effects: number; upstreams: number[] };
const worker: ModelRequest = { project: 1, actor: 10, credential: 0, session: 10 };
const direct: ModelRequest = { project: 1, actor: 1, credential: 1, session: null };
const prepare = (request = worker, id = 1): ModelCommand => ({ kind: 'prepare', id, request });
const dispatch = (request = worker, id = 1): ModelCommand => ({ kind: 'dispatch', id, request });
function model(commands: ModelCommand[], member = false): Observation[] {
  assert.ok(existsSync(binary), 'Required compiled BackendAuthority oracle is missing');
  const directory = mkdtempSync(join(tmpdir(), 'merv-authority-oracle-'));
  const input = join(directory, 'input.json'),
    output = join(directory, 'output.json');
  writeFileSync(input, JSON.stringify({ commands, member }));
  const stdin = openSync(input, 'r'),
    stdout = openSync(output, 'w');
  try {
    const run = spawnSync(binary, [], {
      stdio: [stdin, stdout, 'pipe'],
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(readFileSync(output, 'utf8')).observations as Observation[];
  } finally {
    closeSync(stdin);
    closeSync(stdout);
    rmSync(directory, { recursive: true, force: true });
  }
}
async function outcome(pending: Promise<unknown>): Promise<string> {
  try {
    await pending;
    return 'effect';
  } catch (error) {
    assert.ok(
      [
        'forbidden',
        'unauthorized',
        'session_unavailable',
        'tool_forbidden',
        'session_closed',
        'session_expired',
        'session_invocation',
        'execution_replaced',
        'workflow_unavailable',
        'stale_lease',
        'membership_required',
        'invalid_delegation',
        'credential_forbidden',
        'unknown_tool',
        'remote_unavailable',
      ].includes((error as { code: string }).code),
      String(error),
    );
    return 'denied';
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const grant = (f: Fixture) => ({
  projectId: f.source.projectId,
  actorId: f.source.actorId,
  mountId: 'bridge',
  tools: ['mutate', 'inspect'],
});
const races: {
  name: string;
  changes: ModelCommand[];
  apply(f: Fixture, drains: Promise<void>[]): Promise<void> | void;
}[] = [
  { name: 'stable authority progresses', changes: [], apply: () => {} },
  {
    name: 'provider removal',
    changes: [{ kind: 'provider', installed: false }],
    apply: (f) => f.replaceProvider(false),
  },
  {
    name: 'same provider reinstall',
    changes: [{ kind: 'provider', installed: true }],
    apply: (f) => f.replaceProvider(),
  },
  {
    name: 'grant removal',
    changes: [{ kind: 'grants', installed: false }],
    apply: (f) => f.scope.toolPolicy.replace([]),
  },
  {
    name: 'restored grant recovers',
    changes: [
      { kind: 'grants', installed: false },
      { kind: 'grants', installed: true },
    ],
    apply: (f) => {
      f.scope.toolPolicy.replace([]);
      f.scope.toolPolicy.replace([grant(f)]);
    },
  },
  {
    name: 'source actor revocation',
    changes: [{ kind: 'revokeActor' }],
    apply: (f) => f.scope.revokeActor(f.owner, f.source.actorId),
  },
  {
    name: 'source credential revocation',
    changes: [{ kind: 'revokeCredential' }],
    apply: (f) => f.scope.revokeCredential(f.owner, f.source.credentialId!),
  },
  {
    name: 'Identity-only revocation despite live Scope row',
    changes: [{ kind: 'revokeCredential' }],
    apply: async (f) => {
      const ledger = new CredentialStore(f.state);
      await ledger.revoke(tokenDigest(f.issued.token), 'scope');
    },
  },
  {
    name: 'execution credential revocation',
    changes: [{ kind: 'revokeExecution', id: 10 }],
    apply: async (f) => {
      const ledger = new CredentialStore(f.state);
      await ledger.revoke(tokenDigest(f.tokens[0]!), 'sessions');
    },
  },
  {
    name: 'closed execution',
    changes: [{ kind: 'closeSession', id: 10 }],
    apply: async (f) => {
      await f.sessions.release(f.source, {
        sessionId: f.callers[0]!.session!.id,
        runnerId: 'runner-0',
      });
    },
  },
  { name: 'workflow replacement', changes: [{ kind: 'reloadWorkflow' }], apply: (f) => f.reload() },
  {
    name: 'exact expiry boundary',
    changes: [{ kind: 'advance', time: 300_000 }],
    apply: (f) => f.advance(300_000),
  },
  {
    name: 'last millisecond before expiry',
    changes: [{ kind: 'advance', time: 299_999 }],
    apply: (f) => f.advance(299_999),
  },
  {
    name: 'catalog withdrawal drains admitted calls',
    changes: [{ kind: 'catalog', installed: false, generation: 1 }],
    apply: (f, drains) => {
      drains.push(f.catalog.dispose());
    },
  },
  {
    name: 'catalog replacement retains admitted handler',
    changes: [{ kind: 'catalog', installed: true, generation: 1 }],
    apply: (f, drains) => {
      drains.push(
        f.catalog.replace([
          {
            kind: 'mcp',
            name: 'mutate',
            inputSchema: { type: 'object', additionalProperties: false },
            handler: () => {
              throw new Error('New handler must not reinterpret an admitted call');
            },
          },
        ]),
      );
    },
  },
];
for (const race of races)
  test(`Lean / real prepared registry composition: ${race.name}`, leanOptions, async (t) => {
    const f = await fixture(t),
      held = barrier(),
      drains: Promise<void>[] = [];
    t.after(held.release);
    const prepareReal = f.sessions.prepare.bind(f.sessions);
    t.mock.method(f.sessions, 'prepare', async (...args: Parameters<typeof prepareReal>) => {
      const result = await prepareReal(...args);
      await held.hold();
      return result;
    });
    const pending = outcome(f.registry.call('_bridge.mutate', f.callers[0]!, {}));
    await enteredBeforeCompletion(held.entered, pending);
    await race.apply(f, drains);
    held.release();
    const observed = {
      outcome: await pending,
      effects: await f.count(),
      upstreams: [] as number[],
    };
    observed.upstreams = Array(observed.effects).fill(100);
    await Promise.all(drains);
    const expected = model([prepare(), ...race.changes, dispatch()]).at(-1)!;
    assert.deepEqual(observed, expected);
  });

test(
  'Lean exact project/actor/credential/session binding agrees with real dispatch',
  leanOptions,
  async (t) => {
    const f = await fixture(t);
    const variants: [Caller, ModelRequest][] = [
      [
        { ...f.source, projectId: f.source.projectId + '-other' },
        { ...direct, project: 2 },
      ],
      [
        { ...f.source, actorId: f.owner.actorId },
        { ...direct, actor: 2 },
      ],
      [
        { ...f.source, credentialId: f.owner.credentialId },
        { ...direct, credential: 2 },
      ],
      [
        { ...f.callers[0]!, session: { ...f.callers[1]!.session! } },
        { ...worker, session: 11 },
      ],
      [
        { ...f.callers[0]!, credentialId: f.source.credentialId },
        { ...worker, credential: 1 },
      ],
      [f.callers[0]!, worker],
      [f.source, direct],
    ];
    let effects = 0;
    for (const [caller, request] of variants) {
      const actual = await outcome(f.registry.call('_bridge.mutate', caller, {}));
      const expected = model([prepare(request), dispatch(request)]).at(-1)!;
      assert.equal(actual, expected.outcome);
      effects += expected.effects;
      assert.equal(await f.count(), effects);
    }
  },
);

test(
  'real one-shot preparation, cancellation, workflow recovery and identity snapshot agree with Lean',
  leanOptions,
  async (t) => {
    const f = await fixture(t);
    const original = structuredClone(f.callers[0]!);
    const p = await f.sessions.prepare(f.callers[0]!, 'authority.write', {});
    f.callers[0]!.projectId = 'caller-mutated-after-preparation';
    await f.sessions.run(p, (caller) => f.effect(caller));
    assert.equal(
      await outcome(f.sessions.run(p, (caller) => f.effect(caller))),
      model([prepare(), dispatch(), dispatch()]).at(-1)!.outcome,
    );
    const cancelled = await f.sessions.prepare(original, 'authority.write', {});
    await f.sessions.cancel(cancelled);
    assert.equal(
      await outcome(f.sessions.run(cancelled, (caller) => f.effect(caller))),
      model([prepare(), { kind: 'cancel', id: 1 }, dispatch()]).at(-1)!.outcome,
    );
    await f.reload();
    await f.registry.call('_bridge.mutate', original, {});
    assert.equal(await f.count(), 2);
    assert.equal(
      model([{ kind: 'reloadWorkflow' }, prepare(), dispatch()]).at(-1)!.outcome,
      'effect',
    );
  },
);

async function mounted(t: TestContext, f: Fixture) {
  await f.catalog.dispose();
  const suffix = randomBytes(8).toString('hex').toUpperCase();
  const sourceEnv = `AUTHORITY_SOURCE_${suffix}`,
    discoveryEnv = `AUTHORITY_DISCOVERY_${suffix}`;
  const sourceToken = randomBytes(32).toString('hex'),
    discoveryToken = randomBytes(32).toString('hex');
  process.env[sourceEnv] = sourceToken;
  process.env[discoveryEnv] = discoveryToken;
  const server = new CredentialServer([
    { id: 'source', token: sourceToken, namespace: 'source-project', subject: 'source' },
    {
      id: 'discovery',
      token: discoveryToken,
      namespace: 'discovery-project',
      subject: 'discovery',
    },
  ]);
  await server.start();
  const configured = [
    {
      id: 'source-binding',
      projectId: f.source.projectId,
      actorId: f.source.actorId,
      mountId: 'bridge',
      secretRef: `env:${sourceEnv}`,
      headers: { 'x-sandbox-namespace': 'source-project', 'x-sandbox-subject': 'source' },
    },
    {
      id: 'discovery-binding',
      projectId: f.owner.projectId,
      actorId: f.owner.actorId,
      mountId: 'bridge',
      secretRef: `env:${discoveryEnv}`,
      headers: { 'x-sandbox-namespace': 'discovery-project', 'x-sandbox-subject': 'discovery' },
    },
  ];
  const bindings = new Bindings(f.scope, configured);
  const published = deferred();
  const createCatalog = f.registry.createCatalog.bind(f.registry);
  t.mock.method(f.registry, 'createCatalog', (...args: Parameters<typeof createCatalog>) => {
    const catalog = createCatalog(...args);
    return {
      ...catalog,
      replace: async (...definitions: Parameters<typeof catalog.replace>) => {
        await catalog.replace(...definitions);
        published.resolve();
      },
    };
  });
  const runtime = new MountRuntime(f.registry, bindings, f.scope, {
    id: 'bridge',
    url: server.url,
    tools: ['mutate', 'inspect'],
    discovery: { projectId: f.owner.projectId, actorId: f.owner.actorId },
    timeoutMs: 5000,
    reconnectMs: 60_000,
  });
  t.after(async () => {
    await runtime.stop();
    await server.close();
    delete process.env[sourceEnv];
    delete process.env[discoveryEnv];
  });
  runtime.refresh();
  await published.promise;
  return { server, runtime, bindings, configured, sourceToken, sourceEnv };
}

for (const race of races.filter((r) =>
  [
    'stable authority progresses',
    'same provider reinstall',
    'provider removal',
    'grant removal',
    'restored grant recovers',
    'Identity-only revocation despite live Scope row',
    'closed execution',
    'execution credential revocation',
    'workflow replacement',
    'exact expiry boundary',
  ].includes(r.name),
)) {
  test(`Lean / actual MCP cold connection: ${race.name}`, leanOptions, async (t) => {
    const f = await fixture(t),
      m = await mounted(t, f);
    const held = m.server.holdNextInitialize();
    t.after(held.release);
    const pending = outcome(f.registry.call('_bridge.mutate', f.callers[0]!, {}));
    await enteredBeforeCompletion(held.entered, pending);
    assert.equal(m.server.calls.length, 0, 'connection initialization is not a tool effect');
    await race.apply(f, []);
    held.release();
    const actual = {
      outcome: await pending,
      effects: m.server.calls.length,
      upstreams: m.server.calls.map((c) => (c.identity === 'source' ? 100 : 999)),
    };
    assert.deepEqual(actual, model([prepare(), ...race.changes, dispatch()]).at(-1));
    assert.equal(m.server.connections[0]!.identity, 'discovery');
    assert.ok(
      m.server.calls.every((call) => call.identity === 'source'),
      'discovery connection must never carry caller effects',
    );
    if (race.name === 'same provider reinstall' || race.name === 'stable authority progresses') {
      await f.registry.call('_bridge.mutate', f.callers[0]!, {});
      assert.equal(
        m.server.calls.length,
        actual.effects + 1,
        'fresh invocation recovers over the established caller connection',
      );
    }
  });
}

for (const roles of [['reader'], ['reader', 'producer'], ['remove', 'producer']] as const) {
  test(
    `member authority captured by Sessions stays invalid through ${roles.join(' / ')}`,
    leanOptions,
    async (t) => {
      const f = await fixture(t, true),
        held = barrier();
      t.after(held.release);
      const real = f.sessions.prepare.bind(f.sessions);
      t.mock.method(f.sessions, 'prepare', async (...args: Parameters<typeof real>) => {
        const p = await real(...args);
        await held.hold();
        return p;
      });
      const pending = outcome(f.registry.call('_bridge.mutate', f.callers[0]!, {}));
      await enteredBeforeCompletion(held.entered, pending);
      const changes: ModelCommand[] = [];
      for (const [i, role] of roles.entries()) {
        if (role === 'remove') {
          await f.scope.removeMember(f.admin, f.source.projectId, 'member');
          changes.push({ kind: 'removeMember' });
        } else {
          if (i > 0 && roles[0] === 'remove')
            await f.scope.addMember(f.admin, f.source.projectId, { subject: 'member', role });
          else
            await f.scope.changeMemberRole(f.admin, f.source.projectId, {
              subject: 'member',
              role,
            });
          changes.push({ kind: 'grantMember', role });
        }
      }
      held.release();
      const actual = { outcome: await pending, effects: await f.count(), upstreams: [] };
      assert.deepEqual(actual, model([prepare(), ...changes, dispatch()], true).at(-1));
      if (roles.at(-1) === 'producer') {
        const fresh = await f.scope.caller(f.user, f.source.projectId);
        await f.registry.call('authority.write', fresh, {});
        assert.equal(
          await f.count(),
          1,
          'fresh current membership recovers native write authority',
        );
      }
    },
  );
}

test(
  'mount reload uses changed exact bindings; retired catalog drains only its admitted request',
  leanOptions,
  async (t) => {
    const f = await fixture(t),
      m = await mounted(t, f);
    const held = m.server.holdNextCall();
    t.after(held.release);
    const pending = f.registry.call('_bridge.mutate', f.callers[0]!, {});
    await enteredBeforeCompletion(held.entered, pending);
    const stopped = m.runtime.stop();
    assert.equal(await outcome(f.registry.call('_bridge.mutate', f.callers[0]!, {})), 'denied');
    held.release();
    await pending;
    await stopped;
    assert.deepEqual(
      m.server.calls.map((call) => call.identity),
      ['source'],
    );
    // New load may deliberately select another upstream account. It cannot inherit the old pool.
    const changed = new Bindings(f.scope, [
      { ...m.configured[1]!, id: 'new-source-binding', actorId: f.source.actorId },
      m.configured[1]!,
    ]);
    const pool = new Invocations(
      { id: 'bridge', url: m.server.url, timeoutMs: 5000 },
      changed,
      f.scope.toolPolicy,
      f.registry,
    );
    const catalog = f.registry.createCatalog('bridge');
    await catalog.replace([
      {
        kind: 'mcp',
        name: 'mutate',
        inputSchema: { type: 'object', additionalProperties: false },
        handler: pool.handler('mutate'),
      },
    ]);
    t.after(async () => {
      await catalog.dispose();
      await pool.close();
    });
    await f.registry.call('_bridge.mutate', f.callers[0]!, {});
    assert.deepEqual(
      m.server.calls.map((call) => call.identity),
      ['source', 'discovery'],
    );
    assert.notEqual(m.server.calls[0]!.connectionId, m.server.calls[1]!.connectionId);
    const expected = model([
      prepare(),
      dispatch(),
      { kind: 'catalog', installed: false, generation: 1 },
      { kind: 'catalog', installed: true, generation: 2 },
      { kind: 'bindings', installed: true, upstream: 200 },
      prepare(worker, 2),
      dispatch(worker, 2),
    ]).at(-1)!;
    assert.deepEqual(
      {
        outcome: 'effect',
        effects: m.server.calls.length,
        upstreams: m.server.calls.map((call) => (call.identity === 'source' ? 100 : 200)),
      },
      expected,
    );
  },
);

test(
  'mount binding is exact and a revoked local Merv token cannot become an upstream credential',
  leanOptions,
  async (t) => {
    const f = await fixture(t),
      m = await mounted(t, f);
    const b = await m.bindings.select(f.callers[0]!, 'bridge');
    assert.equal(b.actorId, f.source.actorId, 'worker uses its live source binding');
    for (const caller of [
      { ...f.source, actorId: 'other' },
      { ...f.source, projectId: 'other' },
    ])
      await assert.rejects(m.bindings.select(caller, 'bridge'), { code: 'credential_forbidden' });
    await assert.rejects(m.bindings.select(f.source, 'other'), { code: 'credential_forbidden' });
    await f.scope.revokeCredential(f.owner, f.source.credentialId!);
    process.env[m.sourceEnv] = f.issued.token;
    await assert.rejects(m.bindings.headers(b), { code: 'credential_unavailable' });
    assert.equal(m.server.calls.length, 0);
    assert.equal(
      model([
        { kind: 'bindings', installed: false, upstream: 100 },
        prepare(direct),
        dispatch(direct),
      ]).at(-1)!.outcome,
      'denied',
    );
  },
);

for (const mutation of [
  'drop-provider-fence',
  'adopt-current-provider',
  'discovery-as-caller',
] as const) {
  test(
    `composed differential comparator detects live mutation: ${mutation}`,
    leanOptions,
    async (t) => {
      const f = await fixture(t);
      const changes: ModelCommand[] = [];
      let observed: Observation;
      if (mutation === 'drop-provider-fence') {
        const held = barrier();
        t.after(held.release);
        // Alter one production guard, preserving every database and service operation.
        t.mock.method(
          f.registry as unknown as { fence(registration: unknown): void },
          'fence',
          () => {},
        );
        const requirePolicy = f.scope.toolPolicy.require.bind(f.scope.toolPolicy);
        let calls = 0;
        t.mock.method(
          f.scope.toolPolicy,
          'require',
          async (...args: Parameters<typeof requirePolicy>) => {
            if (++calls === 2) await held.hold();
            await requirePolicy(...args);
          },
        );
        const pending = outcome(f.registry.call('_bridge.mutate', f.callers[0]!, {}));
        await enteredBeforeCompletion(held.entered, pending);
        f.replaceProvider();
        changes.push({ kind: 'provider', installed: true });
        held.release();
        observed = { outcome: await pending, effects: await f.count(), upstreams: [100] };
      } else {
        const m = await mounted(t, f);
        if (mutation === 'adopt-current-provider') {
          t.mock.method(
            f.registry,
            'validateSession',
            (...args: Parameters<ToolRegistry['validateSession']>) => f.sessions.validate(...args),
          );
          const held = m.server.holdNextInitialize();
          t.after(held.release);
          const pending = outcome(f.registry.call('_bridge.mutate', f.callers[0]!, {}));
          await enteredBeforeCompletion(held.entered, pending);
          f.replaceProvider();
          changes.push({ kind: 'provider', installed: true });
          held.release();
          observed = {
            outcome: await pending,
            effects: m.server.calls.length,
            upstreams: m.server.calls.map(() => 100),
          };
        } else {
          t.mock.method(m.bindings, 'select', async () => m.configured[1]!);
          const result = await outcome(f.registry.call('_bridge.mutate', f.callers[0]!, {}));
          observed = {
            outcome: result,
            effects: m.server.calls.length,
            upstreams: m.server.calls.map((c) => (c.identity === 'source' ? 100 : 999)),
          };
          assert.equal(m.server.calls[0]!.identity, 'discovery');
        }
      }
      assert.equal(observed.effects, 1, 'the injected fault must reach the real effect boundary');
      assert.throws(
        () => assert.deepEqual(observed, model([prepare(), ...changes, dispatch()]).at(-1)),
        { code: 'ERR_ASSERTION' },
      );
    },
  );
}

test(
  'failed real upstream initialization retires its connection and fresh dispatch recovers',
  leanOptions,
  async (t) => {
    const f = await fixture(t),
      m = await mounted(t, f);
    m.server.failNextInitialize('deterministic transport failure');
    assert.equal(await outcome(f.registry.call('_bridge.mutate', f.callers[0]!, {})), 'denied');
    assert.equal(m.server.calls.length, 0);
    await f.registry.call('_bridge.mutate', f.callers[0]!, {});
    assert.equal(m.server.calls.length, 1);
    assert.equal(
      m.server.initializeAttempts,
      3,
      'discovery, failed caller lane, successful replacement lane',
    );
    assert.deepEqual(
      { outcome: 'effect', effects: 1, upstreams: [100] },
      model([prepare(), { kind: 'cancel', id: 1 }, prepare(worker, 2), dispatch(worker, 2)]).at(-1),
    );
  },
);

test(
  'cold admitted mount dispatch retains its load binding while a successor uses changed credentials',
  leanOptions,
  async (t) => {
    const f = await fixture(t),
      m = await mounted(t, f);
    const held = m.server.holdNextInitialize();
    t.after(held.release);
    const pending = f.registry.call('_bridge.mutate', f.callers[0]!, {});
    await enteredBeforeCompletion(held.entered, pending);
    const stopped = m.runtime.stop();
    // The old catalog withdraws synchronously, leaving its admitted caller connection draining.
    // The successor can register while that connection is still at the initialize barrier.
    const changed = new Bindings(f.scope, [
      { ...m.configured[1]!, id: 'successor', actorId: f.source.actorId },
    ]);
    const pool = new Invocations(
      { id: 'bridge', url: m.server.url, timeoutMs: 5000 },
      changed,
      f.scope.toolPolicy,
      f.registry,
    );
    const catalog = f.registry.createCatalog('bridge');
    await catalog.replace([
      {
        kind: 'mcp',
        name: 'mutate',
        inputSchema: { type: 'object', additionalProperties: false },
        handler: pool.handler('mutate'),
      },
    ]);
    t.after(async () => {
      await catalog.dispose();
      await pool.close();
    });
    await f.registry.call('_bridge.mutate', f.callers[0]!, {});
    assert.deepEqual(
      m.server.calls.map((c) => c.identity),
      ['discovery'],
    );
    held.release();
    await pending;
    await stopped;
    const actual = {
      outcome: 'effect',
      effects: m.server.calls.length,
      upstreams: m.server.calls.map((c) => (c.identity === 'source' ? 100 : 200)),
    };
    const expected = model([
      prepare(),
      { kind: 'catalog', installed: false, generation: 1 },
      { kind: 'bindings', installed: true, upstream: 200 },
      { kind: 'catalog', installed: true, generation: 2 },
      prepare(worker, 2),
      dispatch(worker, 2),
      dispatch(),
    ]).at(-1);
    assert.deepEqual(actual, expected);
    await f.registry.call('_bridge.mutate', f.callers[0]!, {});
    assert.equal(
      m.server.calls.at(-1)!.identity,
      'discovery',
      'old cleanup cannot close the successor pool/catalog',
    );
  },
);
