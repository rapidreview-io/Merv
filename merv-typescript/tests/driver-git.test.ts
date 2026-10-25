import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DriverGit, WorkspaceError } from '../packages/code/src/driver/git.js';

function driver(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'merv-driver-git-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, git: new DriverGit(home) };
}

function alive(pid: number): boolean {
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
    return !!state.trim() && !state.trim().startsWith('Z');
  } catch {
    return false;
  }
}

test('driver preserves successful Git output and both input forms', async (t) => {
  const { home, git } = driver(t);
  const content = 'Git input with Unicode: café\n';
  const path = join(home, 'input');
  writeFileSync(path, content);
  const inline = await git.run(['hash-object', '--stdin'], { stdin: content });
  const streamed = await git.run(['hash-object', '--stdin'], { stdinFile: path });
  assert.equal(inline.code, 0);
  assert.equal(inline.timedOut, false);
  assert.match(inline.stdout, /^[a-f0-9]{40}\n$/);
  assert.deepEqual(streamed, inline);
});

test(
  'driver timeout terminates Git descendants, including a helper ignoring TERM',
  {
    skip: process.platform === 'win32',
  },
  async (t) => {
    const { git } = driver(t);
    const started = performance.now();
    const result = await git.run(
      ['-c', 'alias.pause=!sh -c \'trap "" TERM; sleep 30 & echo $!; wait\'', 'pause'],
      { timeoutMs: 300 },
    );
    assert.ok(performance.now() - started < 5000, 'timeout does not wait for orphan helpers');
    const pid = Number(result.stdout.trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 1, 'helper started before the deadline');
    t.after(() => {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    });
    assert.equal(result.timedOut, true);
    assert.notEqual(result.code, 0);
    for (let attempt = 0; attempt < 20 && alive(pid); attempt++) await delay(20);
    assert.equal(alive(pid), false, 'no live Git helper survives the timeout');
  },
);

test('an input-file failure is a Git failure, not a timeout', async (t) => {
  const { home, git } = driver(t);
  const result = await git.run(['hash-object', '--stdin'], { stdinFile: join(home, 'missing') });
  assert.equal(result.timedOut, false);
  assert.notEqual(result.code, 0);
});

test('failure detail identifies the command behind Git global options', async (t) => {
  const { home, git } = driver(t);
  await assert.rejects(git.ok(['--git-dir', home, '-c', 'gc.auto=0', 'fetch']), (error) => {
    assert.ok(error instanceof WorkspaceError);
    assert.equal(error.code, 'workspace_git_failed');
    assert.match(error.detail!, /^git fetch:/);
    return true;
  });
});
