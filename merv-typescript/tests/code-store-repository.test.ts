import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeRepositories } from '@merv/code/store/repository';
import { git } from './fixtures/code-store.js';

const limits = { quotaBytes: 1024 * 1024 * 1024, reservedFreeBytes: 1 };
function root(t: TestContext, ...below: string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-cr-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, ...below, 'code');
}
async function opened(t: TestContext, path: string, config = limits) {
  const repositories = new CodeRepositories({ root: path, ...config });
  t.after(() => repositories.close(1000));
  await repositories.open();
  return repositories;
}

test('a project repository is created bare from an empty template with the configuration Code wrote', async (t) => {
  const repositories = await opened(t, root(t));
  const paths = repositories.paths('project-one');
  assert.match(paths.directory, /\/code\/[0-9a-f]{32}$/);
  assert.notEqual(paths.directory, repositories.paths('project-two').directory);
  assert.equal(await repositories.exists('project-one'), false);
  await repositories.ensure('project-one', 'repository-one', 'sha1');
  await repositories.ensure('project-one', 'repository-one', 'sha1');
  assert.deepEqual(JSON.parse(readFileSync(paths.marker, 'utf8')), {
    format: 1,
    projectId: 'project-one',
    repositoryId: 'repository-one',
  });
  const config = git(paths.repository, ['config', '--file', 'config', '--list']).split('\n');
  for (const entry of [
    'core.bare=true',
    'core.fsync=all',
    'core.fsyncmethod=fsync',
    'gc.auto=0',
    'transfer.fsckobjects=true',
  ])
    assert.ok(config.includes(entry), entry);
  assert.equal(
    config.some((entry) => /^(remote|include|url|alias|credential)/.test(entry)),
    false,
  );
  assert.equal(existsSync(join(paths.repository, 'hooks')), false);
  assert.equal(existsSync(join(paths.repository, 'objects', 'info', 'alternates')), false);
  assert.deepEqual(readdirSync(paths.directory).sort(), ['merv-project.json', 'repository.git']);
  assert.equal(await repositories.objectFormat('project-one'), 'sha1');
  await assert.rejects(repositories.ensure('project-one', 'repository-one', 'sha256'), {
    code: 'code_bundle_format',
  });
  await repositories.ensure('project-two', 'repository-two', 'sha256');
  assert.equal(await repositories.objectFormat('project-two'), 'sha256');
  // Only a repository nothing was admitted into is ever discarded, and only when asked.
  await repositories.discard('project-two');
  await repositories.ensure('project-two', 'repository-two', 'sha1');
  assert.equal(await repositories.objectFormat('project-two'), 'sha1');
});

test('a directory Code did not make, or one that was changed beneath it, is refused', async (t) => {
  const path = root(t);
  const first = await opened(t, path);
  await first.ensure('project', 'repository', 'sha1');
  const paths = first.paths('project');
  await first.close(1000);
  const reopened = async () => {
    const repositories = new CodeRepositories({ root: path, ...limits });
    await repositories.open();
    try {
      await repositories.validate('project', 'repository');
    } finally {
      await repositories.close(1000);
    }
  };
  await reopened();

  const config = readFileSync(join(paths.repository, 'config'), 'utf8');
  for (const added of [
    '[remote "origin"]\n\turl = https://example.test/x.git\n',
    '[include]\n\tpath = /tmp/other\n',
    '[core]\n\tfsmonitor = /tmp/run-me\n',
    '[core]\n\tsshCommand = /tmp/run-me\n',
  ]) {
    writeFileSync(join(paths.repository, 'config'), config + added);
    await assert.rejects(reopened(), { code: 'code_repository_unsafe' }, added);
  }
  writeFileSync(join(paths.repository, 'config'), config.replace('fsync = all', 'fsync = none'));
  await assert.rejects(reopened(), { code: 'code_repository_unsafe', message: /core\.fsync/ });
  writeFileSync(join(paths.repository, 'config'), config);

  writeFileSync(join(paths.repository, 'objects', 'info', 'alternates'), '/tmp/other/objects\n');
  await assert.rejects(reopened(), { code: 'code_repository_unsafe', message: /alternates/ });
  rmSync(join(paths.repository, 'objects', 'info', 'alternates'));

  mkdirSync(join(paths.repository, 'hooks'));
  writeFileSync(join(paths.repository, 'hooks', 'reference-transaction'), '#!/bin/sh\n');
  await assert.rejects(reopened(), { code: 'code_repository_unsafe', message: /hooks/ });
  rmSync(join(paths.repository, 'hooks'), { recursive: true });

  const marker = readFileSync(paths.marker, 'utf8');
  writeFileSync(paths.marker, marker.replace('"repository"', '"another"'));
  await assert.rejects(reopened(), { code: 'code_repository_foreign' });
  rmSync(paths.marker);
  await assert.rejects(reopened(), { code: 'code_repository_foreign' });
  writeFileSync(paths.marker, marker);
  await reopened();
});

