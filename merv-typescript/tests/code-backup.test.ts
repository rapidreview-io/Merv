import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '@merv/contracts';
import {
  codePrefix,
  databasePrefix,
  postgresDump,
  stampOf,
  type BackupManifest,
  type CodeBackupSettings,
} from '@merv/code/store/backup';
import { codePlugin } from '@merv/code-research';
import { restoreCode } from '../src/code-restore.js';
import { fakeBackupStore, type FakeBackupStore } from './fixtures/backup-store.js';
import { codeStoreFixture, gitSource } from './fixtures/code-store.js';
import { postgresUrl } from './fixtures/state.js';

const DEPLOYMENT = 'merv_ts_backup';
// Every copy includes the database, so a machine without pg_dump fails here rather than
// passing with the database copy, its retention and its restore check left out.
assert.equal(
  spawnSync('pg_dump', ['--version'], { stdio: 'ignore' }).status,
  0,
  'Install the PostgreSQL 17 client (pg_dump) to run the Code backup tests',
);
const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex');

/** The same administrator, reaching a tool through a lease instead of in person. */
const leased = (admin: Caller): Caller => ({
  projectId: admin.projectId,
  actorId: admin.actorId,
  session: { id: 'session-one' },
});

async function backedUp(
  t: TestContext,
  over: Partial<CodeBackupSettings> = {},
): Promise<{
  f: Awaited<ReturnType<typeof codeStoreFixture>>;
  store: FakeBackupStore;
  source: ReturnType<typeof gitSource>;
  prefix: string;
  /** The live settings object, which a test changes to stand for a later configuration. */
  settings: CodeBackupSettings;
  manifest(): BackupManifest;
}> {
  const store = fakeBackupStore();
  const f = await codeStoreFixture(t);
  const settings: CodeBackupSettings = {
    deployment: DEPLOYMENT,
    store,
    everySeconds: 86_400,
    keepDays: 30,
    maxBytes: 4 * 1024 * 1024 * 1024,
    database: postgresDump(postgresUrl, f.schema),
    ...over,
  };
  await f.open({ config: { backup: settings } });
  const source = gitSource(t);
  await f.deliver(source.bundle(source.commit({ 'read.me': 'first' })));
  const prefix = codePrefix(DEPLOYMENT, f.admin.projectId);
  return {
    f,
    store,
    source,
    prefix,
    settings,
    manifest: () =>
      JSON.parse(store.objects.get(`${prefix}latest.json`)!.toString('utf8')) as BackupManifest,
  };
}

test('one run writes a verified bundle, the database copy and a manifest that names both', async (t) => {
  const { f, store, prefix } = await backedUp(t);
  // Configured and never copied is a server to attend to, and must not read like one
  // that keeps no off-host copy at all — which is what `backup: null` means.
  assert.deepEqual(await f.code.status(f.admin).then((read) => read.store!.backup), {
    at: null,
    verifiedAt: null,
    bytes: 0,
    key: null,
    refsHash: null,
    warnings: [],
  });
  const status = await f.code.runBackup(f.admin, { requestId: 'copy-one' });
  const manifest = JSON.parse(
    store.objects.get(`${prefix}latest.json`)!.toString('utf8'),
  ) as BackupManifest;

  assert.equal(manifest.format, 1);
  assert.equal(manifest.deployment, DEPLOYMENT);
  assert.equal(manifest.projectId, f.admin.projectId);
  assert.equal(manifest.repositoryId, 'fixture-repository');
  assert.equal(manifest.marker, readFileSync(f.paths.marker, 'utf8'));
  // The manifest's refs are exactly what the repository holds, name for name.
  assert.deepEqual(manifest.refs.map((ref) => `${ref.name} ${ref.oid}`).sort(), f.refs().sort());
  const bundle = manifest.bundle!;
  assert.match(bundle.key, new RegExp(`^${prefix}\\d{8}T\\d{6}Z-[0-9a-f]{16}\\.bundle$`));
  assert.equal(sha(store.objects.get(bundle.key)!), bundle.sha256);
  assert.equal(store.objects.get(bundle.key)!.byteLength, bundle.bytes);
  assert.equal(store.objects.get(bundle.key)!.subarray(0, 12).toString(), '# v2 git bun');

  const database = manifest.database!;
  assert.equal(database.backend, 'postgres');
  assert.ok(database.key.startsWith(databasePrefix(DEPLOYMENT)));
  assert.match(database.key, /\.sql\.gz$/);
  assert.equal(sha(store.objects.get(database.key)!), database.sha256);
  assert.equal(store.objects.get(database.key)!.byteLength, database.bytes);
  // The database is copied first, so a restored repository is never behind its rows.
  assert.ok(store.calls.indexOf(`put ${database.key}`) < store.calls.indexOf(`put ${bundle.key}`));

  assert.equal(status.key, bundle.key);
  assert.deepEqual(status.warnings, []);
  assert.ok(status.bytes >= bundle.bytes);
  // Nothing about a copy is remembered in this process: the journal row is the record.
  const read = await f.code.status(f.admin);
  assert.deepEqual(read.store!.backup, status);
  assert.equal(read.warnings.length, 0);
});

