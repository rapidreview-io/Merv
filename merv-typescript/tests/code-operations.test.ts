import type { FaultPoint } from '@merv/code/store/operations';
import type { CodeStoreOperation } from '@merv/code/store/protocol';
import type { Caller } from '@merv/contracts';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { codeStoreFixture, faultAt, git, gitSource } from './fixtures/code-store.js';

const complete = async (f: Awaited<ReturnType<typeof codeStoreFixture>>, id: string) =>
  (
    (await f.code.v2!.call(f.admin, `uploads/${id}/complete`, {})) as {
      operation: CodeStoreOperation;
    }
  ).operation;

test('a repository is imported in parts, continued by a thin bundle, and every call replays', async (t) => {
  const source = gitSource(t);
  const one = source.commit({
    'README.md': 'one\n',
    'data.txt': Array.from({ length: 3000 }, (_, index) => `row ${index}`).join('\n'),
  });
  const f = await codeStoreFixture(t, {}, one);
  const before = await f.code.status(f.admin);
  assert.equal(before.project!.main.stored, false);
  assert.equal(before.store!.hosted, false);

  const first = source.bundle(one);
  const input = {
    source: 'bundle' as const,
    tip: one,
    bundle: { sha256: first.sha256, bytes: first.bytes },
    requestId: 'first',
  };
  const begun = await f.code.importRepository(f.admin, input);
  assert.deepEqual(
    [begun.kind, begun.status, begun.phase, begun.received, begun.bytes, begun.head],
    ['import', 'prepared', 'receiving', 0, first.bytes, one],
  );
  assert.deepEqual(await f.code.importRepository(f.admin, input), begun);
  await assert.rejects(f.code.importRepository(f.admin, { ...input, tip: 'b'.repeat(40) }), {
    code: 'request_conflict',
  });
  // Completing before the bytes arrived is refused and says how far they got.
  await assert.rejects(complete(f, begun.id), { code: 'code_upload_incomplete' });
  assert.match(
    (
      (await f.code.v2!.call(f.admin, `uploads/${begun.id}`, {})) as {
        operation: CodeStoreOperation;
      }
    ).operation.waiting!.next,
    /parts from `received` on/,
  );

  const half = Math.floor(first.bytes / 2);
  const put = (offset: number, end: number) =>
    f.code.v2!.putPart(f.admin, begun.id, offset, first.content.subarray(offset, end));
  assert.deepEqual(await put(0, half), { received: half });
  // The same part again is a replay; one that starts elsewhere is refused.
  assert.deepEqual(await put(0, half), { received: half });
  await assert.rejects(put(half + 1, first.bytes), { code: 'code_upload_offset', status: 409 });
  await assert.rejects(put(0, first.bytes), { code: 'code_upload_offset' });
  assert.equal(
    (
      (await f.code.v2!.call(f.admin, `uploads/${begun.id}`, {})) as {
        operation: CodeStoreOperation;
      }
    ).operation.received,
    half,
  );
  await assert.rejects(
    f.code.v2!.putPart(
      f.admin,
      begun.id,
      half,
      Buffer.concat([first.content.subarray(half), Buffer.from('x')]),
    ),
    { code: 'code_upload_too_large', status: 413 },
  );
  assert.deepEqual(await put(half, first.bytes), { received: first.bytes });

  const done = await complete(f, begun.id);
  assert.deepEqual(
    [done.status, done.phase, done.error, done.findings],
    ['completed', 'refs_applied', null, []],
  );
  assert.deepEqual(await complete(f, begun.id), done);
  assert.deepEqual(await f.code.importRepository(f.admin, input), done);
  await assert.rejects(put(0, half), { code: 'code_upload_closed' });
  assert.deepEqual(f.refs(), [`refs/merv/imports/${begun.id} ${one}`]);
  assert.equal(existsSync(join(f.paths.quarantine, begun.id)), false);

  const hosted = await f.code.status(f.admin);
  // Main was already named; the import found it in what it admitted.
  assert.equal(hosted.project!.main.stored, true);
  assert.deepEqual(
    [
      hosted.store!.hosted,
      hosted.store!.objectFormat,
      hosted.store!.rootOid,
      hosted.store!.source,
      hosted.store!.tips,
    ],
    [true, 'sha1', one, 'bundle', [one]],
  );
  assert.ok(hosted.store!.diskBytes > 0);
  assert.deepEqual(hosted.operations, []);
  assert.deepEqual(
    (await f.state.events(f.admin.projectId))
      .filter((event) => event.type.startsWith('code.'))
      .map((event) => [event.type, event.data.head]),
    [['code.repository_imported', one]],
  );

  // A later import builds on what is kept and sends only what is new.
  const two = source.commit({ 'README.md': 'two\n' });
  const thin = source.bundle(two, [one]);
  assert.ok(thin.bytes < first.bytes / 2);
  const continued = await f.deliver(thin);
  assert.equal(continued.status, 'completed');
  const status = await f.code.status(f.admin);
  assert.deepEqual(status.store!.tips.sort(), [one, two].sort());
  assert.equal(status.store!.rootOid, one);
  assert.equal(git(f.paths.repository, ['cat-file', '-t', two]), 'commit');
  git(f.paths.repository, ['fsck', '--strict', '--no-dangling']);
});

