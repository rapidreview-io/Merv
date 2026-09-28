import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Context } from 'cordis';
import {
  createService,
  MervError,
  type Blobs,
  type Caller,
  type LargeArtifactStorage,
  type Scope,
  type State,
} from '@merv/contracts';
import { DiskBlobs, blobsPlugin } from '@merv/blobs';
import { ProjectScope, scopePlugin } from '@merv/scope';
import { statePlugin } from '@merv/state';
import { ArtifactStore, artifactsPlugin } from '@merv/artifacts';
import { deferred } from './fixtures/deferred.js';
import { legacyArtifact } from './fixtures/legacy-artifact.js';
import { openState, stateConfig } from './fixtures/state.js';

type Logged = { event: string; [key: string]: unknown };

/** The backfill's log lines, and a wait for the end of its next pass. */
function backfillLog(t: TestContext) {
  const lines: Logged[] = [];
  t.mock.method(process.stderr, 'write', (chunk: unknown) => {
    const text = String(chunk);
    if (text.startsWith('{"event":"artifacts.backfill')) lines.push(JSON.parse(text) as Logged);
    return true;
  });
  const ends = () =>
    lines.filter((line) =>
      ['artifacts.backfill', 'artifacts.backfill_stopped'].includes(line.event),
    );
  return {
    lines,
    ends,
    /** The end of the nth pass: filled, skipped, failed and remaining, or why it stopped. */
    async pass(n: number) {
      for (let waited = 0; ends().length < n; waited += 10) {
        assert.ok(waited < 10_000, `pass ${n} never ended`);
        await delay(10);
      }
      return ends()[n - 1];
    },
  };
}

