import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteState, PostgresState } from '@merv/state';
import { CodeRepositories } from '@merv/code/store/repository';
import { CodeBaseService } from '../packages/code/src/bases.js';
import { baseKey } from '../packages/code/src/base-plan.js';
import { backends, optional, type Backend } from './fixtures/code-store.js';

const PROJECT = 'project-bases';

/** A project repository holding four accepted commits off one main: a and c collide, b and d do not. */
async function fixture(t: TestContext, backend: Backend, enabled = true) {
  const root = mkdtempSync(join(tmpdir(), 'merv-bases-'));
  const state =
    backend === 'sqlite'
      ? new SqliteState(join(root, 'state.sqlite'))
      : await PostgresState.open({
          connectionString: process.env.MERV_TEST_POSTGRES_URL!,
          schema: `code_bases_${randomUUID().replaceAll('-', '')}`,
        });
  const repositories = new CodeRepositories({
    root: join(root, 'code'),
    quotaBytes: 1024 * 1024 * 1024,
    reservedFreeBytes: 1,
  });
  await repositories.open();
  await repositories.ensure(PROJECT, 'repository-bases', 'sha1');
  const bare = repositories.paths(PROJECT).repository;
  const work = join(root, 'work');
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: work,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  git('config', 'user.email', 'test@localhost');
  git('config', 'user.name', 'Test');
  for (const file of ['f', 'g', 'h']) writeFileSync(join(work, `${file}.txt`), 'base\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const commit = (branch: string, file: string, text: string) => {
    git('checkout', '-q', '-B', branch, 'main');
    writeFileSync(join(work, file), text);
    git('commit', '-q', '-am', branch);
    git('push', '-q', bare, `${branch}:refs/heads/${branch}`);
    return git('rev-parse', 'HEAD');
  };
  const commits = {
    a: commit('a', 'f.txt', 'base\nA\n'),
    b: commit('b', 'g.txt', 'base\nB\n'),
    c: commit('c', 'f.txt', 'base\nC\n'),
    d: commit('d', 'h.txt', 'base\nD\n'),
  };
  let changes = 0;
  const bases = new CodeBaseService(
    state,
    repositories,
    { changed: async () => void (changes += 1) },
    enabled,
  );
  await bases.initialize();
  t.after(async () => {
    await bases.close();
    await repositories.close(1000);
    await state.close();
    rmSync(root, { recursive: true, force: true });
  });
  const parents = (oid: string) =>
    execFileSync('git', ['--git-dir', bare, 'rev-list', '--parents', '-n', '1', oid], {
      encoding: 'utf8',
    })
      .trim()
      .split(' ')
      .slice(1);
  const rows = async () =>
    await state.read(
      async (sql) =>
        await sql.all<{ base_key: string; state: string }>(
          'SELECT base_key,state FROM code_bases WHERE project_id=? ORDER BY base_key',
          PROJECT,
        ),
    );
  return { state, bases, commits, parents, rows, bare, changed: () => changes };
}

for (const backend of backends)
  test(
    `[${backend}] three units waiting on the same two commits are one record, one merge and one commit`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const { a, b } = f.commits;
      // Each waiter asks in its own transaction, in whatever order it knows the commits.
      const asked = [];
      for (const set of [
        [a, b],
        [b, a],
        [a, b, a],
      ])
        asked.push(await f.state.transaction(async (tx) => await f.bases.ensure(tx, PROJECT, set)));
      assert.deepEqual(new Set(asked.map((record) => record.key)), new Set([baseKey([a, b])]));
      assert.equal((await f.rows()).length, 1);
      assert.equal(asked[0]!.state, 'queued');
      await Promise.all([f.bases.work(PROJECT), f.bases.work(PROJECT), f.bases.work(PROJECT)]);
      const done = (await f.state.read(async (sql) => await f.bases.find(sql, PROJECT, [a, b])))!;
      assert.equal(done.state, 'resolved');
      assert.equal(done.result!.method, 'auto');
      assert.deepEqual(f.parents(done.result!.commit).sort(), [a, b].sort());
      assert.equal(done.attempts, 1, 'the merge ran once');
      assert.equal(f.changed(), 1, 'and whoever waits is told once');
    },
  );

