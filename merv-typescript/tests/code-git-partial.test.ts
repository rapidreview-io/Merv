import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { CodeGitRemote } from '@merv/code/store/http';
import { unitRef, workBranch } from '@merv/code/store/refs';
import { MervError } from '@merv/contracts';
import { writerFixture } from './fixtures/code-writers.js';

const exec = promisify(execFile);

async function fixture(t: TestContext) {
  const f = await writerFixture(t);
  const remote = new CodeGitRemote(f.state, f.scope, f.core.repositories, f.core.writers);
  await remote.initialize();
  await f.lease('writer');
  const access = await remote.issue(f.admin, {
    sessionId: 'writer',
    runnerId: 'runner-1',
    hostRef: 'launch-writer',
    unitId: f.unitId,
    generation: (await f.unit()).generation,
    leaseId: 'writer',
    mode: 'write',
  });
  const server = createServer((req, res) => {
    void remote.handle(req, res, new URL(req.url!, 'http://localhost')).catch((error) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(error instanceof MervError ? error.status : 500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}${access.url}`;
  const git = (args: string[]) =>
    exec('git', args, {
      cwd: f.source.repository,
      env: {
        PATH: process.env.PATH,
        HOME: f.directory,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `http.${url}.extraHeader`,
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`merv:${access.token}`).toString('base64')}`,
        GIT_TERMINAL_PROMPT: '0',
      },
    });
  const branch = `refs/heads/${workBranch(f.unitId)}`;
  const submission = `refs/merv/submissions/${unitRef('writer')}`;
  return { ...f, remote, git, url, branch, submission };
}

/** Delete a prepared lock only after the real admission hook accepts. Native Git then
 * reaches an actual files-backend I/O failure after it may already have renamed other refs.
 * No production fault injection, packet parser, or mock ref transaction is involved.
 */
