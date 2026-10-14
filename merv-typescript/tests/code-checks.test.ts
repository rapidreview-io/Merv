import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { MervError } from '@merv/contracts';
import { migrate, openDatabase } from '@sandboxes/db';
import { ManualClock } from '@sandboxes/kernel';
import { ObjectStorage } from '@sandboxes/storage';
import { MemoryObjectStore } from '@sandboxes/storage/memory';
import { checkScript, SandboxCheckRunner } from '@merv/code-work/checks';
import type { SandboxCheckSpec } from '@merv/code-work/check-types';
import { postgresUrl, schemaFor } from './fixtures/state.js';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bytes = Buffer.from('a gzipped tree');
const spec: SandboxCheckSpec = {
  provider: 'fake',
  offerId: 'tiny:east',
  snapshotId: null,
  command: 'make test',
  timeoutSeconds: 600,
  leaseSeconds: 2100,
  source: { bytes, sha256: sha(bytes) },
  idempotencyKey: `chk:${'c'.repeat(64)}:1`,
};
type Services = ConstructorParameters<typeof SandboxCheckRunner>[0];

async function bootHost(t: TestContext) {
  const { Context } = await import('cordis');
  const { createMervHostPlugin } = await import('@sandboxes/merv-host');
  const schema = schemaFor();
  const db = await openDatabase({ url: postgresUrl, schema });
  t.after(() => db.close());
  await migrate(db, { schemaExplicit: true });
  const dataDir = mkdtempSync(join(tmpdir(), 'merv-check-host-'));
  const clock = new ManualClock();
  const ctx = new Context();
  ctx.provide('scope', {
    async serviceActor(provider: string, projectId: string) {
      return { actorId: `service:${provider}`, projectId };
    },
    async require(_caller: unknown, need: string) {
      assert.equal(need, 'write');
    },
  } as unknown as Services['scope']);
  const host = createMervHostPlugin({
    MervError,
    clock,
    env: {
      MERV_CHECK_DATABASE_URL: postgresUrl,
      MERV_CHECK_VAULT_KEY: Buffer.alloc(32, 7).toString('base64url'),
    },
  });
  const fiber = ctx.plugin(
    host,
    host.Config.parse({
      schema,
      databaseUrlEnv: 'MERV_CHECK_DATABASE_URL',
      vaultKeyEnv: 'MERV_CHECK_VAULT_KEY',
      publicOrigin: 'https://sandboxes.example',
      dataDir,
      relayEvents: false,
      settings: {
        providers: [{ name: 'fake', plugin: 'fake' }],
        storage: {
          multipart_part_bytes: 5 * 1024 * 1024,
          endpoint: 'https://storage.test',
          bucket: 'checks',
          access_key: 'test',
          secret_key: 'test',
        },
      },
    }),
  );
  t.after(async () => {
    await fiber.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await fiber.await();
  await ctx.sbxAccounts.ensureNativeNamespace('checks');
  await db.run("UPDATE infra_namespaces SET merv_project_id = 'project' WHERE name = 'checks'");
  const store = new MemoryObjectStore();
  const services = {
    scope: ctx.scope,
    sbxMerv: ctx.sbxMerv,
    sbxPipelines: ctx.sbxPipelines,
    sbxRegistry: ctx.sbxRegistry,
    sbxJobs: ctx.sbxJobs,
    sbxSnapshots: ctx.sbxSnapshots,
    sbxObjects: new ObjectStorage({ db, settings: ctx.sbxSettings, clock, store }),
  };
  t.mock.method(globalThis, 'fetch', async (target: string, init: RequestInit) => {
    store.uploaded.set(
      new URL(target).pathname.slice(1),
      Buffer.from(await (init.body as Blob).arrayBuffer()),
    );
    return new Response(null, { status: 200 });
  });
  return { ctx, db, clock, store, services, runner: () => new SandboxCheckRunner(services) };
}

test('source upload resumes missing parts by offset and refuses a bad digest before renting', async (t) => {
  const { ctx, store, runner } = await bootHost(t);
  const parts = new Map<number, Buffer>();
  const sent: Buffer[] = [];
  t.mock.method(store, 'parts', async () =>
    [...parts].map(([PartNumber, data]) => ({ PartNumber, Size: data.length, ETag: 'opaque' })),
  );
  t.mock.method(store, 'complete', async (key: string) => {
    store.files.set(
      key,
      Buffer.concat([...parts].sort(([a], [b]) => a - b).map(([, data]) => data)),
    );
  });
  t.mock.method(globalThis, 'fetch', async (target: string, init: RequestInit) => {
    const data = Buffer.from(await (init.body as Blob).arrayBuffer());
    sent.push(data);
    parts.set(Number(new URL(target).searchParams.get('part')), data);
    return new Response(null, { status: 200 });
  });
  const bytes = Buffer.concat([Buffer.alloc(5 * 1024 * 1024, 97), Buffer.from('last part')]);
  const plan = { ...spec, source: { bytes, sha256: sha(bytes) } };
  parts.set(1, Buffer.alloc(5 * 1024 * 1024, 98));
  await assert.rejects(
    runner().start('project', { ...plan, idempotencyKey: `${spec.idempotencyKey}-bad` }),
    { code: 'sandbox_validation' },
  );
  assert.equal((await ctx.sbxRegistry.list('checks')).length, 0, 'no rental for unverified bytes');
  parts.clear();
  sent.length = 0;
  parts.set(1, bytes.subarray(0, 5 * 1024 * 1024));
  await runner().start('project', plan);
  assert.deepEqual(sent, [Buffer.from('last part')]);
});

test('the host replays rentals, restores and jobs, and retries cleanup safely', async (t) => {
  const { ctx, db, clock, store, services, runner } = await bootHost(t);
  const plan = { ...spec, snapshotId: 'snap_source' };
  const handle = await runner().start('project', plan);
  t.mock.method(ctx.sbxProviders, 'offer', async () => {
    throw new Error('offer unavailable on replay');
  });
  assert.deepEqual(await runner().start('project', plan), handle);
  assert.equal((await ctx.sbxRegistry.list('checks')).length, 1);
  assert.deepEqual(await runner().step('project', plan, handle), handle);
  await ctx.sbxRegistry.transition(handle.sandboxId, { to: 'ready' });
  await db.run(
    `INSERT INTO snapshots
    (id, namespace, name, sandbox_id, state, path, recipe_json, source_offer_json, bytes, files, created_at, updated_at)
    SELECT 'snap_source', namespace, 'source', id, 'ready', '/workspace', '{}', offer_json, 0, 0, created_at, updated_at
    FROM sandboxes WHERE id = $1`,
    [handle.sandboxId],
  );
  assert.equal((await runner().step('project', { ...plan, snapshotId: null }, handle)).ready, true);
  const restoring = await runner().step('project', plan, handle);
  assert.ok(restoring.restoreJobId);
  assert.equal(restoring.ready, false);
  assert.deepEqual(await runner().step('project', plan, handle), restoring);
  assert.deepEqual(await runner().step('project', plan, restoring), restoring);
  await db.run("UPDATE jobs SET state = 'failed' WHERE id = $1", [restoring.restoreJobId]);
  await assert.rejects(runner().step('project', plan, restoring), { code: 'sandbox_unavailable' });
  await db.run("UPDATE jobs SET state = 'succeeded' WHERE id = $1", [restoring.restoreJobId]);
  const ready = await runner().step('project', plan, restoring);
  assert.equal(ready.ready, true);
  const running = await runner().step('project', plan, ready);
  t.mock.method(store, 'downloadUrl', async () => 'https://storage.test/refreshed-signature');
  assert.deepEqual(await runner().step('project', plan, ready), running);
  assert.equal((await ctx.sbxJobs.listJobs({ namespace: 'checks' })).length, 2);
  const job = await ctx.sbxJobs.get({ namespace: 'checks', jobId: running.jobId! });
  assert.ok(job.request.timeout_seconds! > spec.timeoutSeconds);
  assert.equal((await runner().follow('project', running)).state, 'running');
  await db.run(
    "UPDATE jobs SET state = 'succeeded', result_json = $2::jsonb, started_at = $3, finished_at = $3 WHERE id = $1",
    [
      running.jobId!,
      JSON.stringify({ exit: 124, bytes: 3, head64: 'b3V0', tail64: '' }),
      clock.now(),
    ],
  );
  const verdict = await runner().follow('project', running);
  assert.equal(verdict.state, 'timed_out');
  assert.equal(verdict.result?.head, 'out');
  assert.equal(verdict.setup, null);
  assert.equal(verdict.startedAt, clock.now().toJSON());
  const deletion = t.mock.method(services.sbxObjects, 'delete', async () => {
    throw new MervError('sandbox_unavailable', 'retry source deletion', 503);
  });
  await assert.rejects(runner().release('project', running), { code: 'sandbox_unavailable' });
  deletion.mock.restore();
  await runner().release('project', running);
  await runner().release('project', running);
  assert.equal((await ctx.sbxRegistry.get('checks', handle.sandboxId)).state, 'deleting');
  assert.equal((await services.sbxObjects.get('checks', handle.objectId)).state, 'delete_pending');
  await runner().release('project', {
    sandboxId: 'missing',
    jobId: 'missing',
    objectId: 'missing',
  });
});

test('reserved setup exits need a written result to become command verdicts', async (t) => {
  const { ctx, db, runner } = await bootHost(t);
  const handle = await runner().start('project', spec);
  await ctx.sbxRegistry.transition(handle.sandboxId, { to: 'ready' });
  const ready = await runner().step('project', spec, handle);
  const running = await runner().step('project', spec, ready);
  const cases = [
    ...[121, 122, 123, 124, 125].map((exit) => ({
      state: 'failed',
      exit,
      result: null,
      setup: true,
      verdict: 'failed',
    })),
    { state: 'succeeded', exit: 0, result: { exit: 123 }, setup: false, verdict: 'succeeded' },
    { state: 'succeeded', exit: 0, result: { exit: 124 }, setup: false, verdict: 'timed_out' },
    { state: 'timed_out', exit: null, result: null, setup: false, verdict: 'timed_out' },
    { state: 'succeeded', exit: 0, result: { exit: null }, setup: false, verdict: 'succeeded' },
  ];
  for (const row of cases) {
    await db.run(
      'UPDATE jobs SET state = $2, exit_code = $3, result_json = $4::jsonb WHERE id = $1',
      [running.jobId, row.state, row.exit, JSON.stringify(row.result)],
    );
    const verdict = await runner().follow('project', running);
    assert.equal(verdict.state, row.verdict);
    assert.equal(Boolean(verdict.setup), row.setup);
    assert.equal(verdict.result?.exit ?? null, row.result?.exit ?? null);
    if (row.result?.exit == null) assert.equal(verdict.result, null);
  }
});

test('the shell preserves source filenames and distinguishes setup failures from command exits', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-check files-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, 'source'),
    home = join(directory, 'home');
  mkdirSync(source);
  mkdirSync(home);
  writeFileSync(join(source, 'out.log'), 'tracked output');
  writeFileSync(join(source, 'src.tgz'), 'tracked archive');
  const archive = join(directory, 'source.tar.gz');
  const packed = spawnSync('tar', ['-czf', archive, '-C', source, '.'], { encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
  const resultPath = join(directory, 'result.json');
  const command = [
    'test "$PWD" = "$HOME/merv-check"',
    'test "$(cat out.log)" = "tracked output"',
    'test "$(cat src.tgz)" = "tracked archive"',
    "printf 'check output'",
  ].join(' && ');
  const run = (command: string, setup = '') => {
    rmSync(resultPath, { force: true });
    return spawnSync(
      '/bin/sh',
      [
        '-c',
        [
          // Substitute download and GNU utilities while checking the actual archive bytes.
          'curl() { while [ "$1" != "-o" ]; do shift; done; cp "$SOURCE_ARCHIVE" "$2"; }',
          'sha256sum() { read expected file; test "$expected" = "$SOURCE_SHA256" && cmp "$file" "$SOURCE_ARCHIVE"; }',
          'timeout() { shift; "$@"; }',
          setup,
          checkScript(command, 'https://fixture.invalid/source', sha256, 30),
        ].join('\n'),
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          SOURCE_ARCHIVE: archive,
          SOURCE_SHA256: sha256,
          SBX_RESULT_PATH: resultPath,
        },
      },
    );
  };
  const first = run(command);
  assert.equal(first.status, 0, first.stderr);
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.equal(result.exit, 0);
  assert.equal(result.bytes, 12);
  assert.equal(Buffer.from(result.head64, 'base64').toString(), 'check output');
  assert.equal(Buffer.from(result.tail64, 'base64').toString(), 'check output');
  assert.equal(readFileSync(join(home, 'merv-check', 'out.log'), 'utf8'), 'tracked output');
  assert.equal(readFileSync(join(home, 'merv-check', 'src.tgz'), 'utf8'), 'tracked archive');
  for (const exit of [0, 1, 121, 122, 123, 124, 125]) {
    const command = run(`printf output; exit ${exit}`);
    assert.equal(command.status, 0, command.stderr);
    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    assert.equal(result.exit, exit);
    assert.equal(Buffer.from(result.head64, 'base64').toString(), 'output');
  }
  for (const [setup, exit] of [
    ['curl() { return 1; }', 122],
    ['sha256sum() { return 1; }', 123],
    ['tar() { return 1; }', 124],
  ] as const) {
    assert.equal(run('exit 0', setup).status, exit);
    assert.throws(() => readFileSync(resultPath), { code: 'ENOENT' });
  }
});
