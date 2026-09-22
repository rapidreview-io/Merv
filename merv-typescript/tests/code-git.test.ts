import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerGit } from '@merv/code/git';

function home(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-code-git-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('the server runs Git with none of the machine’s or the user’s configuration', async (t) => {
  const directory = home(t);
  const git = new ServerGit(directory);
  assert.match(await git.assertGit(), /^\d+\.\d+\.\d+$/);
  // A configuration a user or an administrator left on the machine is never read.
  writeFileSync(
    join(directory, '.gitconfig'),
    '[user]\n\tname = Leaked\n[core]\n\thooksPath = /x\n',
  );
  const listed = (await git.ok(['config', '--list', '--show-origin'])).toString('utf8');
  assert.deepEqual(
    listed
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t')[0])
      .filter((origin) => origin !== 'command line:'),
    [],
  );
  assert.match(listed, /protocol\.allow=never/);
  assert.match(listed, /core\.hookspath=\/dev\/null/);
  const environment = (
    await git.ok(['-c', 'alias.env=!env', 'env'], { env: { PATH: '/nowhere', HOME: homedir() } })
  ).toString('utf8');
  // Git itself puts its own programs first; nothing of the caller's PATH survives.
  assert.match(environment, /^PATH=(?:[^\n:]*git-core:)?\/usr\/bin:\/bin$/m);
  assert.match(environment, new RegExp(`^HOME=${directory}$`, 'm'));
  assert.match(environment, /^GIT_CONFIG_GLOBAL=\/dev\/null$/m);
  assert.match(environment, /^GIT_TERMINAL_PROMPT=0$/m);

  // No transport works unless the caller names it, and then only that one.
  await git.ok(['init', '--quiet', '--bare', join(directory, 'remote.git')]);
  await git.ok(['init', '--quiet', '--bare', join(directory, 'local.git')]);
  const fetch = ['ls-remote', `file://${join(directory, 'remote.git')}`];
  const env = { GIT_DIR: join(directory, 'local.git') };
  const refused = await git.run(fetch, { env });
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /transport 'file' not allowed/);
  assert.equal((await git.run(fetch, { env, protocol: 'file' })).code, 0);
  assert.notEqual((await git.run(fetch, { env, protocol: 'https' })).code, 0);
});

test('a failing command is a result, a missing or slow one is a refusal, and old Git is unsupported', async (t) => {
  const directory = home(t);
  const git = new ServerGit(directory);
  const failed = await git.run(['rev-parse', '--verify', 'refs/heads/none'], {
    env: { GIT_DIR: join(directory, 'absent.git') },
  });
  assert.equal(failed.code, 128);
  assert.match(failed.stderr, /not a git repository/);
  await assert.rejects(git.ok(['rev-parse', '--verify', 'HEAD']), { code: 'code_git_failed' });
  assert.equal(
    (await git.ok(['hash-object', '--stdin'], { input: 'hello\n' })).toString().trim(),
    'ce013625030ba8dba906f756967f9e9ca394464a',
  );
  const chunks: Buffer[] = [];
  const streamed = await git.run(['hash-object', '--stdin'], {
    input: 'hello\n',
    output: (chunk) => chunks.push(chunk),
  });
  assert.equal(streamed.stdout.length, 0);
  assert.match(Buffer.concat(chunks).toString(), /^ce013625/);

  const script = (name: string, body: string) => {
    const path = join(directory, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  await assert.rejects(
    new ServerGit(directory, script('old', 'echo git version 2.30.2')).assertGit(),
    {
      code: 'code_git_unsupported',
      message: /needs Git 2\.38 or newer.*found git version 2\.30\.2/,
    },
  );
  assert.equal(
    await new ServerGit(directory, script('new', 'echo git version 3.1')).assertGit(),
    '3.1.0',
  );
  await assert.rejects(new ServerGit(directory, join(directory, 'absent')).assertGit(), {
    code: 'code_git_unsupported',
  });
  await assert.rejects(
    new ServerGit(directory, script('slow', 'sleep 30')).run([], { timeoutMs: 100 }),
    { code: 'code_git_timeout' },
  );
  const stop = new AbortController();
  const stopped = new ServerGit(directory, script('stopped', 'sleep 30')).run([], {
    signal: stop.signal,
  });
  stop.abort();
  await assert.rejects(stopped, { code: 'code_git_aborted' });

  // A child somebody else kills is a refusal, never an exit code Git did not report.
  await assert.rejects(
    new ServerGit(directory, script('killed', 'kill -9 $$')).run(['merge-tree']),
    { code: 'code_git_failed', message: /ended by SIGKILL/ },
  );

  // Unloading ends what runs and refuses what is asked next.
  const closing = new ServerGit(directory, script('running', 'sleep 30'));
  const running = closing.run([]);
  closing.close();
  await assert.rejects(running, { code: 'code_unavailable' });
  await assert.rejects(closing.run(['--version']), { code: 'code_unavailable' });
});