async function brokenLockHook(path: string, lock: string, delegate?: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const input = fs.readFileSync(0);
const delegate = ${JSON.stringify(delegate ?? null)};
if (delegate) {
  const r = cp.spawnSync(process.execPath, [delegate, ...process.argv.slice(2)], {input, env:process.env, stdio:['pipe','inherit','inherit']});
  if (r.status !== 0) process.exit(r.status ?? 1);
}
if (process.argv[2] === 'prepared') fs.unlinkSync(${JSON.stringify(lock)});
`,
    { mode: 0o700 },
  );
}

test('an atomic native push projects the refs Git stored after a late I/O partial commit', async (t) => {
  const f = await fixture(t);
  const head = f.source.commit({ 'partial.txt': 'retained despite atomic failure\n' });
  const parent = `${f.submission}/parent`;
  const repository = f.core.repositories.paths(f.admin.projectId).repository;
  const native = f.core.repositories.git.run.bind(f.core.repositories.git);
  let armed = true;
  f.core.repositories.git.run = async (args, options = {}) => {
    if (armed && args.includes('http-backend') && options.durableOwner) {
      armed = false;
      const directory = args
        .find((arg) => arg.startsWith('core.hooksPath='))!
        .slice('core.hooksPath='.length);
      const hook = join(directory, 'reference-transaction');
      const policy = hook + '-policy';
      await rename(hook, policy);
      await brokenLockHook(hook, join(repository, parent + '.lock'), policy);
    }
    return native(args, options);
  };
  t.after(() => {
    f.core.repositories.git.run = native;
  });
  await assert.rejects(
    f.git(['push', '--atomic', '--porcelain', f.url, `${head}:${f.branch}`, `${head}:${parent}`]),
    (error: unknown) => {
      const report = (error as { stdout?: string }).stdout ?? '';
      assert.match(report, /atomic transaction failed/);
      assert.equal(report.split('\n').filter((line) => line.startsWith('!\t')).length, 2);
      return true;
    },
  );
  assert.equal(await f.core.repositories.resolve(f.admin.projectId, f.branch), head);
  assert.equal(await f.core.repositories.resolve(f.admin.projectId, parent), null);
  assert.equal((await f.unit()).canonicalHead, head);
  const journal = await f.state.read((sql) =>
    sql.get<{ status: string; outcome_json: string }>(
      'SELECT status,outcome_json FROM code_git_pushes WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 1',
      f.admin.projectId,
    ),
  );
  assert.equal(journal?.status, 'partial');
  assert.deepEqual(
    JSON.parse(journal!.outcome_json)
      .map((update: { outcome: string }) => update.outcome)
      .sort(),
    ['applied', 'rejected'],
  );
  await f.remote.recover();
  const next = f.source.commit({ 'next.txt': 'next push remains usable\n' });
  await f.git(['push', f.url, `${next}:${f.branch}`]);
  assert.equal((await f.unit()).canonicalHead, next);
});

for (const first of ['approval', 'branch'] as const)
  test(`an approved materialization retries an actual ${first}-only partial ref write`, async (t) => {
    const f = await fixture(t);
    const initialHead = (await f.unit()).canonicalHead;
    f.source.commit({ 'approved.txt': 'reviewed content\n' });
    const tree = f.source.git('rev-parse', 'HEAD^{tree}');
    await f.git([
      'push',
      '--atomic',
      f.url,
      `${f.root}:${f.submission}/parent`,
      `${tree}:${f.submission}/tree`,
    ]);
    const input = {
      sessionId: 'writer',
      parentOid: f.root,
      treeOid: tree,
      approvalId: 'review',
      createdAt: '2026-01-01T00:00:00.000Z',
      message: 'Approved frozen tree',
      unitId: f.unitId,
    };
    const approval = `refs/merv/approvals/${unitRef(input.approvalId)}`;
    const repository = f.core.repositories.paths(f.admin.projectId).repository;
    const native = f.core.repositories.git.run.bind(f.core.repositories.git);
    let armed = true;
    f.core.repositories.git.run = async (args, options = {}) => {
      if (armed && args[0] === 'update-ref' && options.durableOwner) {
        armed = false;
        const directory = join(f.directory, 'failed-approval-hooks');
        const failed = first === 'approval' ? f.branch : approval;
        await brokenLockHook(
          join(directory, 'reference-transaction'),
          join(repository, failed + '.lock'),
        );
        const commands = String(options.input).split('\n');
        const updates = commands.filter((line) => line.startsWith('update '));
        if (first === 'branch') updates.reverse();
        return native(['-c', `core.hooksPath=${directory}`, ...args], {
          ...options,
          input: `start\n${updates.join('\n')}\nprepare\ncommit\n`,
        });
      }
      return native(args, options);
    };
    t.after(() => {
      f.core.repositories.git.run = native;
    });
    await assert.rejects(f.remote.materializeSubmission(f.admin.projectId, input), {
      code: 'code_git_failed',
    });
    const partialApproval = await f.core.repositories.resolve(f.admin.projectId, approval);
    const partialBranch = await f.core.repositories.resolve(f.admin.projectId, f.branch);
    const committed = first === 'approval' ? partialApproval : partialBranch;
    assert.ok(committed && committed !== f.root);
    assert.equal(
      first === 'approval' ? partialBranch : partialApproval,
      first === 'approval' ? f.root : null,
    );
    const recovered = await f.remote.materializeSubmission(f.admin.projectId, input);
    assert.equal(recovered.head, committed, 'retry reuses the exact approved commit');
    assert.equal(await f.core.repositories.resolve(f.admin.projectId, approval), committed);
    assert.equal(await f.core.repositories.resolve(f.admin.projectId, f.branch), committed);
    assert.equal(await f.core.repositories.resolve(f.admin.projectId, `${committed}^{tree}`), tree);
    assert.equal(
      (await f.unit()).canonicalHead,
      initialHead,
      'approval acceptance owns the DB projection',
    );
    assert.equal(await readFile(join(repository, f.branch), 'utf8'), committed + '\n');
  });
