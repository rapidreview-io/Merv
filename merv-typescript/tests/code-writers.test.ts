import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  faultAt,
  recoverLegacyOperation,
  seedLegacyOperation,
  type Bundle,
} from './fixtures/code-store.js';
import { refused, writerFixture } from './fixtures/code-writers.js';

const fixture = writerFixture;
/** Holds the project's turn, which every admission waits for, until the returned release. */
const hold = (f: Awaited<ReturnType<typeof fixture>>) => {
  let release!: () => void;
  const held = f.core.repositories.run(
    f.admin.projectId,
    () => new Promise<void>((done) => (release = done)),
  );
  return async () => (release(), await held);
};

/** An operation already received by the previous runtime; only recovery is under test. */
const seed = (
  f: Awaited<ReturnType<typeof fixture>>,
  kind: 'checkpoint' | 'final',
  expectedHead: string,
  bundle: Bundle,
  received?: number,
) =>
  seedLegacyOperation(f.code, f.admin, bundle, {
    received,
    upload: {
      format: 1,
      source: 'upload',
      actorId: f.admin.actorId,
      kind,
      runnerId: 'runner-1',
      hostRef: 'launch-ses_1',
      sessionId: 'ses_1',
      leaseId: 'ses_1',
      unitId: f.unitId,
      generation: 1,
      commandId: kind === 'checkpoint' ? 'historical-command' : null,
      expectedHead,
      tip: bundle.tip,
      treeOid: f.source.git('rev-parse', `${bundle.tip}^{tree}`),
      bundle: { sha256: bundle.sha256, bytes: bundle.bytes },
    },
  });
const recover = (f: Awaited<ReturnType<typeof fixture>>, id: string) =>
  recoverLegacyOperation(f.code, id);
const restored = async (
  f: Awaited<ReturnType<typeof fixture>>,
  kind: 'checkpoint' | 'final',
  expectedHead: string,
  bundle: Bundle,
) => recover(f, await seed(f, kind, expectedHead, bundle));

for (const point of [
  'after_index',
  'after_admitting',
  'after_migrate',
  'after_objects_durable',
  'after_ref',
  'after_refs_applied',
  'before_ack',
] as const)
  test(`an upload whose process ends ${point} is finished by the next one, exactly once`, async (t) => {
    const f = await fixture(t);
    await f.lease('ses_1');
    const first = f.source.commit({ 'a.txt': 'one\n' }, 'first');
    const bundle = f.source.bundle(first, [f.root]);
    await f.open({ fault: faultAt(point) });
    await f.event('session.workspace_attached', 'ses_1');
    const id = await seed(f, 'checkpoint', f.root, bundle);
    await recover(f, id).catch(() => {});
    await f.open();
    const operation = await recover(f, id);
    assert.equal(operation.id, id);
    assert.equal(operation.status, 'completed');
    assert.equal((await f.unit()).canonicalHead, first);
    assert.deepEqual(
      f.refs().filter((ref) => !ref.startsWith('refs/merv/imports/')),
      [`refs/merv/receipts/${id} ${first}`, `refs/merv/work/${f.unitId} ${first}`],
    );
    assert.ok(!existsSync(join(f.paths.quarantine, id)));
  });

