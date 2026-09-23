import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { refused, writerFixture } from './fixtures/code-writers.js';
import { ResearchCodeWriters as CodeWriterService } from '@merv/code-research/writers';
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
      await f.code.reserveWriter(f.admin, { unitId: f.unitId, leaseId: 'ses_lost' }, tx);
      throw new Error('offer refused');
    }),
    /offer refused/,
  );
  assert.equal((await f.unit()).generation, 1);
  assert.equal((await f.lease('ses_2')).generation, 2);
  await f.event('session.workspace_attached', 'ses_2');
  assert.equal((await f.unit()).writerState, 'active');
  await f.event('session.closed', 'ses_2');
  f.end('ses_2');
  assert.equal((await f.unit()).writerState, 'closing');
  const waiting = await f.state.transaction(
    async (tx) => await f.code.writerStatus(f.admin, f.unitId, tx),
  );
  assert.equal(waiting.blocked?.code, 'code_writer_busy', 'a closing unit is no candidate');
  await assert.rejects(f.lease('ses_3'), refused('code_writer_busy'));

  // The grace passes: the unit says it needs an operator, and work on it is refused.
  await f.code.maintainStore();
  assert.equal((await f.unit()).writerState, 'recovery_required');
  const status = await f.code.status(f.admin);
  assert.deepEqual(
    status.blockers.map((blocker) => [blocker.key, blocker.code]),
    [['writer', 'code_recovery_required']],
  );
  await assert.rejects(f.lease('ses_3'), refused('code_recovery_required'));

  // The machine comes back after all: the one final capture of that generation heals it.
  const final = await f.begin('final', 'ses_2', 2, f.root, null);
  assert.equal(final.status, 'completed');
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

  // Trailing work after the last commit arrives with the final capture, after the session.
  await f.event('session.closed', 'ses_1');
  const final = await f.upload('final', 'ses_1', 1, first, next);
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
  await f.event('session.closed', 'ses_1');
  f.end('ses_1');
  const final = await f.upload('final', 'ses_1', 1, first, f.source.bundle(third, [first]));
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
  await f.event('session.closed', 'ses_1');
  f.end('ses_1');
  const secret = f.source.commit(
    { 'key.pem': '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n' },
    'merv: capture',
  );
  const final = await f.upload('final', 'ses_1', 1, first, f.source.bundle(secret, [first]));
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

test('after a fence the old generation is stale and what it was sending is held, never admitted', async (t) => {
  const f = await fixture(t);
  await f.lease('ses_1');
  await f.event('session.workspace_attached', 'ses_1');
  const first = f.source.commit({ 'a.txt': 'one\n' }, 'first');
  const bundle = f.source.bundle(first, [f.root]);
  const sending = await f.begin('checkpoint', 'ses_1', 1, f.root, bundle);
  await f.code.v2!.putPart(f.admin, sending.id, 0, bundle.content.subarray(0, 64));
  const human = await f.human();
  await f.code.fenceUnit(human, { unitId: f.unitId, requestId: 'fence' });
  assert.deepEqual(await f.operationRow(sending.id), {
    status: 'failed',
    phase: 'receiving',
    error: 'code_generation_stale',
  });
  assert.deepEqual(readdirSync(f.paths.held), [`${sending.id}.bundle`]);
  assert.equal((await f.lease('ses_2')).generation, 2);
  await assert.rejects(
    f.begin('checkpoint', 'ses_1', 1, f.root, bundle, 'command-late'),
    refused('code_generation_stale'),
  );
  await assert.rejects(
    f.begin('final', 'ses_1', 1, f.root, bundle),
    refused('code_generation_stale'),
  );
  assert.equal((await f.unit()).canonicalHead, null);
  assert.ok(!f.refs().some((ref) => ref.startsWith('refs/merv/work/')));
});
