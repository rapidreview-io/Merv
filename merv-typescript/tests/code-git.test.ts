import { ServerGit } from '@merv/code/git';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

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

test('timeout, abort, and close promptly end Git command descendants', async (t) => {
  const directory = home(t);
  const script = (name: string) => {
    const path = join(directory, name);
    writeFileSync(
      path,
      `#!/bin/sh\nprintf '%s\\n' "$$" > ${name}.parent\nsleep 30 &\nprintf '%s\\n' "$!" > ${name}.child\nwait\n`,
    );
    chmodSync(path, 0o755);
    return path;
  };
  const waitFor = async (ready: () => boolean) => {
    const deadline = Date.now() + 2_000;
    while (!ready() && Date.now() < deadline) await delay(10);
    assert.ok(ready(), 'the child process did not reach the expected state promptly');
  };
  const stillRunning = (pid: number) => {
    if (process.platform === 'linux') {
      try {
        return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] !== 'Z';
      } catch (error) {
        // procfs can report either error when a process exits during the read.
        if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
        throw error;
      }
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  };
  const promptly = async (operation: Promise<unknown>, code: string) => {
    let timer: ReturnType<typeof setTimeout>;
    try {
      await assert.rejects(
        Promise.race([
          operation,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Git cancellation did not settle promptly')),
              2_000,
            );
          }),
        ]),
        { code },
      );
    } finally {
      clearTimeout(timer!);
    }
  };

  for (const mode of ['timeout', 'abort', 'close'] as const) {
    const git = new ServerGit(directory, script(mode));
    const controller = new AbortController();
    const operation = git.run([], {
      timeoutMs: mode === 'timeout' ? 1_000 : 10_000,
      signal: controller.signal,
    });
    void operation.catch(() => {});
    const parentFile = join(directory, `${mode}.parent`);
    const childFile = join(directory, `${mode}.child`);
    try {
      await waitFor(() =>
        [parentFile, childFile].every(
          (file) => existsSync(file) && /^[1-9]\d*\n$/.test(readFileSync(file, 'utf8')),
        ),
      );
      const parent = Number(readFileSync(parentFile, 'utf8').trim());
      const child = Number(readFileSync(childFile, 'utf8').trim());
      // A busy runner may observe the PID files after the automatic timeout fired.
      // Explicit abort/close still require live processes before cancellation.
      if (mode !== 'timeout') {
        assert.ok(stillRunning(parent));
        assert.ok(stillRunning(child));
      }
      if (mode === 'abort') controller.abort();
      if (mode === 'close') git.close();
      await promptly(
        operation,
        mode === 'timeout'
          ? 'code_git_timeout'
          : mode === 'abort'
            ? 'code_git_aborted'
            : 'code_unavailable',
      );
      await waitFor(() => !stillRunning(parent) && !stillRunning(child));
    } finally {
      controller.abort();
      git.close();
      // Keep the test itself from leaving a sleeper behind if cancellation regresses.
      for (const file of [parentFile, childFile]) {
        if (!existsSync(file)) continue;
        const pid = Number(readFileSync(file, 'utf8').trim());
        if (Number.isSafeInteger(pid) && pid > 0 && stillRunning(pid)) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
      }
    }
  }
});
