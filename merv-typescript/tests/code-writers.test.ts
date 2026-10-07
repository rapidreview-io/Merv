import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { refused, writerFixture } from './fixtures/code-writers.js';
import { CodeWriterService } from '@merv/code/writers';
import { faultAt, git } from './fixtures/code-store.js';

const fixture = writerFixture;

test('an ordinary unit accepts a real checkpoint after its first checkpoint was a no-op', async (t) => {
  const f = await fixture(t);
  await f.lease('ses_1');
  await f.event('session.workspace_attached', 'ses_1');
  const empty = await f.begin('checkpoint', 'ses_1', 1, f.root, null);
  assert.equal(empty.status, 'completed');
  assert.equal((await f.unit()).canonicalHead, f.root);
  assert.ok(!f.refs().some((ref) => ref.startsWith(`refs/merv/work/${f.unitId} `)));
  const head = f.source.commit({ 'ordinary.txt': 'first actual change\n' });
  const uploaded = await f.upload(
    'checkpoint',
    'ses_1',
    1,
    f.root,
    f.source.bundle(head, [f.root]),
  );
  assert.equal(uploaded.status, 'completed');
  assert.equal((await f.unit()).canonicalHead, head);
  assert.ok(f.refs().includes(`refs/merv/work/${f.unitId} ${head}`));
  assert.equal(
    await f.state.read((sql) =>
      sql.get('SELECT unit_id FROM code_pending_merges WHERE unit_id=?', f.unitId),
    ),
    undefined,
  );
});

for (const point of [
  'after_part',
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
    const begun = await f.begin('checkpoint', 'ses_1', 1, f.root, bundle);
    await f.send(begun, bundle).catch(() => {});
    await f.open();
    let operation = await f.begin('checkpoint', 'ses_1', 1, f.root, bundle, 'command-1');
    if (operation.status === 'prepared') operation = await f.send(operation, bundle);
    assert.equal(operation.id, begun.id);
    assert.equal(operation.status, 'completed');
    assert.equal((await f.unit()).canonicalHead, first);
    assert.deepEqual(
      f.refs().filter((ref) => !ref.startsWith('refs/merv/imports/')),
      [`refs/merv/receipts/${begun.id} ${first}`, `refs/merv/work/${f.unitId} ${first}`],
    );
    assert.ok(!existsSync(join(f.paths.quarantine, begun.id)));
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
  f.end('ses_2');
  assert.equal((await f.unit()).writerState, 'closed');
  assert.deepEqual((await f.code.status(f.admin)).blockers, []);
  assert.equal((await f.lease('ses_3')).generation, 3);
});

test("uploads advance a unit's branch only under the whole fence, and the final capture ends the generation exactly once", async (t) => {
  const f = await fixture(t);
  await f.lease('ses_1');
  await f.event('session.workspace_attached', 'ses_1');
  const first = f.source.commit({ 'a.txt': 'one\n' }, 'first');
  const done = await f.upload('checkpoint', 'ses_1', 1, f.root, f.source.bundle(first, [f.root]));
  assert.equal(done.status, 'completed');
  assert.equal(done.unitId, f.unitId);
  assert.equal((await f.unit()).canonicalHead, first);
  const refs = f.refs();
  assert.ok(refs.includes(`refs/merv/work/${f.unitId} ${first}`));
  assert.ok(refs.includes(`refs/merv/receipts/${done.id} ${first}`));

  // A commit the server has moved past, a wrong generation and another session are refused.
  const second = f.source.commit({ 'a.txt': 'two\n' }, 'second');
  const next = f.source.bundle(second, [first]);
  await assert.rejects(
    f.begin('checkpoint', 'ses_1', 1, f.root, next),
    refused('code_head_conflict'),
  );
  await assert.rejects(
    f.begin('checkpoint', 'ses_1', 2, first, next),
    refused('code_generation_stale'),
  );

  // Trailing work after the last commit arrives with the final capture, before the session
  // closes: it ends the generation.
  const final = await f.upload('final', 'ses_1', 1, first, next);
  await f.event('session.closed', 'ses_1');
  // Reordered: a checkpoint that arrives after the final finds the generation closed.
  await assert.rejects(
    f.begin('checkpoint', 'ses_1', 1, second, null),
    refused('code_writer_closed'),
  );
  f.end('ses_1');
  await assert.rejects(f.begin('checkpoint', 'ses_1', 1, first, next), refused('session_closed'));
  assert.equal(final.status, 'completed');
  const unit = await f.unit();
  assert.equal(unit.canonicalHead, second);
  assert.equal(unit.writerState, 'closed');

  // Duplicate: the same final answers with the same operation. Another final is a conflict.
  const again = await f.begin('final', 'ses_1', 1, first, next);
  assert.equal(again.id, final.id);
  await assert.rejects(f.begin('final', 'ses_1', 1, second, null), refused('request_conflict'));
  const events = await f.state.read(
    async (sql) =>
      await sql.all<{ type: string }>(
        "SELECT type FROM events WHERE type='code.capture_admitted' ORDER BY id",
      ),
  );
  assert.equal(events.length, 2);

  // The successor starts from the canonical head, which includes the trailing work.
  assert.equal((await f.lease('ses_2')).generation, 2);
  const third = f.source.commit({ 'b.txt': 'three\n' }, 'third');
  const resumed = await f.upload(
    'checkpoint',
    'ses_2',
    2,
    second,
    f.source.bundle(third, [second]),
  );
  assert.equal(resumed.status, 'completed');
  await assert.rejects(f.begin('final', 'ses_1', 1, second, null), refused('request_conflict'));
});