/** Large storage over a map of objects; reading an absent one is blob_not_found. */
function objects() {
  const stored = new Map<string, Buffer>();
  const failing = new Map<string, MervError>();
  const storage = {
    async read(_projectId: string, objectId: string) {
      const failure = failing.get(objectId);
      if (failure) throw failure;
      const bytes = stored.get(objectId);
      if (!bytes) throw new MervError('blob_not_found', 'Blob not found', 404);
      return bytes;
    },
  } as unknown as LargeArtifactStorage;
  return { stored, failing, storage };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'merv-artifact-backfill-'));
  const state = await openState(directory);
  t.after(async () => {
    await state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const disk = new DiskBlobs(join(directory, 'blobs'));
  const blobs = { gets: 0, failure: undefined as MervError | undefined };
  const counted: Blobs = {
    put: (namespace, bytes) => disk.put(namespace, bytes),
    async get(namespace, hash) {
      blobs.gets++;
      if (blobs.failure) throw blobs.failure;
      return await disk.get(namespace, hash);
    },
  };
  const scope = await createService(new ProjectScope(state));
  const store = () => createService(new ArtifactStore(state, scope, counted));
  const artifacts = await store();
  const boot = await scope.bootstrap({ projectName: 'Backfill', actorName: 'Owner' });
  const caller: Caller = { actorId: boot.actor.id, projectId: boot.project.id };
  const large = objects();
  /** A row from before bytes were kept in it, its bytes in blobs or, with objectId, an object. */
  const legacy = (text: string, objectId?: string) =>
    legacyArtifact(
      state,
      caller,
      Buffer.from(text),
      (bytes) => (objectId ? large.stored.set(objectId, bytes) : disk.put(caller.projectId, bytes)),
      objectId ? { objectId } : {},
    );
  return { directory, state, blobs, store, artifacts, caller, large, legacy };
}

const content = async (state: State, id: string) =>
  (
    await state.read((sql) =>
      sql.get<{ content: Buffer | null }>('SELECT content FROM artifacts WHERE id=?', id),
    )
  )?.content?.toString() ?? null;

test('the update guard lets only missing content be filled, with bytes the CHECK verifies', async (t) => {
  const f = await fixture(t);
  const row = await f.legacy('fill me');
  const update = (sql: string, ...params: (string | Buffer)[]) =>
    f.state.transaction((tx) => tx.run(sql, ...params, row.id));
  const bytes = Buffer.from('fill me');
  for (const [sql, ...params] of [
    ["UPDATE artifacts SET title='Other' WHERE id=?"],
    ["UPDATE artifacts SET content=?, title='Other' WHERE id=?", bytes],
    ["UPDATE artifacts SET content=?, session_id='ses' WHERE id=?", bytes],
    ['UPDATE artifacts SET content=? WHERE id=?', Buffer.from('fill it')],
  ] as const)
    await assert.rejects(update(sql, ...params), { code: 'state_constraint' }, sql);
  assert.equal(await content(f.state, row.id), null);
  assert.deepEqual(await update('UPDATE artifacts SET content=? WHERE id=?', bytes), {
    changes: 1,
  });
  assert.equal(await content(f.state, row.id), 'fill me');
  for (const [sql, ...params] of [
    ['UPDATE artifacts SET content=? WHERE id=?', bytes],
    ['UPDATE artifacts SET content=NULL WHERE id=?'],
    ['DELETE FROM artifacts WHERE id=?'],
  ] as const)
    await assert.rejects(update(sql, ...params), { code: 'state_constraint' }, sql);
});

test('the fill moves blob bytes into rows, and object bytes once large storage binds', async (t) => {
  const f = await fixture(t);
  const log = backfillLog(t);
  const blob = await f.legacy('blob bytes');
  const object = await f.legacy('object bytes', 'obj_1');
  const fresh = await f.artifacts.create(f.caller, { title: 'New', content: 'row bytes' });
  const stop = f.artifacts.backfill();
  assert.deepEqual(await log.pass(1), {
    event: 'artifacts.backfill',
    filled: 1,
    skipped: 0,
    failed: 0,
    remaining: 1,
  });
  assert.equal(await content(f.state, blob.id), 'blob bytes');
  assert.equal(await content(f.state, object.id), null);
  const unbind = f.artifacts.bindLarge(f.large.storage);
  assert.deepEqual(await log.pass(2), {
    event: 'artifacts.backfill',
    filled: 1,
    skipped: 0,
    failed: 0,
    remaining: 0,
  });
  await stop();
  unbind();
  assert.equal(await content(f.state, object.id), 'object bytes');
  // Filled rows read locally, with large storage gone and blobs down.
  f.blobs.failure = new MervError('blob_unavailable', 'Blob storage is down', 503);
  const gets = f.blobs.gets;
  for (const [id, text] of [
    [blob.id, 'blob bytes'],
    [object.id, 'object bytes'],
    [fresh.id, 'row bytes'],
  ])
    assert.equal((await f.artifacts.read(f.caller, id)).content, text);
  assert.equal(f.blobs.gets, gets);
});

test('the fill passes over bytes that are gone or corrupt, retries other failures, and fills the rest', async (t) => {
  const f = await fixture(t);
  const log = backfillLog(t);
  t.after(f.artifacts.bindLarge(f.large.storage));
  const missing = await legacyArtifact(f.state, f.caller, Buffer.from('never stored'), () => {});
  const corrupt = await f.legacy('corrupt blob');
  await writeFile(
    join(f.directory, 'blobs', f.caller.projectId, corrupt.hash.slice(0, 2), corrupt.hash),
    'tampered',
  );
  const changed = await f.legacy('declared object', 'obj_changed');
  f.large.stored.set('obj_changed', Buffer.from('replaced object'));
  const good = [await f.legacy('good blob'), await f.legacy('good object', 'obj_good')];
  // A failure that is not lost bytes counts apart from them, and the next pass fills the row.
  const flaky = await f.legacy('flaky object', 'obj_flaky');
  f.large.failing.set('obj_flaky', new MervError('sandbox_unavailable', 'Link failed', 503));
  const stop = f.artifacts.backfill();
  assert.deepEqual(await log.pass(1), {
    event: 'artifacts.backfill',
    filled: 2,
    skipped: 3,
    failed: 1,
    remaining: 4,
  });
  assert.deepEqual(
    log.lines
      .filter((line) => line.event === 'artifacts.backfill_failed')
      .map(({ artifactId, code }) => ({ artifactId, code })),
    [{ artifactId: flaky.id, code: 'sandbox_unavailable' }],
  );
  f.large.failing.clear();
  f.artifacts.bindLarge(f.large.storage);
  assert.deepEqual(await log.pass(2), {
    event: 'artifacts.backfill',
    filled: 1,
    skipped: 3,
    failed: 0,
    remaining: 3,
  });
  await stop();
  assert.equal(await content(f.state, flaky.id), 'flaky object');
  assert.deepEqual(
    log.lines
      .filter((line) => line.event === 'artifacts.backfill_skipped')
      .slice(0, 3)
      .map(({ artifactId, code }) => ({ artifactId, code }))
      .sort((a, b) => String(a.artifactId).localeCompare(String(b.artifactId))),
    [
      { artifactId: missing.id, code: 'artifact_bytes_missing' },
      { artifactId: corrupt.id, code: 'blob_corrupt' },
      { artifactId: changed.id, code: 'blob_corrupt' },
    ].sort((a, b) => a.artifactId.localeCompare(b.artifactId)),
  );
  for (const row of [missing, corrupt, changed]) assert.equal(await content(f.state, row.id), null);
  assert.equal(await content(f.state, good[0].id), 'good blob');
  assert.equal(await content(f.state, good[1].id), 'good object');
});

test('an outage stops the fill until the next kick', async (t) => {
  const f = await fixture(t);
  const log = backfillLog(t);
  const rows = [await f.legacy('first'), await f.legacy('second')];
  f.blobs.failure = new MervError('blob_unavailable', 'Blob storage is down', 503);
  const stop = f.artifacts.backfill();
  assert.deepEqual(await log.pass(1), {
    event: 'artifacts.backfill_stopped',
    filled: 0,
    skipped: 0,
    failed: 0,
    code: 'blob_unavailable',
  });
  assert.equal(f.blobs.gets, 1);
  f.blobs.failure = undefined;
  const unbind = f.artifacts.bindLarge(f.large.storage);
  assert.deepEqual(await log.pass(2), {
    event: 'artifacts.backfill',
    filled: 2,
    skipped: 0,
    failed: 0,
    remaining: 0,
  });
  await stop();
  unbind();
  for (const row of rows) assert.notEqual(await content(f.state, row.id), null);
});

test('a later boot fills only what is left, and stopping waits for the row in hand', async (t) => {
  const f = await fixture(t);
  const log = backfillLog(t);
  const first = await f.legacy('first boot');
  let stop = f.artifacts.backfill();
  await log.pass(1);
  await stop();
  const second = await f.legacy('second boot');
  const gets = f.blobs.gets;
  const rebooted = await f.store();
  stop = rebooted.backfill();
  assert.deepEqual(await log.pass(2), {
    event: 'artifacts.backfill',
    filled: 1,
    skipped: 0,
    failed: 0,
    remaining: 0,
  });
  await stop();
  assert.equal(f.blobs.gets, gets + 1);
  assert.equal(await content(f.state, first.id), 'first boot');
  assert.equal(await content(f.state, second.id), 'second boot');

  // Stopped while a row's bytes are in flight: that row is written, and no other is fetched.
  const held = [await f.legacy('held one'), await f.legacy('held two')];
  const bytes = new Map(held.map((row, i) => [row.hash, Buffer.from(['held one', 'held two'][i])]));
  const fetches: string[] = [];
  const entered = deferred();
  const release = deferred();
  const slow = await createService(
    new ArtifactStore(f.state, {} as Scope, {
      put: async () => {
        throw new Error('unused');
      },
      async get(_namespace, hash) {
        fetches.push(hash);
        entered.resolve();
        await release.promise;
        return bytes.get(hash)!;
      },
    }),
  );
  stop = slow.backfill();
  await entered.promise;
  const stopping = stop();
  release.resolve();
  await stopping;
  assert.equal(fetches.length, 1);
  assert.deepEqual(log.ends().at(-1), {
    event: 'artifacts.backfill_stopped',
    filled: 1,
    skipped: 0,
    failed: 0,
    code: 'stopped',
  });
  const filled = await Promise.all(held.map((row) => content(f.state, row.id)));
  assert.deepEqual(
    filled.filter((text) => text !== null),
    [bytes.get(fetches[0])!.toString()],
  );
});

test('only the plugin config starts the fill', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'merv-artifact-backfill-plugin-'));
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const log = backfillLog(t);
  const started = t.mock.method(ArtifactStore.prototype, 'backfill');
  await ctx.plugin(statePlugin, stateConfig(directory));
  await ctx.plugin(blobsPlugin, { root: join(directory, 'blobs') });
  await ctx.plugin(scopePlugin);
  let artifacts = await ctx.plugin(artifactsPlugin);
  const boot = await ctx.scope.bootstrap({ projectName: 'Plugin', actorName: 'Owner' });
  const caller: Caller = { actorId: boot.actor.id, projectId: boot.project.id };
  const row = await legacyArtifact(ctx.state, caller, Buffer.from('configured'), (bytes) =>
    ctx.blobs.put(caller.projectId, bytes),
  );
  await artifacts.dispose();
  artifacts = await ctx.plugin(artifactsPlugin, { backfill: false });
  assert.equal(started.mock.callCount(), 0);
  assert.equal(await content(ctx.state, row.id), null);
  await artifacts.dispose();
  artifacts = await ctx.plugin(artifactsPlugin, { backfill: true });
  assert.equal(started.mock.callCount(), 1);
  assert.equal((await log.pass(1)).filled, 1);
  assert.equal(await content(ctx.state, row.id), 'configured');
  await artifacts.dispose();
});