test('a lease reserves the next generation only once the last one closed', async (t) => {
  const f = await fixture(t, 0);
  assert.deepEqual(await f.lease('ses_1'), { generation: 1, state: 'reserved', blocked: null });
  assert.equal((await f.lease('ses_1')).generation, 1, 'the same lease reads what it reserved');
  await assert.rejects(f.lease('ses_2'), refused('code_writer_busy'));
  // A session that ended before it attached edited nothing, so its generation just closes.
  await f.event('session.closed', 'ses_1');
  assert.equal((await f.unit()).writerState, 'closed');
  // A refused offer takes its reservation back with it.
  await assert.rejects(
    f.state.transaction(async (tx) => {
      await f.core.writers.reserveWriter(f.admin, { unitId: f.unitId, leaseId: 'ses_lost' }, tx);
      throw new Error('offer refused');
    }),
    /offer refused/,
  );
  assert.equal((await f.unit()).generation, 1);
  assert.equal((await f.lease('ses_2')).generation, 2);
  await f.event('session.workspace_attached', 'ses_2');
  assert.equal((await f.unit()).writerState, 'active');
  await assert.rejects(f.lease('ses_3'), refused('code_writer_busy'));
  // Its session closed with nothing in flight: the generation ends with it, at once, and asks
  // nobody for anything.
  await f.event('session.closed', 'ses_2');
  await f.end('ses_2');
  assert.equal((await f.unit()).writerState, 'closed');
  assert.deepEqual((await f.code.status(f.admin)).blockers, []);
  assert.equal((await f.lease('ses_3')).generation, 3);
});

test('a quarantined final capture blocks the unit until a signed-in administrator fences it', async (t) => {
  const f = await fixture(t);
  await f.lease('ses_1');
  await f.event('session.workspace_attached', 'ses_1');
  const first = f.source.commit({ 'a.txt': 'one\n' }, 'first');
  await restored(f, 'checkpoint', f.root, f.source.bundle(first, [f.root]));
  const secret = f.source.commit(
    { 'key.pem': '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n' },
    'merv: capture',
  );
  const final = await restored(f, 'final', first, f.source.bundle(secret, [first]));
  // Its session closes, and the sweep runs: a quarantined capture still waits for a person.
  await f.event('session.closed', 'ses_1');
  await f.end('ses_1');
  await f.sweep();
  assert.equal(final.status, 'failed');
  assert.equal(final.error, 'code_capture_quarantined');
  assert.ok(final.findings.length > 0);
  assert.ok(!JSON.stringify(final.findings).includes('BEGIN RSA'));
  let unit = await f.unit();
  assert.equal(unit.canonicalHead, first, 'nothing of a quarantined capture is admitted');
  assert.equal(unit.writerState, 'recovery_required');
  assert.deepEqual(unit.quarantine, { operationId: final.id });
  assert.deepEqual(readdirSync(f.paths.held), [`${final.id}.bundle`]);
  assert.deepEqual(
    (await f.code.status(f.admin)).blockers.map((blocker) => [blocker.key, blocker.code]),
    [['capture', 'code_capture_quarantined']],
  );
  await assert.rejects(f.lease('ses_2'), refused('code_capture_quarantined'));

  // Only an administrator starts the maintenance pass a fence begins with.
  const store = (f.code as unknown as { store: { maintain(): Promise<void> } }).store;
  const maintained = t.mock.method(store, 'maintain');
  const { actor } = await f.scope.credentials.issueActor(f.admin, { name: 'P', role: 'producer' });
  const producer = { projectId: f.admin.projectId, actorId: actor.id };
  await assert.rejects(f.code.fenceUnit(producer, { unitId: f.unitId, requestId: 'fence' }));
  assert.equal(maintained.mock.callCount(), 0);
  maintained.mock.restore();
  await assert.rejects(
    f.code.fenceUnit(f.admin, { unitId: f.unitId, requestId: 'fence' }),
    refused('code_human_required'),
  );
  const human = await f.human();
  const fenced = await f.code.fenceUnit(human, { unitId: f.unitId, requestId: 'fence' });
  assert.deepEqual(fenced, { generation: 1, state: 'closed', blocked: null });
  assert.deepEqual(await f.code.fenceUnit(human, { unitId: f.unitId, requestId: 'fence' }), fenced);
  unit = await f.unit();
  assert.equal(unit.quarantine, null);
  assert.deepEqual((await f.code.status(f.admin)).blockers, []);
  assert.equal((await f.lease('ses_2')).generation, 2);
  assert.equal((await f.unit()).canonicalHead, first);
});