test('one process writes to a root at a time, and the lock of a dead process is taken over', async (t) => {
  for (const path of [root(t), root(t, 'a'.repeat(60), 'b'.repeat(60))]) {
    const first = await opened(t, path);
    await assert.rejects(new CodeRepositories({ root: path, ...limits }).open(), {
      code: 'code_repository_locked',
    });
    await first.close(1000);
    const second = await opened(t, path);
    await second.close(1000);
    assert.equal(existsSync(join(path, 'writer.sock')), false);
  }

  // A process that died holding the lock leaves its socket behind; nothing answers on it.
  const path = root(t);
  mkdirSync(path, { recursive: true });
  const holder = spawn(process.execPath, [
    '-e',
    `require('node:net').createServer().listen(${JSON.stringify(join(path, 'writer.sock'))}, () => console.log('bound')); setInterval(() => {}, 1000)`,
  ]);
  await once(holder.stdout, 'data');
  await assert.rejects(new CodeRepositories({ root: path, ...limits }).open(), {
    code: 'code_repository_locked',
  });
  holder.kill('SIGKILL');
  await once(holder, 'exit');
  assert.equal(existsSync(join(path, 'writer.sock')), true);
  await opened(t, path);
});

test('work on one project runs in turn, transfers are bounded, and room is checked against floor and quota', async (t) => {
  const repositories = await opened(t, root(t), { quotaBytes: 5000, reservedFreeBytes: 1 });
  const order: string[] = [];
  const job = (projectId: string, name: string, ms: number, fail = false) =>
    repositories.run(projectId, async () => {
      order.push(`start ${name}`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(`end ${name}`);
      if (fail) throw new Error(name);
    });
  await Promise.allSettled([job('p', 'one', 30, true), job('p', 'two', 5), job('q', 'other', 1)]);
  assert.deepEqual(
    order.filter((entry) => !entry.includes('other')),
    ['start one', 'end one', 'start two', 'end two'],
  );
  assert.ok(order.indexOf('end other') < order.indexOf('end one'));

  let running = 0,
    most = 0;
  await Promise.all(
    Array.from({ length: 6 }, () =>
      repositories.transfer(async () => {
        most = Math.max(most, ++running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running--;
      }),
    ),
  );
  assert.equal(most, 2);

  await repositories.ensure('p', 'r', 'sha1');
  const used = await repositories.usage('p');
  assert.ok(used > 0 && used < 5000);
  await repositories.assertRoom('p', 5000 - used);
  await assert.rejects(repositories.assertRoom('p', 5000 - used + 1), {
    code: 'code_store_full',
    status: 507,
  });
  // Held bundles, exports and quarantine count against the same quota as the objects.
  mkdirSync(repositories.paths('p').held);
  writeFileSync(join(repositories.paths('p').held, 'x.bundle'), Buffer.alloc(4000));
  await assert.rejects(repositories.assertRoom('p', 5000 - used), { code: 'code_store_full' });
  await repositories.close(1000);
  const starved = await opened(t, repositories.config.root, {
    quotaBytes: 5000,
    reservedFreeBytes: Number.MAX_SAFE_INTEGER,
  });
  await assert.rejects(starved.assertRoom('p', 0), { code: 'code_store_full', status: 507 });
});

test('the sweep removes what no operation needs and never a held bundle, a ref or a pack', async (t) => {
  const repositories = await opened(t, root(t));
  await repositories.ensure('p', 'r', 'sha1');
  const paths = repositories.paths('p');
  const env = paths.repository;
  const blob = git(env, ['hash-object', '-w', '--stdin'], 'kept\n');
  const tree = git(env, ['mktree'], `100644 blob ${blob}\tkept.txt\n`);
  const commit = git(env, ['commit-tree', tree, '-m', 'kept']);
  for (const ref of [
    'refs/merv/imports/cop_a',
    'refs/merv/receipts/cop_b',
    'refs/merv/work/u',
    'refs/merv/accepted/u',
    'refs/merv/exports/old',
    'refs/merv/exports/fresh',
  ])
    git(env, ['update-ref', ref, commit]);
  git(env, ['repack', '-a', '-d', '-q']);
  const packs = readdirSync(join(paths.repository, 'objects', 'pack')).sort();
  assert.equal(packs.length >= 2, true);

  const hour = 3600_000;
  const aged = (path: string, age: number) => {
    const at = new Date(Date.now() - age);
    utimesSync(path, at, at);
  };
  const quarantine = (operationId: string, age: number) => {
    mkdirSync(join(paths.quarantine, operationId, 'objects'), { recursive: true });
    writeFileSync(join(paths.quarantine, operationId, 'bundle'), 'bytes');
    aged(join(paths.quarantine, operationId), age);
  };
  quarantine('cop_finished', 0);
  quarantine('cop_open', 3 * hour);
  quarantine('cop_unknown_old', 2 * hour);
  quarantine('cop_unknown_new', 0);
  mkdirSync(paths.held);
  writeFileSync(join(paths.held, 'cop_refused.bundle'), 'held');
  aged(join(paths.held, 'cop_refused.bundle'), 1000 * hour);
  mkdirSync(paths.exports);
  for (const [name, age] of [
    ['old', 16 * 60_000],
    ['fresh', 60_000],
  ] as const) {
    writeFileSync(join(paths.exports, `${name}.bundle`), 'export');
    aged(join(paths.exports, `${name}.bundle`), age);
  }
  for (const [name, age] of [
    ['tmp_pack_dead', 2 * hour],
    ['tmp_pack_live', 0],
  ] as const) {
    writeFileSync(join(paths.repository, 'objects', 'pack', name), 'partial');
    aged(join(paths.repository, 'objects', 'pack', name), age);
  }

  await repositories.sweep(async (operationId) =>
    operationId === 'cop_finished' ? true : operationId === 'cop_open' ? false : undefined,
  );
  assert.deepEqual(readdirSync(paths.quarantine).sort(), ['cop_open', 'cop_unknown_new']);
  assert.deepEqual(readdirSync(paths.held), ['cop_refused.bundle']);
  assert.deepEqual(readdirSync(paths.exports), ['fresh.bundle']);
  assert.deepEqual(
    readdirSync(join(paths.repository, 'objects', 'pack')).sort(),
    [...packs, 'tmp_pack_live'].sort(),
  );
  assert.deepEqual(git(env, ['for-each-ref', '--format=%(refname)']).split('\n'), [
    'refs/merv/accepted/u',
    'refs/merv/exports/fresh',
    'refs/merv/imports/cop_a',
    'refs/merv/receipts/cop_b',
    'refs/merv/work/u',
  ]);
  assert.equal(git(env, ['cat-file', '-t', commit]), 'commit');
});

test('unloading waits for running work, and ends Git children only when the deadline passes', async (t) => {
  const patient = await opened(t, root(t));
  let finished = false;
  void patient.run('p', async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    finished = true;
  });
  assert.equal(await patient.close(5000), true);
  assert.equal(finished, true);
  await assert.rejects(
    patient.run('p', async () => {}),
    { code: 'code_unavailable' },
  );

  const path = root(t);
  const hurried = await opened(t, path);
  const stuck = hurried.run('p', async () => {
    // A child that would never end by itself: it waits on input nobody closes.
    await hurried.git.run(['hash-object', '--stdin'], {
      input: new (await import('node:stream')).PassThrough(),
      timeoutMs: 60_000,
    });
  });
  const outcome = assert.rejects(stuck, { code: 'code_unavailable' });
  assert.equal(await hurried.close(100), false);
  await outcome;
  // The lock is released either way, so the next start can replay what was interrupted.
  await (await opened(t, path)).close(1000);
});
