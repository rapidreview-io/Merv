import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ServerGit } from '../packages/code/src/git.js';
import { createGitOwner, waitGitOwner } from '../packages/code/src/git-owner.js';

async function directory(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'merv-git-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('a Git ownership FIFO distinguishes live descriptors from exited owners', async (t) => {
  const root = await directory(t);
  const path = join(root, 'owner');
  const owner = await createGitOwner(path);
  try {
    await assert.rejects(waitGitOwner(path, { timeoutMs: 0 }), {
      code: 'code_git_receiver_active',
    });
  } finally {
    owner.close();
  }
  await waitGitOwner(path, { timeoutMs: 0 });
  await waitGitOwner(join(root, 'never-started'), { timeoutMs: 0 });
  const invalid = join(root, 'invalid');
  await writeFile(invalid, '1234');
  await assert.rejects(waitGitOwner(invalid), { code: 'code_git_owner_invalid' });
});

for (const stage of ['pre-receive', 'committed'] as const)
  test(
    `native Git remains fenced after its Node owner dies during ${stage}`,
    { timeout: 20_000 },
    async (t) => {
      const root = await directory(t);
      const repository = join(root, 'repository.git');
      const hooks = join(root, 'hooks');
      await mkdir(hooks);
      const git = new ServerGit(root);
      t.after(() => git.close());
      await git.ok(['init', '--bare', '--quiet', '--template=', repository]);
      const env = { GIT_DIR: repository };
      const tree = (await git.ok(['mktree'], { env, input: '' })).toString().trim();
      const head = (
        await git.ok(['commit-tree', tree, '-m', 'native ownership regression'], {
          env: {
            ...env,
            GIT_AUTHOR_NAME: 'Merv',
            GIT_AUTHOR_EMAIL: 'merv@example.test',
            GIT_COMMITTER_NAME: 'Merv',
            GIT_COMMITTER_EMAIL: 'merv@example.test',
          },
        })
      )
        .toString()
        .trim();
      const pack = await git.ok(['pack-objects', '--stdout', '--revs'], {
        env,
        input: head + '\n',
      });
      const command = `${'0'.repeat(head.length)} ${head} refs/heads/main\0report-status\n`;
      const body = Buffer.concat([
        Buffer.from(
          (Buffer.byteLength(command) + 4).toString(16).padStart(4, '0') + command + '0000',
        ),
        pack,
      ]);
      const ready = join(root, 'ready');
      const release = join(root, 'release');
      const hookName = stage === 'pre-receive' ? stage : 'reference-transaction';
      await writeFile(
        join(hooks, hookName),
        `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
if (${JSON.stringify(stage)} === 'committed' && process.argv[2] !== 'committed') process.exit(0);
const group = Number(cp.execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)], {encoding:'utf8'}).trim());
fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({group}));
const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); process.exit(0); } }, 10);
`,
        { mode: 0o700 },
      );
      const owner = join(root, 'owner');
      const input = join(root, 'request');
      await writeFile(input, body);
      const program = join(root, 'server.mjs');
      await writeFile(
        program,
        `import { ServerGit } from ${JSON.stringify(new URL('../packages/code/src/git.ts', import.meta.url).href)};
import { readFile } from 'node:fs/promises';
const git = new ServerGit(${JSON.stringify(root)});
const result = await git.run(['-c', ${JSON.stringify(`core.hooksPath=${hooks}`)}, 'http-backend'], {
  env: ${JSON.stringify({
    PATH_TRANSLATED: join(repository, 'git-receive-pack'),
    REQUEST_METHOD: 'POST',
    CONTENT_TYPE: 'application/x-git-receive-pack-request',
    CONTENT_LENGTH: String(body.length),
    GIT_HTTP_EXPORT_ALL: '1',
    REMOTE_USER: 'regression',
  })},
  input: await readFile(${JSON.stringify(input)}),
  durableOwner: ${JSON.stringify(owner)},
  timeoutMs: 15000,
});
process.stderr.write(result.stderr + result.stdout.toString());
`,
      );
      let server: ChildProcess | undefined;
      let group: number | undefined;
      let stderr = '';
      try {
        server = spawn(process.execPath, ['--import', 'tsx', program], {
          cwd: new URL('..', import.meta.url),
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        server.stderr!.on('data', (chunk: Buffer) => (stderr += chunk));
        const closed = once(server, 'close');
        const deadline = performance.now() + 10_000;
        while (performance.now() < deadline) {
          const value = await readFile(ready, 'utf8').catch(() => '');
          if (value) {
            group = (JSON.parse(value) as { group: number }).group;
            break;
          }
          assert.equal(server.exitCode, null, stderr);
          await delay(20);
        }
        assert.ok(group, `the native receive did not enter its hook: ${stderr}`);
        server.kill('SIGKILL');
        await closed;
        // The server no longer owns any file descriptor. http-backend and receive-pack
        // still do: a fresh recovery process must neither project refs nor clear fences.
        await assert.rejects(waitGitOwner(owner, { timeoutMs: 50 }), {
          code: 'code_git_receiver_active',
        });
        const before = await git.run(['rev-parse', '--verify', 'refs/heads/main'], { env });
        if (stage === 'pre-receive') assert.notEqual(before.code, 0);
        else assert.equal(before.stdout.toString().trim(), head);
        await writeFile(release, 'continue');
        await waitGitOwner(owner, { timeoutMs: 5_000 });
        assert.equal(
          (await git.ok(['rev-parse', '--verify', 'refs/heads/main'], { env })).toString().trim(),
          head,
        );
        // The absence of the old HTTP parent is a lost acknowledgement, never authority
        // to repeat or undo Git's ref update.
      } finally {
        server?.kill('SIGKILL');
        if (group) {
          try {
            process.kill(-group, 'SIGKILL');
          } catch {
            // The receiver normally finishes after its hook is released.
          }
        }
      }
    },
  );