test('the same request replays, unchanged refs reuse the bundle and a change writes a new one', async (t) => {
  // Only the repository copy is in question here; the database copy is the tests around it.
  const { f, store, source, prefix, manifest } = await backedUp(t, { database: undefined });
  const first = await f.code.runBackup(f.admin, { requestId: 'copy-one' });
  const objects = [...store.objects.keys()].sort();

  const replayed = await f.code.runBackup(f.admin, { requestId: 'copy-one' });
  assert.deepEqual(replayed, first);
  assert.deepEqual([...store.objects.keys()].sort(), objects);
  await assert.rejects(f.code.runBackup(f.admin, { requestId: 'copy-one!' }), {
    code: 'invalid_code_input',
  });

  // Nothing in a Code repository is ever pruned, so unchanged refs mean unchanged objects.
  const again = await f.code.runBackup(f.admin, { requestId: 'copy-two' });
  assert.equal(again.key, first.key);
  assert.equal(again.refsHash, first.refsHash);
  assert.ok(again.bytes < first.bytes);
  assert.equal(manifest().bundle!.key, first.key);

  await f.deliver(source.bundle(source.commit({ 'read.me': 'second' }), [manifest().refs[0].oid]));
  const moved = await f.code.runBackup(f.admin, { requestId: 'copy-three' });
  assert.notEqual(moved.key, first.key);
  assert.notEqual(moved.refsHash, first.refsHash);
  assert.ok(store.objects.has(first.key!) && store.objects.has(moved.key!));
  assert.equal(manifest().bundle!.key, moved.key);
  assert.ok(moved.key!.startsWith(prefix));
});

test('retention removes copies older than keepDays and never the one the pointer names', async (t) => {
  const { f, store, source, prefix, manifest } = await backedUp(t, { keepDays: 0 });
  await f.code.runBackup(f.admin, { requestId: 'copy-one' });
  const first = manifest().bundle!.key;
  await f.deliver(source.bundle(source.commit({ 'read.me': 'second' }), [manifest().refs[0].oid]));
  await f.code.runBackup(f.admin, { requestId: 'copy-two' });
  const second = manifest().bundle!.key;

  assert.equal(store.objects.has(first), false);
  assert.equal(store.objects.has(second), true);
  assert.deepEqual(
    [...store.objects.keys()].filter((key) => key.startsWith(prefix)).sort(),
    [
      second,
      `${prefix}${manifest()
        .takenAt.replace(/[-:]/g, '')
        .replace(/\.\d+Z$/, 'Z')}.manifest.json`,
      `${prefix}latest.json`,
    ].sort(),
  );

  // An idle project keeps its only copy however old it is; pruning it would leave the
  // pointer naming nothing. A pass over every project is also what prunes the database.
  await f.code.backupStep('copy-three');
  assert.equal(store.objects.has(manifest().bundle!.key), true);
  const kept = [...store.objects.keys()].filter((key) =>
    key.startsWith(databasePrefix(DEPLOYMENT)),
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0], manifest().database!.key);
});