test('only the administrator who began an import continues it, and a worker never does', async (t) => {
  const source = gitSource(t);
  const bundle = source.bundle(source.commit({ 'a.txt': 'a\n' }));
  const f = await codeStoreFixture(t, { receiving: 1 });
  const input = {
    source: 'bundle' as const,
    tip: bundle.tip,
    bundle: { sha256: bundle.sha256, bytes: bundle.bytes },
    requestId: 'one',
  };
  const issue = async (role: 'operator' | 'producer') => {
    const issued = await f.scope.credentials.issueActor(f.admin, { name: role, role });
    return {
      projectId: f.admin.projectId,
      actorId: issued.actor.id,
      credentialId: issued.credential.id,
    } satisfies Caller;
  };
  const producer = await issue('producer');
  await assert.rejects(f.code.importRepository(producer, input), { status: 403 });
  await assert.rejects(
    f.code.importRepository({ ...f.admin, session: { id: 's' } } as Caller, input),
    (error: { status: number }) => error.status === 403,
  );
  await assert.rejects(
    f.code.configureRepository(producer, {
      denyGlobs: [],
      secretExemptGlobs: [],
      check: null,
      requestId: 'c',
    }),
    { status: 403 },
  );
  const begun = await f.code.importRepository(f.admin, input);
  const other = await issue('operator');
  await assert.rejects(f.code.v2!.putPart(other, begun.id, 0, bundle.content), {
    code: 'code_operation_forbidden',
  });
  await assert.rejects(f.code.v2!.putPart(producer, begun.id, 0, bundle.content), {
    status: 403,
  });
  await assert.rejects(f.code.v2!.call(other, `uploads/${begun.id}/complete`, {}), {
    code: 'code_operation_forbidden',
  });
  await assert.rejects(f.code.v2!.call(f.admin, 'uploads/cop_missing/complete', {}), {
    code: 'code_operation_not_found',
  });
  await assert.rejects(f.code.v2!.call(f.admin, 'anything/else', {}), { code: 'not_found' });
  // One project holds only so many unfinished transfers.
  await assert.rejects(f.code.importRepository(other, { ...input, requestId: 'two' }), {
    code: 'code_store_unavailable',
    status: 503,
  });

  // A project from before Code initialized projects is given its repository by the import, as
  // by new work: nothing else would give it one.
  const elsewhere = await f.scope.credentials.bootstrap({
    projectName: 'Unbound',
    actorName: 'Owner',
  });
  // Only to one who may import: a producer's call is refused before anything is initialized.
  const owner = {
    projectId: elsewhere.project.id,
    actorId: elsewhere.actor.id,
    credentialId: elsewhere.credential.id,
  };
  const writer = await f.scope.credentials.issueActor(owner, { name: 'w', role: 'producer' });
  await assert.rejects(
    f.code.importRepository(
      { ...owner, actorId: writer.actor.id, credentialId: writer.credential.id },
      input,
    ),
    { status: 403 },
  );
  const initialized = () =>
    f.state.read((sql) =>
      sql.get('SELECT project_id FROM code_projects WHERE project_id=?', owner.projectId),
    );
  assert.equal(await initialized(), undefined);
  const early = await f.code.importRepository(owner, input);
  assert.equal(early.status, 'prepared');
  assert.ok(await initialized());

  // A transfer nobody continues is given up by the next sweep, and its bytes go with it.
  await f.code.v2!.putPart(f.admin, begun.id, 0, bundle.content.subarray(0, 10));
  await f.open();
  assert.equal((await f.operationRow(begun.id))!.status, 'prepared');
  const swept = await codeStoreFixture(t, { abandonSeconds: 0 });
  const stale = await swept.code.importRepository(swept.admin, input);
  await swept.code.v2!.putPart(swept.admin, stale.id, 0, bundle.content.subarray(0, 10));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await swept.open();
  assert.deepEqual(await swept.operationRow(stale.id), {
    status: 'failed',
    phase: 'receiving',
    error: 'code_upload_abandoned',
  });
  assert.equal(existsSync(join(swept.paths.quarantine, stale.id)), false);
});

