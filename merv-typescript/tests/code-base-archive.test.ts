import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomFillSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '@merv/contracts';
import { ServerGit } from '../packages/code/src/git.js';
import { archiveCommit } from '../packages/code-work/src/base-check.js';

function repository(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'merv-base-archive-'));
  const work = join(root, 'work');
  execFileSync('git', ['init', '-q', work]);
  const git = new ServerGit(root);
  t.after(() => {
    git.close();
    rmSync(root, { recursive: true, force: true });
  });
  const run = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: work,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
  const commit = () => {
    run('add', '.');
    run('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'source');
    return run('rev-parse', 'HEAD').toString('utf8').trim();
  };
  return { work, git, run, commit, env: { GIT_DIR: join(work, '.git') } };
}

test('a source archive retains Git bytes and hash, and preserves unrelated failures', async (t) => {
  const r = repository(t);
  writeFileSync(join(r.work, 'source.txt'), 'source\n');
  const commit = r.commit();
  const expected = r.run('archive', '--format=tar.gz', commit);
  const result = await archiveCommit(r.git, r.env, commit);
  assert.deepEqual(result.bytes, expected);
  assert.equal(result.sha256, sha256Hex(expected));
  await assert.rejects(archiveCommit(r.git, r.env, 'missing'), { code: 'code_git_failed' });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    r.git.scoped(abort.signal, () => archiveCommit(r.git, r.env, commit)),
    {
      code: 'code_git_aborted',
    },
  );
});

test('a real oversized source archive reports the permanent size refusal', async (t) => {
  const r = repository(t);
  // Three individually admissible files exceed the 128 MiB archive limit. Reuse one random
  // buffer so the fixture needs only one large Git blob and generates random bytes once.
  const bytes = randomFillSync(Buffer.alloc(43 * 1024 * 1024));
  for (let index = 0; index < 3; index++) writeFileSync(join(r.work, `data-${index}.bin`), bytes);
  await assert.rejects(archiveCommit(r.git, r.env, r.commit()), {
    code: 'code_check_source_too_large',
    status: 413,
  });
});