test('a later upload ends one that was only receiving, and a commit succeeds only once admitted', async (t) => {
  const f = await fixture(t);
  await f.lease('ses_1');
  const first = f.source.commit({ 'a.txt': 'one\n' }, 'first');
  const bundle = f.source.bundle(first, [f.root]);
  const abandoned = await f.begin('checkpoint', 'ses_1', 1, f.root, bundle, 'command-a');
  await f.code.v2!.putPart(f.admin, abandoned.id, 0, bundle.content.subarray(0, 10));
  const retried = await f.begin('checkpoint', 'ses_1', 1, f.root, bundle, 'command-b');
  assert.deepEqual(await f.operationRow(abandoned.id), {
    status: 'failed',
    phase: 'receiving',
    error: 'code_upload_superseded',
  });
  assert.ok(!existsSync(join(f.paths.quarantine, abandoned.id)), 'superseded bytes are swept');

  const writers = new CodeWriterService(f.state, f.scope, 900);
  const receipt = { headOid: first } as never;
  const completion = (commandId: string) => ({ sessionId: 'ses_1', commandId, receipt }) as never;
  const command = { projectId: f.admin.projectId, instanceId: f.unitId };
  await assert.rejects(
    f.state.transaction(
      async (tx) => await writers.requireAdmitted(completion('command-b'), command, tx),
    ),
    refused('code_upload_required'),
  );
  // A unit that never had a writer admits no commit either: no receipt succeeds without an upload.
  await assert.rejects(
    f.state.transaction(
      async (tx) =>
        await writers.requireAdmitted(
          completion('command-b'),
          { ...command, instanceId: 'wf_never_leased' },
          tx,
        ),
    ),
    refused('code_upload_required'),
  );
  assert.equal((await f.send(retried, bundle)).status, 'completed');
  await f.state.transaction(
    async (tx) => await writers.requireAdmitted(completion('command-b'), command, tx),
  );
  await assert.rejects(
    f.state.transaction(
      async (tx) => await writers.requireAdmitted(completion('command-a'), command, tx),
    ),
    refused('code_upload_required'),
  );

  // The final of a session whose checkpoint was still receiving carries that commit too.
  const second = f.source.commit({ 'a.txt': 'two\n' }, 'second');
  const third = f.source.commit({ 'a.txt': 'three\n' }, 'wip');
  const pending = await f.begin(
    'checkpoint',
    'ses_1',
    1,
    first,
    f.source.bundle(second, [first]),
    'command-c',
  );
  await f.event('session.workspace_attached', 'ses_1');
  const final = await f.upload('final', 'ses_1', 1, first, f.source.bundle(third, [first]));
  await f.event('session.closed', 'ses_1');
  f.end('ses_1');
  assert.equal(final.status, 'completed');
  assert.equal((await f.operationRow(pending.id))?.error, 'code_upload_superseded');
  assert.equal(git(f.paths.repository, ['rev-parse', `${third}~1`]), second);
});