test('a part authorizes its sender itself: one whose credential was revoked is refused', async (t) => {
  const source = gitSource(t);
  const bundle = source.bundle(source.commit({ 'a.txt': 'a\n' }));
  const f = await codeStoreFixture(t);
  const begun = await f.code.importRepository(f.admin, {
    source: 'bundle',
    tip: bundle.tip,
    bundle: { sha256: bundle.sha256, bytes: bundle.bytes },
    requestId: 'revoked',
  });
  const other = await f.scope.credentials.issueActor(f.admin, {
    name: 'Operator',
    role: 'operator',
  });
  await f.scope.credentials.revokeCredential(
    { projectId: f.admin.projectId, actorId: other.actor.id, credentialId: other.credential.id },
    f.admin.credentialId!,
  );
  // The API decides once, before a part's bytes arrive; the part decides again as it is stored.
  await assert.rejects(f.code.v2!.putPart(f.admin, begun.id, 0, bundle.content), {
    code: 'forbidden',
  });
});

test('ending the process at every boundary leaves one receipt, one completed row and no quarantine', async (t) => {
  const source = gitSource(t);
  const tip = source.commit({ 'a.txt': 'a\n', 'dir/b.txt': 'b\n' });
  const bundle = source.bundle(tip);
  const points: FaultPoint[] = [
    'after_part',
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
    await assert.rejects(
      f.deliver(bundle, 64, 'crashed'),
      new RegExp(`process ended ${point}`),
      point,
    );
    const [{ id }] = (await f.code.status(f.admin)).operations.length
      ? (await f.code.status(f.admin)).operations
      : [{ id: '' }];
    const interrupted = id ? await f.operationRow(id) : undefined;
    phases[point] = interrupted ? `${interrupted.status}/${interrupted.phase}` : 'completed';

    // A new process on the same directory and database finishes what was journalled…
    await f.open();
    // …and the sender, who never heard back, simply asks again.
    const again = await f.deliver(bundle, 64, 'crashed');
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
    after_part: 'prepared/receiving',
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
  await assert.rejects(f.deliver(source.bundle(tip, [kept]), 1024, 'stuck'), /process ended/);
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

test('a full volume or an exhausted quota refuses bytes and leaves the operation open', async (t) => {
  const source = gitSource(t);
  const bundle = source.bundle(source.commit({ 'a.txt': 'a\n' }));
  const input = {
    source: 'bundle' as const,
    tip: bundle.tip,
    bundle: { sha256: bundle.sha256, bytes: bundle.bytes },
    requestId: 'one',
  };
  const small = await codeStoreFixture(t, { quotaBytes: bundle.bytes - 1 });
  await assert.rejects(small.code.importRepository(small.admin, input), {
    code: 'code_store_full',
    status: 507,
  });
  assert.deepEqual((await small.code.status(small.admin)).operations, []);

  const starved = await codeStoreFixture(t, {
    reservedFreeBytes: Number.MAX_SAFE_INTEGER,
  });
  await assert.rejects(starved.code.importRepository(starved.admin, input), {
    code: 'code_store_full',
  });

  // The volume fills while a transfer is under way: the part is refused, the operation stays.
  const f = await codeStoreFixture(t);
  const begun = await f.code.importRepository(f.admin, input);
  await f.code.v2!.putPart(f.admin, begun.id, 0, bundle.content.subarray(0, 100));
  await f.open({ config: { reservedFreeBytes: Number.MAX_SAFE_INTEGER } });
  await assert.rejects(f.code.v2!.putPart(f.admin, begun.id, 100, bundle.content.subarray(100)), {
    code: 'code_store_full',
    status: 507,
  });
  assert.deepEqual(await f.operationRow(begun.id), {
    status: 'prepared',
    phase: 'receiving',
    error: null,
  });
  await f.open();
  assert.deepEqual(await f.code.v2!.putPart(f.admin, begun.id, 100, bundle.content.subarray(100)), {
    received: bundle.bytes,
  });
  assert.equal((await complete(f, begun.id)).status, 'completed');
});