test('a restore verifies what the bucket holds, writes it back and refuses a live root', async (t) => {
  const { f, store, source, prefix } = await backedUp(t);
  await f.code.runBackup(f.admin, { requestId: 'copy-one' });
  const manifest = JSON.parse(
    store.objects.get(`${prefix}latest.json`)!.toString('utf8'),
  ) as BackupManifest;
  const drill = async (verifyOnly: boolean, root?: string, overwrite = false) =>
    await restoreCode({
      store,
      deployment: DEPLOYMENT,
      verifyOnly,
      overwrite,
      ...(root ? { root } : {}),
    });

  const verified = await drill(true);
  assert.deepEqual(verified.problems, []);
  assert.equal(verified.projects.length, 1);
  assert.equal(verified.projects[0].state, 'verified');
  assert.equal(verified.projects[0].refs, manifest.refs.length);

  // One byte of the bundle is enough: the drill is what tells a copy from a belief.
  const sound = store.objects.get(manifest.bundle!.key)!;
  store.objects.set(manifest.bundle!.key, Buffer.concat([sound.subarray(0, -1), Buffer.of(0)]));
  const corrupt = await drill(true);
  assert.equal(corrupt.projects[0].state, 'failed');
  assert.match(corrupt.problems.join(' '), /is not the object the manifest names/);
  store.objects.set(manifest.bundle!.key, sound);

  const root = mkdtempSync(join(tmpdir(), 'merv-restore-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const restored = await drill(false, join(root, 'code'));
  assert.deepEqual(restored.problems, []);
  assert.equal(restored.projects[0].state, 'restored');
  assert.equal(restored.database?.state, 'verified');
  // The same copy over the copy it made is no rewind: the refs are already exactly these.
  assert.equal((await drill(false, join(root, 'code'))).projects[0].state, 'restored');

  // The lock only proves no server is running, and during an incident none is. A newer
  // copy over a root that holds other refs would force-rewind them, so it is refused.
  await f.deliver(source.bundle(source.commit({ 'read.me': 'second' }), [manifest.refs[0].oid]));
  await f.code.runBackup(f.admin, { requestId: 'copy-two' });
  const onto = await drill(false, join(root, 'code'));
  assert.equal(onto.projects[0].state, 'failed');
  assert.match(onto.problems.join(' '), /would rewind/);
  const forced = await drill(false, join(root, 'code'), true);
  assert.deepEqual(forced.problems, []);
  assert.equal(forced.projects[0].state, 'restored');

  // One server writes to a volume at a time, and a restore is a writer.
  await assert.rejects(drill(false, f.root), { code: 'code_repository_locked' });
});

test('a bundle larger than one object may be leaves the last good copy newest', async (t) => {
  // A database copy over the same ceiling fails the whole run instead: a repository
  // without its rows is inert, which is the reason the dump travels with it at all.
  const { f, store, prefix } = await backedUp(t, {
    maxBytes: 1,
    database: undefined,
  });
  const status = await f.code.runBackup(f.admin, { requestId: 'copy-one' });
  assert.deepEqual(status.warnings, ['code_backup_too_large']);
  assert.equal(status.key, null);
  // Half a copy would be worse than none: nothing of the repository was written, and the
  // pointer a restore reads is left exactly as it was.
  assert.equal(
    [...store.objects.keys()].some((key) => key.startsWith(prefix)),
    false,
  );
  const read = await f.code.status(f.admin);
  assert.deepEqual(read.store!.backup, status);
  assert.deepEqual(
    read.warnings.map((warning) => [warning.code, warning.ref]),
    [['code_backup_too_large', 'backup']],
  );
});

test('a leased worker never gains a human-only copy', async (t) => {
  const { f, store } = await backedUp(t);
  await assert.rejects(f.code.runBackup(leased(f.admin), { requestId: 'copy-one' }), {
    code: 'session_forbidden',
  });
  assert.equal(store.objects.size, 0);

  const plain = await codeStoreFixture(t);
  await assert.rejects(plain.code.runBackup(plain.admin, { requestId: 'copy-one' }), {
    code: 'code_backup_unconfigured',
  });
  // The shape of the authority is answered before the project is looked up, so a lease
  // is refused as a lease rather than told whether this server keeps copies at all.
  await assert.rejects(plain.code.runBackup(leased(plain.admin), { requestId: 'copy-one' }), {
    code: 'session_forbidden',
  });
});

test('an over-size pass leaves the copy the pointer still names', async (t) => {
  // keepDays: 0 puts every object in the bucket past retention at once, which is the
  // state an idle project reaches on its own on day keepDays + 1.
  const { f, store, source, prefix, settings, manifest } = await backedUp(t, {
    keepDays: 0,
    database: undefined,
  });
  await f.code.runBackup(f.admin, { requestId: 'copy-one' });
  const good = manifest().bundle!.key;
  const pointer = `${prefix}${stampOf(manifest().takenAt)}.manifest.json`;
  await f.deliver(source.bundle(source.commit({ 'read.me': 'second' }), [manifest().refs[0].oid]));

  settings.maxBytes = 1;
  const status = await f.code.runBackup(f.admin, { requestId: 'copy-two' });
  assert.deepEqual(status.warnings, ['code_backup_too_large']);
  // A pass that wrote no new pointer retires nothing: latest.json still resolves to the
  // bundle it names, which is the only real copy a repository this large has.
  assert.equal(store.objects.has(good), true);
  assert.equal(store.objects.has(pointer), true);
  assert.equal(manifest().bundle!.key, good);
});

test("the transient bundle is measured against the volume, not the project's quota", async (t) => {
  const { f, store, settings } = await backedUp(t, { database: undefined });
  const disk = await f.code.status(f.admin).then((read) => read.store!.diskBytes);
  // A repository at its quota. Charging it a bundle that is deleted at the end of the
  // same pass would refuse a copy to every project past half of it, forever.
  await f.open({ config: { quotaBytes: disk, backup: settings } });
  const status = await f.code.runBackup(f.admin, { requestId: 'copy-one' });
  assert.deepEqual(status.warnings, []);
  assert.ok(status.key && store.objects.has(status.key));
});

test('one pass runs at a time, whoever asked for it', async (t) => {
  const { f, store } = await backedUp(t, { database: undefined });
  const head = store.head.bind(store);
  let entered!: () => void;
  let release!: () => void;
  const inPass = new Promise<void>((resolve) => (entered = resolve));
  const resume = new Promise<void>((resolve) => (release = resolve));
  let held = false;
  store.head = async (key) => {
    if (!held) {
      held = true;
      entered();
      await resume;
    }
    return head(key);
  };
  const first = f.code.runBackup(f.admin, { requestId: 'copy-one' });
  await inPass;
  try {
    await assert.rejects(f.code.runBackup(f.admin, { requestId: 'copy-two' }), {
      code: 'code_backup_busy',
    });
  } finally {
    release();
    await first;
  }
  // The refusal is the whole of it: the run that was refused left no journal row behind.
  const after = await f.code.runBackup(f.admin, { requestId: 'copy-two' });
  assert.equal(after.warnings.length, 0);
});

test('the database beside the repositories is only ever a PostgreSQL dump', () => {
  const backup = (database: unknown) =>
    codePlugin.Config.safeParse({ repositories: { backup: { database } } });
  assert.deepEqual(backup({ backend: 'postgres' }).data?.repositories?.backup?.database, {
    backend: 'postgres',
    connectionStringEnv: 'MERV_DB_URL',
    schemaEnv: 'MERV_TS_DB_SCHEMA',
  });
  // Server state is never a file, so a file copy would leave every row out of the backup.
  for (const database of [
    { backend: 'sqlite', path: 'state.sqlite' },
    { backend: 'postgres', path: 'state.sqlite' },
  ])
    assert.equal(backup(database).success, false, JSON.stringify(database));
});
