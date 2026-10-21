import type { FaultPoint } from '@merv/code/store/operations';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  codeStoreFixture,
  faultAt,
  git,
  gitSource,
  seedLegacyOperation,
  recoverLegacyOperation,
} from './fixtures/code-store.js';

const complete = async (f: Awaited<ReturnType<typeof codeStoreFixture>>, id: string) =>
  recoverLegacyOperation(f.code, id);

test('retained legacy imports recover full and thin history without reviving transfer APIs', async (t) => {
  const source = gitSource(t);
  const one = source.commit({ 'README.md': 'one\n' });
  const f = await codeStoreFixture(t, {}, one);
  assert.equal((await f.code.status(f.admin)).project!.main.stored, false);
  for (const removed of ['importRepository', 'beginUpload', 'putPart', 'complete'])
    assert.equal(removed in f.store, false, `${removed} is retired`);
  const done = await f.deliver(source.bundle(one));
  assert.equal(done.status, 'completed');
  assert.deepEqual(await complete(f, done.id), done);
  assert.deepEqual(f.refs(), [`refs/merv/imports/${done.id} ${one}`]);
  assert.equal(existsSync(join(f.paths.quarantine, done.id)), false);
  const hosted = await f.code.status(f.admin);
  assert.equal(hosted.project!.main.stored, true);
  assert.deepEqual(
    [hosted.store!.hosted, hosted.store!.objectFormat, hosted.store!.rootOid],
    [true, 'sha1', one],
  );
  const two = source.commit({ 'README.md': 'two\n' });
  assert.equal((await f.deliver(source.bundle(two, [one]))).status, 'completed');
  assert.deepEqual((await f.code.status(f.admin)).store!.tips.sort(), [one, two].sort());
  git(f.paths.repository, ['fsck', '--strict', '--no-dangling']);
});

test('abandoned legacy partial bytes are swept', async (t) => {
  const source = gitSource(t);
  const bundle = source.bundle(source.commit({ 'a.txt': 'a\n' }));
  const swept = await codeStoreFixture(t, { abandonSeconds: 0 });
  const stale = await seedLegacyOperation(swept.code, swept.admin, bundle, { received: 10 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await swept.open();
  assert.deepEqual(await swept.operationRow(stale), {
    status: 'failed',
    phase: 'receiving',
    error: 'code_upload_abandoned',
  });
  assert.equal(existsSync(join(swept.paths.quarantine, stale)), false);
});

test('ending the process at every boundary leaves one receipt, one completed row and no quarantine', async (t) => {
  const source = gitSource(t);
  const tip = source.commit({ 'a.txt': 'a\n', 'dir/b.txt': 'b\n' });
  const bundle = source.bundle(tip);
  const points: FaultPoint[] = [
    'after_index',
    'after_admitting',
    'after_migrate',
    'after_objects_durable',
    'after_ref',
    'after_refs_applied',
    'before_ack',
  ];
  const phases: Record<string, string> = {};
  for (const point of points) {
    const f = await codeStoreFixture(t, {}, tip);
    await f.open({ fault: faultAt(point) });
    await assert.rejects(f.deliver(bundle, 'crashed'), new RegExp(`process ended ${point}`), point);
    const [{ id }] = (await f.code.status(f.admin)).operations.length
      ? (await f.code.status(f.admin)).operations
      : [{ id: '' }];
    const interrupted = id ? await f.operationRow(id) : undefined;
    phases[point] = interrupted ? `${interrupted.status}/${interrupted.phase}` : 'completed';

    // A new process on the same directory and database finishes what was journalled…
    await f.open();
    // …and the sender, who never heard back, simply asks again.
    const again = await f.deliver(bundle, 'crashed');
    assert.deepEqual(
      [again.status, again.phase, again.head],
      ['completed', 'refs_applied', tip],
      point,
    );
    assert.deepEqual(f.refs(), [`refs/merv/imports/${again.id} ${tip}`], point);
    const rows = await f.state.read(
      async (sql) =>
        await sql.all<{ status: string }>("SELECT status FROM code_operations WHERE kind='import'"),
    );
    assert.deepEqual(
      rows.map((row) => row.status),
      ['completed'],
      point,
    );
    await f.open();
    assert.deepEqual(
      existsSync(f.paths.quarantine) ? readdirSync(f.paths.quarantine) : [],
      [],
      point,
    );
    const status = await f.code.status(f.admin);
    assert.deepEqual(
      [status.store!.hosted, status.project!.main.stored, status.operations],
      [true, true, []],
      point,
    );
    git(f.paths.repository, ['fsck', '--strict', '--no-dangling']);
    assert.equal(
      readdirSync(join(f.paths.repository, 'objects', 'pack')).filter((name) =>
        name.endsWith('.pack'),
      ).length,
      1,
      point,
    );
  }
  // The journal stood where each boundary says it stands.
  assert.deepEqual(phases, {
    after_index: 'prepared/receiving',
    after_admitting: 'prepared/admitting',
    after_migrate: 'prepared/admitting',
    after_objects_durable: 'prepared/objects_durable',
    after_ref: 'prepared/objects_durable',
    after_refs_applied: 'prepared/refs_applied',
    before_ack: 'completed',
  });
});

test('a receipt ref that holds another commit stops recovery, which never invents a target', async (t) => {
  const source = gitSource(t);
  const kept = source.commit({ 'a.txt': 'a\n' });
  const tip = source.commit({ 'a.txt': 'b\n' });
  const f = await codeStoreFixture(t);
  assert.equal((await f.deliver(source.bundle(kept))).status, 'completed');
  await f.open({ fault: faultAt('after_objects_durable') });
  await assert.rejects(f.deliver(source.bundle(tip, [kept]), 'stuck'), /process ended/);
  const [open] = (await f.code.status(f.admin)).operations;
  assert.equal(open.waiting!.code, 'internal_error');
  git(f.paths.repository, ['update-ref', `refs/merv/imports/${open.id}`, kept]);

  await f.open();
  const [stopped] = (await f.code.status(f.admin)).operations;
  assert.deepEqual(
    [stopped.id, stopped.status, stopped.phase],
    [open.id, 'prepared', 'objects_durable'],
  );
  assert.equal(stopped.waiting!.code, 'code_recovery_required');
  assert.match(stopped.waiting!.next, /operator inspects/);
  await assert.rejects(complete(f, open.id), { code: 'code_recovery_required', status: 409 });
  // Once an operator has put the ref right, the same operation completes.
  git(f.paths.repository, ['update-ref', '-d', `refs/merv/imports/${open.id}`]);
  assert.equal((await complete(f, open.id)).status, 'completed');
  assert.equal(git(f.paths.repository, ['rev-parse', `refs/merv/imports/${open.id}`]), tip);
});

test('recovery waits for space without losing the persisted operation', async (t) => {
  const source = gitSource(t);
  const bundle = source.bundle(source.commit({ 'a.txt': 'a\n' }));
  const f = await codeStoreFixture(t);
  const id = await seedLegacyOperation(f.code, f.admin, bundle);
  await f.open({ config: { reservedFreeBytes: Number.MAX_SAFE_INTEGER } });
  await assert.rejects(complete(f, id), { code: 'code_store_full', status: 507 });
  assert.deepEqual(await f.operationRow(id), {
    status: 'prepared',
    phase: 'receiving',
    error: null,
  });
  await f.open();
  assert.equal((await complete(f, id)).status, 'completed');
});
