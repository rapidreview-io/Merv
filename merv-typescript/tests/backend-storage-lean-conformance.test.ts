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
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { createService, sha256Hex, type Blobs, type Caller, type Role } from '@merv/contracts';
import { ArtifactStore } from '@merv/artifacts';
import { DiskBlobs, S3Blobs } from '@merv/blobs';
import { ProjectScope } from '@merv/scope';
import { openState } from './fixtures/state.js';
import { s3Server } from './fixtures/s3-server.js';
import { deferred } from './fixtures/deferred.js';

const binary = fileURLToPath(
  new URL('../verification/lean/.lake/build/bin/backend_storage_model', import.meta.url),
);
const lean = {
  skip:
    !existsSync(binary) && process.env.MERV_REQUIRE_LEAN !== '1'
      ? 'Build backend_storage_model'
      : undefined,
};
const origin = Date.parse('2026-09-29T00:00:00.000Z');
const iso = (time: number) => new Date(origin + time).toISOString();
type ModelCaller = { actor: number; project: number; expires: number | null };
type Ticket = {
  actor: number;
  project: number;
  hash: string;
  size: number;
  title: string;
  media: string;
};
type Command =
  | { kind: 'grant'; actor: number; project: number; role: Role }
  | { kind: 'revoke'; actor: number }
  | { kind: 'advance'; time: number }
  | { kind: 'begin'; id: number; caller: ModelCaller; ticket: Ticket }
  | {
      kind: 'put';
      project: number;
      hash: string;
      content: { token: string; size: number };
      lost: boolean;
    }
  | { kind: 'start'; op: number; id: number; caller: ModelCaller }
  | { kind: 'finish'; op: number; outage: boolean; lost: boolean }
  | { kind: 'restart' };
type Observation = {
  outcome: string;
  tickets: (Ticket | null)[];
  attached: ({ serial: number; ticket: Ticket } | null)[];
  count: number;
};
const bytes = Buffer.from('immutable storage evidence\n');
const hash = sha256Hex(bytes);
const wrongBytes = Buffer.from('xxxxxxxxxxxxxxxxxxxxxxxxxx');
const wrongHash = sha256Hex(wrongBytes);
const largeBytes = Buffer.alloc(2_000_001, 97);
const largeHash = sha256Hex(largeBytes);
const payloads = new Map([
  [hash, bytes],
  [wrongHash, wrongBytes],
  [largeHash, largeBytes],
]);
const caller = (actor = 1, project = 1, expires: number | null = null): ModelCaller => ({
  actor,
  project,
  expires,
});
const ticket = (patch: Partial<Ticket> = {}): Ticket => ({
  actor: 1,
  project: 1,
  hash,
  size: bytes.length,
  title: 'Evidence',
  media: 'text/plain',
  ...patch,
});
const grant = (actor = 1, project = 1, role: Role = 'producer'): Command => ({
  kind: 'grant',
  actor,
  project,
  role,
});
const begin = (id = 1, c = caller(), t = ticket()): Command => ({
  kind: 'begin',
  id,
  caller: c,
  ticket: t,
});
const put = (project = 1, h = hash, lost = false): Command => ({
  kind: 'put',
  project,
  hash: h,
  content: { token: h, size: payloads.get(h)!.length },
  lost,
});
const start = (op = 1, id = 1, c = caller()): Command => ({ kind: 'start', op, id, caller: c });
const finish = (op = 1, outage = false, lost = false): Command => ({
  kind: 'finish',
  op,
  outage,
  lost,
});

