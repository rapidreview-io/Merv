/** Local integration proof, run with node --import tsx --test deploy/recovery-journal-fixture.mjs.
 * Only connection-local fixture schemas on the explicitly allowed local PostgreSQL are touched.
 * Sessions are played by the existing writer fixture; Git admission/journals/State are real.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writerFixture } from '../tests/fixtures/code-writers.ts';
import { faultAt, gitSource } from '../tests/fixtures/code-store.ts';
import { boundProject } from '../tests/fixtures/code-binding.ts';

const database = new URL(process.env.MERV_TEST_POSTGRES_URL);
const hostname = database.hostname.replace(/^\[|\]$/g, '');
const port = database.port || '5432';
const username = decodeURIComponent(database.username);
assert.ok(
  ['127.0.0.1', 'localhost', '::1'].includes(hostname),
  'fixture must use local PostgreSQL',
);
const pg = ['-h', hostname, '-p', port, '-U', username];
const pgEnv = {
  ...process.env,
  ...(database.password ? { PGPASSWORD: decodeURIComponent(database.password) } : {}),
};
const run = (program, args, input) =>
  execFileSync(program, args, {
    input,
    env: pgEnv,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
const python = `import importlib.util,json,sys\nfrom pathlib import Path\ns=importlib.util.spec_from_file_location('snapshot',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nr=m.Recovery(json.loads(Path(sys.argv[2]).read_text()))\nprint(json.dumps(r.inventory(r.root),sort_keys=True))\n`;

for (const point of [
  'after_admitting',
  'after_objects_durable',
  'after_ref',
  'after_refs_applied',
]) {
  test(`offline DB/Git restore preserves ${point} and accepts next checkpoint`, async (t) => {
    const f = await writerFixture(t);
    assert.match(f.schema, /^t_[a-z0-9_]+$/);
    const codeRoot = dirname(f.paths.directory);
    const staging = join(f.directory, 'proof');
    mkdirSync(staging, { mode: 0o700 });
    // A valid bound-but-never-hosted project is not a missing hosted repository.
    await boundProject(f.state, 'bound-never-hosted', 'b'.repeat(40));
    await f.code.configureRepository(f.admin, {
      denyGlobs: ['blocked/**'],
      secretExemptGlobs: [],
      check: null,
      requestId: 'deny-fixture',
    });
    const bad = gitSource(t, 'sha1', f.source.repository);
    const refusedTip = bad.commit({ 'blocked/held.txt': 'retained rejection evidence\n' });
    const rejected = await f.deliver(bad.bundle(refusedTip), undefined, 'held-bundle');
    assert.equal(rejected.status, 'failed');
    const held = join(f.paths.held, `${rejected.id}.bundle`);
    const heldBytes = readFileSync(held);
    await f.lease('restore-session');
    await f.event('session.workspace_attached', 'restore-session');
    // Initial no-op records DB head but legitimately creates no work ref.
    assert.equal(
      (await f.begin('checkpoint', 'restore-session', 1, f.root, null)).status,
      'completed',
    );
    const target = f.source.commit({ 'checkpoint.txt': 'captured before maintenance\n' });
    const bundle = f.source.bundle(target, [f.root]);
    await f.open({ fault: faultAt(point) });
    const op = await f.begin('checkpoint', 'restore-session', 1, f.root, bundle);
    await assert.rejects(f.send(op, bundle), new RegExp(`process ended ${point}`));
    const phase = (await f.operationRow(op.id)).phase;
    assert.equal(phase, point === 'after_ref' ? 'objects_durable' : point.slice(6));
    await f.code.close();
    const config = {
      schema: f.schema,
      deployment: 'local-fixture',
      code_root: codeRoot,
      state_dir: join(staging, 'state'),
      staging_dir: join(staging, 'stage'),
      store: { directory: join(staging, 'store') },
      database: {
        name: database.pathname.slice(1),
        user: username,
        args: ['-h', hostname, '-p', port],
      },
    };
    const configPath = join(staging, 'config.json');
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const inventory = () =>
      JSON.parse(
        run('python3', ['-c', python, resolve('deploy/recovery-snapshot.py'), configPath]),
      );
    const before = inventory();
    assert.equal(before.projects.find((p) => p.project === 'bound-never-hosted').hosted, false);
    const dump = join(staging, 'database.dump');
    const archive = join(staging, 'code.tar');
    run('pg_dump', [
      ...pg,
      '-d',
      database.pathname.slice(1),
      '--format=custom',
      '--schema',
      f.schema,
      '--file',
      dump,
    ]);
    run('tar', ['-cf', archive, '-C', codeRoot, '.']);
    // This schema belongs only to this test, and Code is closed. Restore to empty DB/Git
    // destinations so the original working data cannot mask missing snapshot contents.
    run('psql', [
      ...pg,
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-d',
      database.pathname.slice(1),
      '-c',
      `DROP SCHEMA "${f.schema}" CASCADE`,
    ]);
    rmSync(codeRoot, { recursive: true });
    mkdirSync(codeRoot, { mode: 0o700 });
    run('pg_restore', [
      ...pg,
      '-d',
      database.pathname.slice(1),
      '--exit-on-error',
      '--no-owner',
      dump,
    ]);
    run('tar', ['-xf', archive, '-C', codeRoot]);
    assert.deepEqual(inventory(), before);
    assert.deepEqual(readFileSync(held), heldBytes);
    await f.open();
    let replay = await f.begin('checkpoint', 'restore-session', 1, f.root, bundle, 'command-2');
    if (replay.status === 'prepared') replay = await f.send(replay, bundle);
    assert.equal(replay.id, op.id);
    assert.equal(replay.status, 'completed');
    assert.equal((await f.unit()).canonicalHead, target);
    const next = f.source.commit({ 'next.txt': 'accepted after real restore\n' });
    const checkpoint = await f.upload(
      'checkpoint',
      'restore-session',
      1,
      target,
      f.source.bundle(next, [target]),
    );
    assert.equal(checkpoint.status, 'completed');
    assert.equal((await f.unit()).canonicalHead, next);
    await f.code.close();
    inventory();
  });
}
