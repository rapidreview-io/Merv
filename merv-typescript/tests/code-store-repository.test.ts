import { CodeRepositories } from '@merv/code/store/repository';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

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