for (const backend of backends)
  test(
    `[${backend}] {A,B} then {A,B,D}: the reconciled pair is reused, and only D is merged into it`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const { a, b, d } = f.commits;
      await f.state.transaction(async (tx) => await f.bases.ensure(tx, PROJECT, [a, b]));
      await f.bases.work(PROJECT);
      const pair = (await f.state.read(async (sql) => await f.bases.find(sql, PROJECT, [a, b])))!;
      const triple = await f.state.transaction(
        async (tx) => await f.bases.ensure(tx, PROJECT, [a, b, d]),
      );
      assert.deepEqual([triple.left, triple.right].sort(), [pair.key, baseKey([d])].sort());
      assert.equal((await f.rows()).length, 2, 'no second record for the pair');
      await f.bases.work(PROJECT);
      const made = (await f.state.read(
        async (sql) => await f.bases.find(sql, PROJECT, [a, b, d]),
      ))!;
      assert.equal(made.state, 'resolved');
      assert.deepEqual(f.parents(made.result!.commit).sort(), [pair.result!.commit, d].sort());
    },
  );

for (const backend of backends)
  test(
    `[${backend}] a larger set asked first writes every union on the way, and a later waiter on the pair finds it`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const { a, b, d } = f.commits;
      await f.state.transaction(async (tx) => await f.bases.ensure(tx, PROJECT, [a, b, d]));
      const written = await f.rows();
      assert.deepEqual(written.map((row) => row.state).sort(), ['queued', 'waiting_inputs']);
      await f.bases.work(PROJECT);
      assert.deepEqual(
        (await f.rows()).map((row) => row.state),
        ['resolved', 'resolved'],
      );
      const pairKey = written.find((row) => row.state === 'queued')!.base_key;
      const pair = await f.state.read(async (sql) => {
        for (const set of [
          [a, b],
          [a, d],
          [b, d],
        ])
          if (baseKey(set) === pairKey) return await f.bases.find(sql, PROJECT, set);
        return null;
      });
      assert.equal(pair?.state, 'resolved');
    },
  );

for (const backend of backends)
  test(
    `[${backend}] a conflict is recorded once with its paths, waits for resolution, and holds what is built on it`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const { a, c, d } = f.commits;
      await f.state.transaction(async (tx) => await f.bases.ensure(tx, PROJECT, [a, c]));
      await f.bases.work(PROJECT);
      const conflicted = (await f.state.read(
        async (sql) => await f.bases.find(sql, PROJECT, [a, c]),
      ))!;
      assert.equal(conflicted.state, 'awaiting_resolution');
      assert.deepEqual(conflicted.conflict!.paths, ['f.txt']);
      assert.equal(conflicted.result, null);
      // The automatic merge never restarts for that key, and a superset waits behind it
      // rather than being planned round it.
      await f.bases.work(PROJECT);
      assert.equal(
        (await f.state.read(async (sql) => await f.bases.find(sql, PROJECT, [a, c])))!.attempts,
        1,
      );
      const above = await f.state.transaction(
        async (tx) => await f.bases.ensure(tx, PROJECT, [a, c, d]),
      );
      assert.ok([above.left, above.right].includes(conflicted.key));
      assert.equal(above.state, 'waiting_inputs');
      await f.bases.work(PROJECT);
      assert.equal(
        (await f.state.read(async (sql) => await f.bases.find(sql, PROJECT, [a, c, d])))!.state,
        'waiting_inputs',
      );
    },
  );

test('a plan and a result are written once, and no record is ever deleted', async (t) => {
  const f = await fixture(t, 'sqlite');
  const { a, b } = f.commits;
  await f.state.transaction(async (tx) => await f.bases.ensure(tx, PROJECT, [a, b]));
  await f.bases.work(PROJECT);
  for (const sql of [
    "UPDATE code_bases SET left_key='x'",
    `UPDATE code_bases SET result_json='{"commit":"x"}'`,
    'DELETE FROM code_bases',
  ])
    await assert.rejects(f.state.transaction(async (tx) => await tx.run(sql)));
});

test('switched off, nothing is merged however much is queued', async (t) => {
  const f = await fixture(t, 'sqlite', false);
  const { a, b } = f.commits;
  await f.state.transaction(async (tx) => await f.bases.ensure(tx, PROJECT, [a, b]));
  await f.bases.work(PROJECT);
  assert.deepEqual(
    (await f.rows()).map((row) => row.state),
    ['queued'],
  );
});
