import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerGit } from '../packages/code/src/git.js';
import { mergeBases } from '../packages/code/src/base-merge.js';

/** A bare repository holding main and three branches off it: a and c touch one file, b another. */
function repository(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'merv-merge-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
  const commit = (branch: string, file: string, text: string) => {
    git('checkout', '-q', '-B', branch, 'main');
    writeFileSync(join(work, file), text);
    git('add', '.');
    git('commit', '-q', '-m', branch);
    return git('rev-parse', 'HEAD');
  };
  writeFileSync(join(work, 'f.txt'), 'base\n');
  writeFileSync(join(work, 'g.txt'), 'keep\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const main = git('rev-parse', 'HEAD');
  const a = commit('a', 'f.txt', 'base\nA\n');
  const b = commit('b', 'g.txt', 'keep\nB\n');
  const c = commit('c', 'f.txt', 'base\nC\n');
  const bare = join(root, 'bare.git');
  execFileSync('git', ['clone', '-q', '--bare', work, bare]);
  return { env: { GIT_DIR: bare }, main, a, b, c, bare, home: mkdtempSync(join(root, 'home-')) };
}

test('two histories that touch different files merge into one commit with exactly two parents', async (t) => {
  const r = repository(t);
  const git = new ServerGit(r.home);
  t.after(() => git.close());
  const result = await mergeBases(git, r.env, r.a, r.b, 'ab');
  assert.equal(result.outcome, 'merged');
  if (result.outcome !== 'merged') return;
  const parents = execFileSync(
    'git',
    ['--git-dir', r.bare, 'rev-list', '--parents', '-n', '1', result.commit],
    {
      encoding: 'utf8',
    },
  )
    .trim()
    .split(' ')
    .slice(1);
  assert.deepEqual(parents, [r.a, r.b]);
  // The same merge made again is the same commit: a crash before the record costs nothing.
  assert.deepEqual(await mergeBases(git, r.env, r.a, r.b, 'ab'), result);
});

test('a conflict is an answer that names its paths and keeps what Git said', async (t) => {
  const r = repository(t);
  const git = new ServerGit(r.home);
  t.after(() => git.close());
  const result = await mergeBases(git, r.env, r.a, r.c, 'ac');
  assert.equal(result.outcome, 'conflict');
  if (result.outcome !== 'conflict') return;
  assert.deepEqual(result.paths, ['f.txt']);
  assert.match(result.messages, /CONFLICT \(content\)/);
});

test('a history that already holds the other is the base as it stands', async (t) => {
  const r = repository(t);
  const git = new ServerGit(r.home);
  t.after(() => git.close());
  assert.deepEqual(await mergeBases(git, r.env, r.main, r.a, 'x'), {
    outcome: 'contained',
    commit: r.a,
  });
  assert.deepEqual(await mergeBases(git, r.env, r.a, r.main, 'x'), {
    outcome: 'contained',
    commit: r.a,
  });
  assert.deepEqual(await mergeBases(git, r.env, r.a, r.a, 'x'), {
    outcome: 'contained',
    commit: r.a,
  });
});