test('a quarantined final capture blocks the unit until a signed-in administrator fences it', async (t) => {
  const f = await fixture(t);
  await f.lease('ses_1');
  await f.event('session.workspace_attached', 'ses_1');
  const first = f.source.commit({ 'a.txt': 'one\n' }, 'first');
  await f.upload('checkpoint', 'ses_1', 1, f.root, f.source.bundle(first, [f.root]));
  const secret = f.source.commit(
    { 'key.pem': '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n' },
    'merv: capture',
  );
  const final = await f.upload('final', 'ses_1', 1, first, f.source.bundle(secret, [first]));
  // Its session closes, and the sweep runs: a quarantined capture still waits for a person.
  await f.event('session.closed', 'ses_1');
  f.end('ses_1');
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
  await f.upload('checkpoint', 'ses_1', 1, f.root, f.source.bundle(first, [f.root]));
  const second = f.source.commit({ 'a.txt': 'two\n' }, 'second');
  const bundle = f.source.bundle(second, [first]);
  const sending = await f.begin('checkpoint', 'ses_1', 1, first, bundle);
  await f.code.v2!.putPart(f.admin, sending.id, 0, bundle.content.subarray(0, 64));
  await f.event('session.closed', 'ses_1');
  f.end('ses_1');
  const unit = await f.unit();
  assert.deepEqual([unit.writerState, unit.canonicalHead], ['closed', first]);
  assert.deepEqual((await f.code.status(f.admin)).blockers, []);
  assert.deepEqual(await f.operationRow(sending.id), {
    status: 'failed',
    phase: 'receiving',
    error: 'code_generation_stale',
  });
  // Nothing more of that session is admitted: its credentials are dead, and so is its fence.
  assert.equal((await f.send(sending, bundle)).status, 'failed');
  await assert.rejects(f.begin('final', 'ses_1', 1, first, bundle), refused('code_writer_closed'));
  // The next lease continues from the last admitted commit.
  assert.equal((await f.lease('ses_2')).generation, 2);
  await assert.rejects(
    f.begin('final', 'ses_1', 1, first, bundle, 'late'),
    refused('code_generation_stale'),
  );
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

test('an upload fully on Main when its session closed is admitted within the grace', async (t) => {
  const f = await fixture(t);
  await f.lease('ses_1');
  await f.event('session.workspace_attached', 'ses_1');
  const first = f.source.commit({ 'a.txt': 'one\n' }, 'first');
  await f.upload('checkpoint', 'ses_1', 1, f.root, f.source.bundle(first, [f.root]));
  // The machine sent every byte of a commit, and then its session closed.
  const last = f.source.commit({ 'a.txt': 'two\n' }, 'second');
  const bundle = f.source.bundle(last, [first]);
  const inFlight = await f.begin('checkpoint', 'ses_1', 1, first, bundle);
  await f.code.v2!.putPart(f.admin, inFlight.id, 0, bundle.content);
  await f.event('session.closed', 'ses_1');
  f.end('ses_1');
  assert.equal((await f.unit()).writerState, 'closing', 'whole bytes on Main are not abandoned');
  await assert.rejects(f.lease('ses_2'), refused('code_writer_busy'));
  await f.sweep();
  assert.equal((await f.unit()).writerState, 'closing', 'the grace has not passed');
  // Nothing new begins in the grace; what was in flight finishes.
  await assert.rejects(f.begin('final', 'ses_1', 1, first, bundle), refused('code_writer_closed'));
  const admitted = (
    (await f.code.v2!.call(f.admin, `uploads/${inFlight.id}/complete`, {})) as {
      operation: { status: string };
    }
  ).operation;
  assert.equal(admitted.status, 'completed');
  const unit = await f.unit();
  assert.deepEqual([unit.writerState, unit.canonicalHead], ['closed', last]);
  assert.equal((await f.lease('ses_2')).generation, 2);
});

test('past the grace, an upload its session left is never admitted', async (t) => {
  const f = await fixture(t, 0);
  await f.lease('ses_1');
  await f.event('session.workspace_attached', 'ses_1');
  const first = f.source.commit({ 'a.txt': 'one\n' }, 'first');
  const bundle = f.source.bundle(first, [f.root]);
  const inFlight = await f.begin('checkpoint', 'ses_1', 1, f.root, bundle);
  await f.code.v2!.putPart(f.admin, inFlight.id, 0, bundle.content);
  await f.event('session.closed', 'ses_1');
  f.end('ses_1');
  assert.equal((await f.unit()).writerState, 'closing');
  // A grace of 0: the sweep ends the generation, and the late completion is refused.
  await f.sweep();
  const unit = await f.unit();
  assert.deepEqual([unit.writerState, unit.canonicalHead], ['closed', null]);
  assert.equal((await f.operationRow(inFlight.id))?.error, 'code_generation_stale');
  const late = (
    (await f.code.v2!.call(f.admin, `uploads/${inFlight.id}/complete`, {})) as {
      operation: { status: string; error: string };
    }
  ).operation;
  assert.deepEqual([late.status, late.error], ['failed', 'code_generation_stale']);
  assert.ok(!f.refs().some((ref) => ref.startsWith('refs/merv/work/')));
});

test('a writer an earlier Code left in recovery_required ends at its last admitted commit on the sweep', async (t) => {
  // In prod: a unit whose session closed managed_revoked before writers ended with their
  // sessions, held in recovery_required for a final capture that never came.
  const f = await fixture(t);
  await f.lease('ses_1');
  await f.event('session.workspace_attached', 'ses_1');
  const first = f.source.commit({ 'a.txt': 'one\n' }, 'first');
  await f.upload('checkpoint', 'ses_1', 1, f.root, f.source.bundle(first, [f.root]));
  await f.state.transaction((tx) =>
    tx.run(
      "UPDATE code_workspaces SET writer_state='recovery_required',writer_changed_at='2026-09-30T00:00:00.000Z' WHERE unit_id=?",
      f.unitId,
    ),
  );
  await f.sweep();
  const unit = await f.unit();
  assert.deepEqual([unit.writerState, unit.canonicalHead], ['closed', first]);
  assert.deepEqual((await f.code.status(f.admin)).blockers, []);
  assert.equal((await f.lease('ses_2')).generation, 2);
  // Only a quarantined capture asks a person: any other fence is refused as unneeded.
  await assert.rejects(
    f.code.fenceUnit(await f.human(), { unitId: f.unitId, requestId: 'fence' }),
    refused('code_fence_unneeded'),
  );
});