test('a session closing ends its generation at the last admitted commit, and what it was sending is held', async (t) => {
  // Whatever closed it: a handoff, a lapsed lease, a lost host, an expiry, a relay outage, a
  // release of Main. Code hears only session.closed, which every one of them appends.
  const f = await fixture(t, 0);
  await f.lease('ses_1');
  await f.event('session.workspace_attached', 'ses_1');
  const first = f.source.commit({ 'a.txt': 'one\n' }, 'first');
  await restored(f, 'checkpoint', f.root, f.source.bundle(first, [f.root]));
  const second = f.source.commit({ 'a.txt': 'two\n' }, 'second');
  const bundle = f.source.bundle(second, [first]);
  const sending = await seed(f, 'checkpoint', first, bundle, 64);
  await f.event('session.closed', 'ses_1');
  await f.end('ses_1');
  const unit = await f.unit();
  assert.deepEqual([unit.writerState, unit.canonicalHead], ['closed', first]);
  assert.deepEqual((await f.code.status(f.admin)).blockers, []);
  assert.deepEqual(await f.operationRow(sending), {
    status: 'failed',
    phase: 'receiving',
    error: 'code_generation_stale',
  });
  assert.equal((await recover(f, sending)).status, 'failed');
  await f.store.maintain();
  assert.ok(existsSync(join(f.paths.held, `${sending}.bundle`)));
  assert.equal((await f.lease('ses_2')).generation, 2);
  const ended = await f.state.read((sql) =>
    sql.all<{ data: string }>(
      "SELECT data_json AS data FROM events WHERE type='code.writer_ended' ORDER BY id",
    ),
  );
  assert.deepEqual(
    ended.map((row) => JSON.parse(row.data)),
    [{ reason: 'session_closed', sessionId: 'ses_1', generation: 1, head: first, from: 'active' }],
  );
});

test('a legacy upload fully on Main when its machine is gone is admitted by Main itself', async (t) => {
  const f = await fixture(t);
  await f.lease('ses_1');
  await f.event('session.workspace_attached', 'ses_1');
  // Every byte arrived, then the host was lost before the machine asked for admission.
  const first = f.source.commit({ 'a.txt': 'one\n' }, 'first');
  const bundle = f.source.bundle(first, [f.root]);
  const inFlight = await seed(f, 'checkpoint', f.root, bundle);
  await f.end('ses_1', 'managed_revoked');
  await f.event('session.closed', 'ses_1');
  // The close itself wakes Main's pass: nobody asks for the admission and no sweep is due.
  for (let tries = 0; tries < 100 && (await f.unit()).writerState !== 'closed'; tries++)
    await delay(50);
  const unit = await f.unit();
  assert.deepEqual([unit.writerState, unit.canonicalHead], ['closed', first]);
  assert.equal((await f.lease('ses_2')).generation, 2);
});

test('past the grace, a legacy upload its session left is never admitted', async (t) => {
  const f = await fixture(t, 0);
  await f.lease('ses_1');
  await f.event('session.workspace_attached', 'ses_1');
  const first = f.source.commit({ 'a.txt': 'one\n' }, 'first');
  const bundle = f.source.bundle(first, [f.root]);
  const inFlight = await seed(f, 'checkpoint', f.root, bundle);
  const held = hold(f);
  await f.event('session.closed', 'ses_1');
  await f.end('ses_1');
  assert.equal((await f.unit()).writerState, 'closing');
  // A grace of 0: the sweep ends the generation, and the late completion is refused.
  await f.sweep();
  await held();
  const unit = await f.unit();
  assert.deepEqual([unit.writerState, unit.canonicalHead], ['closed', null]);
  assert.equal((await f.operationRow(inFlight))?.error, 'code_generation_stale');
  const late = await recover(f, inFlight);
  assert.deepEqual([late.status, late.error], ['failed', 'code_generation_stale']);
  assert.ok(!f.refs().some((ref) => ref.startsWith('refs/merv/work/')));
});