function model(commands: Command[], ids: number[]): Observation[] {
  assert.ok(existsSync(binary), `Required Lean binary missing: ${binary}`);
  const dir = mkdtempSync(join(tmpdir(), 'merv-storage-oracle-'));
  writeFileSync(join(dir, 'input'), JSON.stringify({ commands, ids }));
  const input = openSync(join(dir, 'input'), 'r'),
    output = openSync(join(dir, 'output'), 'w');
  try {
    const child = spawnSync(binary, [], {
      stdio: [input, output, 'pipe'],
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(child.status, 0, child.stderr || String(child.error));
    return JSON.parse(readFileSync(join(dir, 'output'), 'utf8')).observations;
  } finally {
    closeSync(input);
    closeSync(output);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'merv-product-storage-'));
  const server = await s3Server();
  const blobs = new S3Blobs({
    bucket: 'merv-artifacts',
    endpoint: server.endpoint,
    accessKeyId: 'fixture-access-key',
    secretAccessKey: 'fixture-secret-key',
    prefix: 'product',
    allowHttpLoopbackForTests: true,
    timeoutMs: 5000,
    maxAttempts: 1,
  });
  let time = 0;
  let state = await openState(directory);
  let scope = await createService(new ProjectScope(state, () => origin + time));
  type Gate = {
    entered: ReturnType<typeof deferred<void>>;
    release: ReturnType<typeof deferred<void>>;
  };
  let nextGate: Gate | undefined;
  const adapter: Blobs = {
    put: (p, b) => blobs.put(p, b),
    get: (p, h) => blobs.get(p, h),
    upload: (p, h, n) => blobs.upload(p, h, n),
    download: (p, h, n, name) => blobs.download(p, h, n, name),
    stored: async (p, h) => {
      const gate = nextGate;
      nextGate = undefined;
      if (gate) {
        gate.entered.resolve();
        await gate.release.promise;
      }
      return blobs.stored(p, h);
    },
  };
  let artifacts = await createService(new ArtifactStore(state, scope, adapter));
  const projects = new Map<number, { projectId: string; admin: Caller }>();
  const actors = new Map<number, { actorId: string; project: number; credentialId: string }>();
  const allGates: Gate[] = [];
  t.after(async () => {
    for (const g of allGates) g.release.resolve();
    await blobs.close();
    await server.close();
    await state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const project = async (id: number) => {
    if (!projects.has(id)) {
      const boot = await scope.bootstrap({ projectName: `Storage ${id}`, actorName: 'Operator' });
      projects.set(id, {
        projectId: boot.project.id,
        admin: { projectId: boot.project.id, actorId: boot.actor.id },
      });
    }
    return projects.get(id)!;
  };
  const actualCaller = (c: ModelCaller): Caller => ({
    actorId: actors.get(c.actor)!.actorId,
    projectId: projects.get(c.project)!.projectId,
    ...(c.expires === null ? {} : { credentialId: actors.get(c.actor)!.credentialId }),
  });
  return {
    directory,
    server,
    blobs,
    adapter,
    projects,
    actors,
    project,
    actualCaller,
    get state() {
      return state;
    },
    get scope() {
      return scope;
    },
    get artifacts() {
      return artifacts;
    },
    advance(n: number) {
      time = n;
    },
    barrier() {
      const g = { entered: deferred(), release: deferred() };
      allGates.push(g);
      nextGate = g;
      return g;
    },
    clearBarrier() {
      nextGate = undefined;
    },
    async grant(id = 1, p = 1, role: Role = 'producer') {
      const owner = await project(p);
      const issued = await scope.issueActor(owner.admin, {
        name: `Actor ${id}`,
        role,
        expiresAt: iso(100),
      });
      actors.set(id, { actorId: issued.actor.id, project: p, credentialId: issued.credential.id });
      return actualCaller(caller(id, p));
    },
    async restart() {
      await state.close();
      state = await openState(directory);
      scope = await createService(new ProjectScope(state, () => origin + time));
      artifacts = await createService(new ArtifactStore(state, scope, adapter));
    },
    key(p: number, h: string) {
      return `product/${projects.get(p)!.projectId}/${h}`;
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const uploadInput = (t = ticket(), requestId = 'one') => ({
  title: t.title,
  mediaType: t.media,
  sha256: t.hash,
  size: t.size,
  requestId,
});
const result = async (fn: () => Promise<unknown>) => {
  try {
    return { outcome: 'complete', value: await fn() };
  } catch (e) {
    return { outcome: (e as { code: string }).code, value: undefined };
  }
};

// This driver calls production services and inspects PostgreSQL. It contains no expected-state
// machine; the independent Lean executable alone computes the expected observations.
async function implementation(
  t: TestContext,
  commands: Command[],
  ids: number[],
  staleAuthorization = false,
): Promise<Observation[]> {
  const f = await fixture(t);
  const uploads = new Map<number, string>();
  const operations = new Map<
    number,
    { gate: ReturnType<Fixture['barrier']>; value: ReturnType<typeof result> }
  >();
  const serials = new Map<string, number>();
  const observations: Observation[] = [];
  let stale: Awaited<ReturnType<typeof f.scope.require>> | undefined;
  for (const command of commands) {
    let outcome = '';
    switch (command.kind) {
      case 'grant':
        await f.grant(command.actor, command.project, command.role);
        outcome = 'granted';
        break;
      case 'revoke': {
        const actor = f.actors.get(command.actor)!;
        await f.scope.revokeActor(f.projects.get(actor.project)!.admin, actor.actorId);
        outcome = 'revoked';
        break;
      }
      case 'advance':
        f.advance(command.time);
        outcome = 'advanced';
        break;
      case 'begin': {
        const c = f.actualCaller(command.caller);
        const uploadId = `aup_${sha256Hex(JSON.stringify([c.projectId, c.actorId, `request-${command.id}`]))}`;
        if (!uploads.has(command.id)) uploads.set(command.id, uploadId);
        const r = await result(() =>
          f.artifacts.uploadBegin(c, uploadInput(command.ticket, `request-${command.id}`)),
        );
        outcome = r.outcome === 'complete' ? 'begun' : r.outcome;
        break;
      }
      case 'put': {
        const p = await f.project(command.project);
        const plan = await f.blobs.upload(p.projectId, command.hash, command.content.size);
        const body = payloads.get(command.content.token)!;
        const response = await fetch(plan.url, {
          method: 'PUT',
          headers: plan.headers,
          body: new Uint8Array(body),
        });
        outcome =
          response.status === 200
            ? command.lost
              ? 'lost'
              : 'stored'
            : response.status === 412
              ? 'exists'
              : 'bad_digest';
        assert.ok([200, 400, 412].includes(response.status));
        await response.arrayBuffer();
        break;
      }
      case 'start': {
        const c = f.actualCaller(command.caller);
        if (staleAuthorization && !stale) stale = await f.scope.require(c, 'write');
        const gate = f.barrier();
        const value = result(() =>
          f.artifacts.uploadComplete(c, uploads.get(command.id) ?? 'missing-upload'),
        );
        const entered = await Promise.race([
          gate.entered.promise.then(() => 'started'),
          value.then((v) => v.outcome),
        ]);
        outcome = entered;
        if (entered === 'started') operations.set(command.op, { gate, value });
        else {
          f.clearBarrier();
          gate.release.resolve();
        }
        break;
      }
      case 'finish': {
        const op = operations.get(command.op)!;
        assert.ok(op, 'only finish an actually pending production operation');
        if (command.outage) f.server.fail(503);
        const original = f.scope.require.bind(f.scope);
        if (staleAuthorization) f.scope.require = async () => stale!;
        op.gate.release.resolve();
        try {
          const r = await op.value;
          outcome = command.lost && r.outcome === 'complete' ? 'lost' : r.outcome;
        } finally {
          f.scope.require = original;
          f.server.fail();
          operations.delete(command.op);
        }
        break;
      }
      case 'restart':
        assert.equal(operations.size, 0);
        await f.restart();
        outcome = 'restarted';
        break;
    }
    const rows = await f.state.read((sql) =>
      sql.all<any>(
        'SELECT u.*,a.id AS retained_id FROM artifact_uploads u LEFT JOIN artifacts a ON a.id=u.artifact_id',
      ),
    );
    const byId = new Map(rows.map((row) => [row.upload_id, row]));
    const normalize = (row: any): Ticket => ({
      actor: [...f.actors].find(([, a]) => a.actorId === row.created_by)![0],
      project: [...f.projects].find(([, p]) => p.projectId === row.project_id)![0],
      hash: row.hash,
      size: Number(row.size),
      title: row.title,
      media: row.media_type,
    });
    const tickets = ids.map((id) => {
      const row = byId.get(uploads.get(id));
      return row ? normalize(row) : null;
    });
    const attached = ids.map((id) => {
      const row = byId.get(uploads.get(id));
      if (!row?.retained_id) return null;
      if (!serials.has(row.retained_id)) serials.set(row.retained_id, serials.size + 1);
      return { serial: serials.get(row.retained_id)!, ticket: normalize(row) };
    });
    const counts = await f.state.read((sql) =>
      sql.get<{ artifacts: number; events: number }>(
        "SELECT (SELECT count(*)::int FROM artifacts) AS artifacts,(SELECT count(*)::int FROM events WHERE type='artifact.created') AS events",
      ),
    );
    assert.equal(counts!.events, counts!.artifacts, 'exactly one event per retained artifact');
    // Check actual artifact facts and bytes, independently of upload metadata normalization.
    for (const row of rows.filter((r) => r.retained_id)) {
      const artifact = await f.state.read((sql) =>
        sql.get<any>('SELECT * FROM artifacts WHERE id=?', row.retained_id),
      );
      assert.deepEqual(normalize(artifact), normalize(row));
      if (artifact.content) {
        assert.equal(sha256Hex(artifact.content), artifact.hash);
        assert.equal(artifact.content.length, Number(artifact.size));
      }
    }
    observations.push({ outcome, tickets, attached, count: counts!.artifacts });
  }
  assert.equal(operations.size, 0, 'all deterministic barriers drained');
  return observations;
}

const scenarios: [string, Command[]][] = [
  [
    'positive upload, exact replay, reconnect, immutable conflicting begin',
    [
      grant(),
      begin(),
      put(),
      start(),
      finish(),
      start(2),
      { kind: 'restart' },
      start(3),
      begin(),
      begin(1, caller(), ticket({ title: 'Changed' })),
    ],
  ],
  [
    'pending file recovers after lost object response',
    [
      grant(),
      begin(),
      start(),
      finish(),
      put(1, hash, true),
      put(),
      { kind: 'restart' },
      start(2),
      finish(2),
    ],
  ],
  [
    'storage outage retains ticket and retry succeeds',
    [grant(), begin(), put(), start(), finish(1, true), start(2), finish(2)],
  ],
  [
    'lost DB response and reconnect replay exactly once',
    [
      grant(),
      begin(),
      put(),
      start(),
      finish(1, false, true),
      { kind: 'restart' },
      start(2),
      begin(),
    ],
  ],
  [
    'two finalizers complete in reverse admission order',
    [grant(), begin(), put(), start(1), start(2), finish(2), finish(1), start(3)],
  ],
  [
    'revoke while object lookup is pending leaves no artifact',
    [grant(), begin(), put(), start(), { kind: 'revoke', actor: 1 }, finish(), start(2)],
  ],
  [
    'credential expiry at boundary while I/O pending',
    [
      grant(),
      begin(1, caller(1, 1, 100)),
      put(),
      start(1, 1, caller(1, 1, 100)),
      { kind: 'advance', time: 100 },
      finish(),
      start(2, 1, caller(1, 1, 100)),
    ],
  ],
  [
    'credential one tick before expiry can retain',
    [
      grant(),
      begin(),
      put(),
      start(1, 1, caller(1, 1, 100)),
      { kind: 'advance', time: 99 },
      finish(),
    ],
  ],
  [
    'same-project actor cannot complete another actor ticket',
    [grant(), grant(2), begin(), put(), start(1, 1, caller(2)), start(2), finish(2)],
  ],
  [
    'cross-project identical content needs its own object',
    [
      grant(),
      grant(2, 2),
      begin(),
      begin(2, caller(2, 2), ticket({ actor: 2, project: 2 })),
      put(),
      start(1, 2, caller(2, 2)),
      finish(),
      put(2),
      start(2, 2, caller(2, 2)),
      finish(2),
      start(3, 1, caller(2, 2)),
    ],
  ],
  [
    'dedup keeps separate immutable artifact rows',
    [
      grant(),
      begin(),
      begin(2, caller(), ticket({ title: 'Second' })),
      put(),
      start(1),
      finish(1),
      start(2, 2),
      finish(2),
      put(),
    ],
  ],
  [
    'wrong checksum cannot retain; correct upload recovers',
    [
      grant(),
      begin(),
      {
        kind: 'put',
        project: 1,
        hash,
        content: { token: wrongHash, size: wrongBytes.length },
        lost: false,
      },
      start(),
      finish(),
      put(),
      start(2),
      finish(2),
    ],
  ],
  [
    'wrong declared size cannot attach',
    [grant(), begin(1, caller(), ticket({ size: bytes.length + 1 })), put(), start(), finish()],
  ],
  [
    'large objects finalize without inline GET',
    [
      grant(),
      begin(1, caller(), ticket({ hash: largeHash, size: largeBytes.length })),
      put(1, largeHash),
      start(),
      finish(),
      start(2),
    ],
  ],
  ['read-only role cannot create a ticket or finalize', [grant(1, 1, 'reader'), begin(), start()]],
];
for (const [name, commands] of scenarios)
  test(`storage Lean: ${name}`, lean, async (t) => {
    const ids = [
      ...new Set(
        commands
          .filter((c): c is Extract<Command, { kind: 'begin' }> => c.kind === 'begin')
          .map((c) => c.id),
      ),
    ].sort();
    assert.deepEqual(await implementation(t, commands, ids), model(commands, ids));
  });

test(
  'storage mutation control: removing fresh write authority diverges from Lean after revocation',
  lean,
  async (t) => {
    const commands: Command[] = [
      grant(),
      begin(),
      put(),
      start(),
      { kind: 'revoke', actor: 1 },
      finish(),
    ];
    const expected = model(commands, [1]);
    const mutated = await implementation(t, commands, [1], true);
    assert.notDeepEqual(mutated, expected);
    assert.equal(expected.at(-1)!.count, 0);
    assert.equal(mutated.at(-1)!.count, 1);
  },
);

async function storedUpload(f: Fixture, c: Caller, value = bytes, requestId = 'prepared') {
  const facts = ticket({ hash: sha256Hex(value), size: value.length });
  const plan = await f.artifacts.uploadBegin(c, uploadInput(facts, requestId));
  if (plan.parts.length) {
    const response = await fetch(plan.parts[0]!.url, {
      method: 'PUT',
      headers: plan.parts[0]!.headers,
      body: new Uint8Array(value),
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  return plan;
}
async function counts(f: Fixture) {
  return await f.state.read((sql) =>
    sql.get<{ artifacts: number; completed: number; events: number }>(
      "SELECT (SELECT count(*)::int FROM artifacts) AS artifacts,(SELECT count(*)::int FROM artifact_uploads WHERE artifact_id IS NOT NULL) AS completed,(SELECT count(*)::int FROM events WHERE type='artifact.created') AS events",
    ),
  );
}

for (const method of ['HEAD', 'GET'])
  for (const withdrawal of ['revoke', 'expire']) {
    test(`storage barrier: ${withdrawal} during real S3 ${method} rejects final attachment`, async (t) => {
      const f = await fixture(t);
      await f.grant();
      const c = f.actualCaller(caller(1, 1, 100));
      const plan = await storedUpload(f, c);
      const held = f.server.holdNext(method);
      const pending = f.artifacts.uploadComplete(c, plan.uploadId);
      const denied = assert.rejects(pending, { code: 'forbidden' });
      await held.started;
      if (withdrawal === 'revoke') await f.scope.revokeActor(f.projects.get(1)!.admin, c.actorId);
      else f.advance(100);
      held.release();
      await denied;
      assert.deepEqual(await counts(f), { artifacts: 0, completed: 0, events: 0 });
      assert.deepEqual(
        f.server.objects.get(f.key(1, hash)),
        bytes,
        'orphan bytes retained for recovery/inspection',
      );
    });
  }

test('storage: begin HEAD failure persists its ticket; retry and resume recover the exact upload', async (t) => {
  const f = await fixture(t);
  const c = await f.grant();
  f.server.fail(503);
  await assert.rejects(f.artifacts.uploadBegin(c, uploadInput()), { code: 'blob_unavailable' });
  const retained = await f.state.read((sql) =>
    sql.all<{ upload_id: string }>('SELECT upload_id FROM artifact_uploads'),
  );
  assert.equal(retained.length, 1);
  f.server.fail();
  const retried = await f.artifacts.uploadBegin(c, uploadInput());
  const resumed = await f.artifacts.uploadResume(c, retained[0]!.upload_id);
  assert.equal(retried.uploadId, retained[0]!.upload_id);
  assert.equal(resumed.uploadId, retried.uploadId);
  assert.equal(resumed.parts.length, 1);
  assert.deepEqual(await counts(f), { artifacts: 0, completed: 0, events: 0 });
});

test('storage: transaction rollback after artifact insert leaves no event/binding; retry recovers', async (t) => {
  const f = await fixture(t);
  const c = await f.grant();
  const plan = await storedUpload(f, c);
  const transaction = f.state.transaction.bind(f.state);
  let fault = true;
  f.state.transaction = (async (fn) =>
    transaction(async (tx) => {
      const run = tx.run;
      tx.run = async (sql, ...params) => {
        if (fault && sql.startsWith('UPDATE artifact_uploads SET artifact_id=')) {
          fault = false;
          throw new Error('injected before binding update');
        }
        return run(sql, ...params);
      };
      return await fn(tx);
    })) as typeof f.state.transaction;
  await assert.rejects(
    f.artifacts.uploadComplete(c, plan.uploadId),
    /injected before binding update/,
  );
  assert.deepEqual(await counts(f), { artifacts: 0, completed: 0, events: 0 });
  f.state.transaction = transaction;
  const artifact = await f.artifacts.uploadComplete(c, plan.uploadId);
  assert.equal((await f.artifacts.uploadComplete(c, plan.uploadId)).id, artifact.id);
  assert.deepEqual(await counts(f), { artifacts: 1, completed: 1, events: 1 });
});

test('storage: exception after actual DB commit is recovered through a new connection with exact metadata', async (t) => {
  const f = await fixture(t);
  const c = await f.grant();
  const plan = await storedUpload(f, c);
  const transaction = f.state.transaction.bind(f.state);
  let lost = false;
  f.state.transaction = (async (fn) => {
    const value = await transaction(fn);
    if (!f.state.readScope && !lost && value && typeof value === 'object' && 'hash' in value) {
      lost = true;
      throw new Error('lost committed response');
    }
    return value;
  }) as typeof f.state.transaction;
  await assert.rejects(f.artifacts.uploadComplete(c, plan.uploadId), /lost committed response/);
  assert.deepEqual(await counts(f), { artifacts: 1, completed: 1, events: 1 });
  const row = await f.state.read((sql) =>
    sql.get<{ artifact_id: string }>(
      'SELECT artifact_id FROM artifact_uploads WHERE upload_id=?',
      plan.uploadId,
    ),
  );
  f.state.transaction = transaction;
  await f.restart();
  const artifact = await f.artifacts.uploadComplete(c, plan.uploadId);
  assert.equal(artifact.id, row!.artifact_id);
  assert.deepEqual(await f.artifacts.uploadComplete(c, plan.uploadId), artifact);
  assert.deepEqual(await counts(f), { artifacts: 1, completed: 1, events: 1 });
});

test('storage: inline corruption is detected between HEAD and GET; retry after repair succeeds', async (t) => {
  const f = await fixture(t);
  const c = await f.grant();
  const plan = await storedUpload(f, c);
  f.server.overrideRead({ body: wrongBytes });
  await assert.rejects(f.artifacts.uploadComplete(c, plan.uploadId), { code: 'blob_corrupt' });
  assert.deepEqual(await counts(f), { artifacts: 0, completed: 0, events: 0 });
  f.server.overrideRead();
  const artifact = await f.artifacts.uploadComplete(c, plan.uploadId);
  assert.deepEqual((await f.artifacts.bytes(c, artifact.id)).bytes, bytes);
});

test('storage: object disappearance after HEAD reports failure without a row and recovers after restore', async (t) => {
  const f = await fixture(t);
  const c = await f.grant();
  const plan = await storedUpload(f, c);
  const held = f.server.holdNext('GET');
  const pending = f.artifacts.uploadComplete(c, plan.uploadId);
  const rejected = assert.rejects(pending, { code: 'blob_not_found' });
  await held.started;
  f.server.objects.delete(f.key(1, hash));
  held.release();
  await rejected;
  assert.deepEqual(await counts(f), { artifacts: 0, completed: 0, events: 0 });
  await f.blobs.put(c.projectId, bytes);
  await f.artifacts.uploadComplete(c, plan.uploadId);
  assert.deepEqual(await counts(f), { artifacts: 1, completed: 1, events: 1 });
});

test('storage: completed begin/resume/retry return exact retained identity through an object-store outage', async (t) => {
  const f = await fixture(t);
  const c = await f.grant();
  const plan = await storedUpload(f, c, bytes, 'one');
  const artifact = await f.artifacts.uploadComplete(c, plan.uploadId);
  const before = f.server.requests.length;
  f.server.fail(503);
  assert.deepEqual(await f.artifacts.uploadComplete(c, plan.uploadId), artifact);
  assert.equal((await f.artifacts.uploadBegin(c, uploadInput())).artifactId, artifact.id);
  assert.equal((await f.artifacts.uploadResume(c, plan.uploadId)).artifactId, artifact.id);
  assert.equal(f.server.requests.length, before, 'completed paths perform no external I/O');
});

test('storage mutation control: suppressing locked completed-row observation creates an extra artifact', async (t) => {
  const f = await fixture(t);
  const c = await f.grant();
  const plan = await storedUpload(f, c);
  const firstGate = f.barrier();
  const first = f.artifacts.uploadComplete(c, plan.uploadId);
  await firstGate.entered.promise;
  const second = await f.artifacts.uploadComplete(c, plan.uploadId);
  const transaction = f.state.transaction.bind(f.state);
  f.state.transaction = (async (fn) =>
    transaction(async (tx) => {
      const get = tx.get;
      tx.get = (async (sql: string, ...params: never[]) =>
        sql === 'SELECT artifact_id FROM artifact_uploads WHERE upload_id=? FOR UPDATE'
          ? { artifact_id: null }
          : get(sql, ...params)) as typeof tx.get;
      return await fn(tx);
    })) as typeof f.state.transaction;
  firstGate.release.resolve();
  const duplicate = await first;
  f.state.transaction = transaction;
  assert.notEqual(duplicate.id, second.id);
  assert.deepEqual(
    await counts(f),
    { artifacts: 2, completed: 1, events: 2 },
    'counterexample is detected, not declared conforming',
  );
  assert.equal(
    model([grant(), begin(), put(), start(1), start(2), finish(2), finish(1)], [1]).at(-1)!.count,
    1,
  );
});

test('storage: PostgreSQL forbids immutable row changes and inconsistent inline bytes', async (t) => {
  const f = await fixture(t);
  const c = await f.grant();
  const a = await f.artifacts.create(c, { title: 'Inline', content: bytes.toString() });
  for (const [sql, params] of [
    ['UPDATE artifacts SET title=? WHERE id=?', ['changed', a.id]],
    ['UPDATE artifacts SET project_id=? WHERE id=?', ['elsewhere', a.id]],
    ['UPDATE artifacts SET hash=? WHERE id=?', [wrongHash, a.id]],
    ['UPDATE artifacts SET content=? WHERE id=?', [wrongBytes, a.id]],
    ['DELETE FROM artifacts WHERE id=?', [a.id]],
  ] as const)
    await assert.rejects(
      f.state.transaction((tx) => tx.run(sql, ...params)),
      (e: any) => e.code === 'state_constraint' && e.cause?.sqlstate === '23514',
    );
  await assert.rejects(
    f.state.transaction((tx) =>
      tx.run(
        'INSERT INTO artifacts(id,project_id,created_by,title,media_type,hash,size,created_at,content) VALUES(?,?,?,?,?,?,?,?,?)',
        'invalid_content',
        c.projectId,
        c.actorId,
        'Bad',
        'text/plain',
        hash,
        bytes.length,
        iso(0),
        wrongBytes,
      ),
    ),
    (e: any) =>
      e.code === 'state_constraint' &&
      e.cause?.sqlstate === '23514' &&
      e.cause?.constraint === 'artifacts_content_verified',
  );
  assert.deepEqual(await f.artifacts.get(c, a.id), a);
  assert.deepEqual((await f.artifacts.bytes(c, a.id)).bytes, bytes);
});

test('storage: copied caller survives caller-object mutation while blob I/O is pending', async (t) => {
  const f = await fixture(t);
  const c = await f.grant();
  await f.grant(2, 2);
  const plan = await storedUpload(f, c);
  const held = f.server.holdNext('HEAD');
  const pending = f.artifacts.uploadComplete(c, plan.uploadId);
  await held.started;
  const original = { ...c };
  Object.assign(c, f.actualCaller(caller(2, 2)));
  held.release();
  const a = await pending;
  assert.equal(a.projectId, original.projectId);
  assert.equal(a.createdBy, original.actorId);
  await assert.rejects(f.artifacts.get(c, a.id), { code: 'not_found' });
});

test('storage: direct download uses admission snapshot; issued capability survives actor revocation', async (t) => {
  const f = await fixture(t);
  const c = await f.grant();
  const plan = await storedUpload(f, c);
  const a = await f.artifacts.uploadComplete(c, plan.uploadId);
  const held = f.server.holdNext('HEAD');
  const pending = f.artifacts.download(c, a.id);
  await held.started;
  await f.scope.revokeActor(f.projects.get(1)!.admin, c.actorId);
  held.release();
  const download = (await pending).download;
  assert.deepEqual(Buffer.from(await (await fetch(download.url)).arrayBuffer()), bytes);
  await assert.rejects(f.artifacts.download(c, a.id), { code: 'forbidden' });
  const changed = new URL(download.url);
  changed.pathname = changed.pathname.replace(c.projectId, 'other_project');
  assert.equal((await fetch(changed)).status, 403, 'signature binds the namespace');
});

test('storage: immutable read snapshot can finish after revocation; a new read cannot', async (t) => {
  const f = await fixture(t);
  const c = await f.grant();
  const a = await f.artifacts.create(c, { title: 'Snapshot', content: bytes.toString() });
  const entered = deferred(),
    release = deferred();
  const pending = f.state.snapshot(async () => {
    const before = await f.artifacts.bytes(c, a.id);
    entered.resolve();
    await release.promise;
    const after = await f.artifacts.bytes(c, a.id);
    assert.deepEqual(after, before);
    return after;
  });
  await entered.promise;
  await f.scope.revokeActor(f.projects.get(1)!.admin, c.actorId);
  release.resolve();
  assert.deepEqual((await pending).bytes, bytes);
  await assert.rejects(f.artifacts.bytes(c, a.id), { code: 'forbidden' });
});

test('storage: a signed PUT remains usable after revocation but cannot finalize an artifact', async (t) => {
  const f = await fixture(t);
  const c = await f.grant();
  const plan = await f.artifacts.uploadBegin(c, uploadInput());
  await f.scope.revokeActor(f.projects.get(1)!.admin, c.actorId);
  const response = await fetch(plan.parts[0]!.url, {
    method: 'PUT',
    headers: plan.parts[0]!.headers,
    body: new Uint8Array(bytes),
  });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  await assert.rejects(f.artifacts.uploadComplete(c, plan.uploadId), { code: 'forbidden' });
  assert.deepEqual(await counts(f), { artifacts: 0, completed: 0, events: 0 });
});

test('storage external-contract counterexample: large HEAD trusts size and cannot detect out-of-band same-size corruption', async (t) => {
  const f = await fixture(t);
  const c = await f.grant();
  const plan = await storedUpload(f, c, largeBytes);
  f.server.objects.set(f.key(1, largeHash), Buffer.alloc(largeBytes.length, 98));
  const before = f.server.requests.length;
  const a = await f.artifacts.uploadComplete(c, plan.uploadId);
  assert.equal(a.hash, largeHash);
  assert.deepEqual(
    f.server.requests.slice(before).map((r) => r.method),
    ['HEAD'],
  );
  assert.notEqual(sha256Hex(f.server.objects.get(f.key(1, largeHash))!), a.hash);
  await assert.rejects(f.artifacts.bytes(c, a.id), { code: 'artifact_size' });
});

test('storage: S3 shutdown drains an admitted HEAD and rejects new operations', async (t) => {
  const f = await fixture(t);
  const c = await f.grant();
  await f.blobs.put(c.projectId, bytes);
  const held = f.server.holdNext('HEAD');
  const pending = f.blobs.stored(c.projectId, hash);
  await held.started;
  const closed = f.blobs.close();
  await assert.rejects(f.blobs.stored(c.projectId, hash), { code: 'blobs_closed' });
  held.release();
  assert.equal(await pending, bytes.length);
  await closed;
  await assert.rejects(f.blobs.get(c.projectId, hash), { code: 'blobs_closed' });
});

test('storage: production DiskBlobs copies input, deduplicates racing puts, drains close and removes temporary files', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'merv-storage-disk-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const disk = new DiskBlobs(dir);
  const input = Buffer.from(bytes);
  const first = disk.put('project_1', input);
  input.fill(0);
  const pending = [first, ...Array.from({ length: 12 }, () => disk.put('project_1', bytes))];
  const closing = disk.close();
  await assert.rejects(disk.put('project_1', bytes), { code: 'blobs_closed' });
  for (const r of await Promise.all(pending)) assert.deepEqual(r, { hash, size: bytes.length });
  await closing;
  const path = join(dir, 'project_1', hash.slice(0, 2), hash);
  assert.deepEqual(await readFile(path), bytes);
  assert.deepEqual(await readdir(join(dir, 'project_1', hash.slice(0, 2))), [hash]);
  const reopened = new DiskBlobs(dir);
  t.after(() => reopened.close());
  assert.deepEqual(await reopened.get('project_1', hash), bytes);
  await assert.rejects(reopened.get('project_2', hash), { code: 'blob_not_found' });
  await writeFile(path, wrongBytes);
  await assert.rejects(reopened.get('project_1', hash), { code: 'blob_corrupt' });
  await assert.rejects(reopened.put('project_1', bytes), { code: 'blob_corrupt' });
  assert.deepEqual(
    await readFile(path),
    wrongBytes,
    'duplicate write does not silently replace corruption',
  );
  assert.deepEqual(
    await readdir(join(dir, 'project_1', hash.slice(0, 2))),
    [hash],
    'failed duplicate also cleans temporary file',
  );
});

test('storage: provider expires upload/download capabilities; resume signs a usable replacement', async (t) => {
  const f = await fixture(t);
  const c = await f.grant();
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const plan = await f.artifacts.uploadBegin(c, uploadInput());
  const send = (p: typeof plan) =>
    fetch(p.parts[0]!.url, {
      method: 'PUT',
      headers: p.parts[0]!.headers,
      body: new Uint8Array(bytes),
    });
  t.mock.timers.setTime(Date.now() + 3_600_001);
  assert.equal((await send(plan)).status, 403);
  const resumed = await f.artifacts.uploadResume(c, plan.uploadId);
  assert.notEqual(resumed.parts[0]!.url, plan.parts[0]!.url);
  assert.equal((await send(resumed)).status, 200);
  const artifact = await f.artifacts.uploadComplete(c, plan.uploadId);
  const first = (await f.artifacts.download(c, artifact.id)).download;
  assert.deepEqual(Buffer.from(await (await fetch(first.url)).arrayBuffer()), bytes);
  t.mock.timers.setTime(Date.parse(first.expiresAt) + 1);
  assert.equal((await fetch(first.url)).status, 403);
  const next = (await f.artifacts.download(c, artifact.id)).download;
  assert.deepEqual(Buffer.from(await (await fetch(next.url)).arrayBuffer()), bytes);
});

test('storage: delegated session loses finalization authority when its source is revoked during GET', async (t) => {
  const f = await fixture(t);
  const c = await f.grant();
  const source = await f.scope.delegationSource({
    ...c,
    credentialId: f.actors.get(1)!.credentialId,
  });
  const worker = await f.state.transaction((tx) =>
    f.scope.createSessionActor(
      source,
      { sessionId: 'storage_session', name: 'Uploader', role: 'producer' },
      tx,
    ),
  );
  t.after(
    f.scope.registerSessionAuthority({
      require: async (_caller, tx, permission) => {
        await f.scope.requireDelegation(source, permission, tx);
        return source;
      },
    }),
  );
  const session: Caller = {
    actorId: worker.id,
    projectId: c.projectId,
    session: { id: 'storage_session' },
  };
  const plan = await storedUpload(f, session);
  const held = f.server.holdNext('GET');
  const pending = f.artifacts.uploadComplete(session, plan.uploadId);
  const denied = assert.rejects(pending, (e: any) =>
    ['forbidden', 'invalid_delegation'].includes(e.code),
  );
  await held.started;
  await f.scope.revokeActor(f.projects.get(1)!.admin, c.actorId);
  held.release();
  await denied;
  assert.deepEqual(await counts(f), { artifacts: 0, completed: 0, events: 0 });
});

test('storage: same request ID is independently scoped to actor and project', async (t) => {
  const f = await fixture(t);
  const first = await f.grant();
  const second = await f.grant(2);
  const third = await f.grant(3, 2);
  const plans = await Promise.all(
    [first, second, third].map((c) => f.artifacts.uploadBegin(c, uploadInput())),
  );
  assert.equal(new Set(plans.map((p) => p.uploadId)).size, 3);
  const firstAgain = await f.artifacts.uploadBegin(first, uploadInput());
  assert.equal(firstAgain.uploadId, plans[0]!.uploadId);
  await assert.rejects(f.artifacts.uploadResume(second, plans[0]!.uploadId), { code: 'not_found' });
  await assert.rejects(f.artifacts.uploadResume(third, plans[0]!.uploadId), { code: 'not_found' });
  const before = f.server.requests.length;
  await assert.rejects(f.artifacts.uploadBegin(first, uploadInput(ticket({ hash: wrongHash }))), {
    code: 'upload_conflict',
  });
  await assert.rejects(
    f.artifacts.uploadBegin(first, uploadInput(ticket({ size: bytes.length + 1 }))),
    { code: 'upload_conflict' },
  );
  await assert.rejects(
    f.artifacts.uploadBegin(first, uploadInput(ticket({ media: 'application/octet-stream' }))),
    { code: 'upload_conflict' },
  );
  assert.equal(f.server.requests.length, before, 'conflicting retries fail before external I/O');
});
