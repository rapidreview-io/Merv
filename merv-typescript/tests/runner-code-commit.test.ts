import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import type { CodeCommitCommand } from '@merv/contracts';
import type { Session } from '@merv/sessions/types';
import { LocalLedger, type LaunchRecord } from '../packages/runner/src/ledger.js';
import { GitWorkspaceManager } from '../packages/runner/src/workspaces.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-code-commit-'));
  const repository = join(directory, 'source');
  mkdirSync(repository);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('/usr/bin/git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: '/usr/bin:/bin',
        HOME: directory,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    }).trim();
  git(repository, 'init', '-b', 'main');
  writeFileSync(join(repository, 'seed.txt'), 'initial\n');
  git(repository, 'add', '.');
  git(
    repository,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'initial',
  );
  const initial = git(repository, 'rev-parse', 'HEAD');
  const binding = {
    baseUrl: 'http://127.0.0.1:7777',
    projectId: 'project',
    sourceId: 'synthetic-source',
  };
  const ledger = new LocalLedger({ directory: join(directory, 'machine'), binding });
  const config = { repository, baseRef: 'refs/heads/main' };
  let manager = new GitWorkspaceManager(ledger, config);
  const db = new DatabaseSync(ledger.path);
  const bare = join(ledger.directory, 'workspaces/repository.git');
  const prepare = async (
    id = 'first',
    readOnly = false,
    mode: 'persistent' | 'ephemeral' = 'persistent',
  ) => {
    const session = {
      id: `session-${id}`,
      projectId: 'project',
      actorId: `worker-${id}`,
      instanceId: 'instance',
      expectedRevision: 0,
      execution: {
        policy: {
          readOnly,
          tools: [],
          workspace: {
            mode,
            namespace: 'test',
            base: 'central',
            retain: mode === 'persistent',
            ...(mode === 'persistent' ? { perBase: false, advancesCentral: false } : {}),
          },
        },
        references: {},
      },
    } as unknown as Session;
    const record = ledger.reserve({
      id,
      sessionId: session.id,
      deadline: Date.now() + 120000,
      metadata: { session: JSON.parse(JSON.stringify(session)) },
    });
    const handle = await manager.prepare(record, session);
    db.prepare("UPDATE launches SET status='running' WHERE id=?").run(id);
    const command = (
      commandId = `command-${id}`,
      expectedHead = handle.snapshot!.headOid,
    ): CodeCommitCommand => ({
      id: commandId,
      projectId: session.projectId,
      sessionId: session.id,
      actorId: session.actorId,
      instanceId: session.instanceId,
      expectedRevision: 0,
      runnerId: ledger.runnerId,
      hostRef: id,
      workspace: handle.snapshot!,
      expectedHead,
      message: 'Save reviewed work\n\nLiteral $(no shell) and `no shell`',
      createdAt: '2026-09-15T12:34:56.000Z',
    });
    return { record, handle, command, session };
  };
  const stop = (record: LaunchRecord) =>
    db.prepare("UPDATE launches SET status='stopped' WHERE id=?").run(record.id);
  const reopen = () => {
    manager.dispose();
    manager = new GitWorkspaceManager(ledger, config);
    return manager;
  };
  t.after(() => {
    assert.equal(git(repository, 'rev-parse', 'HEAD'), initial, 'source repository is unchanged');
    assert.equal(git(repository, 'status', '--porcelain'), '');
    if (readFileSync(join(bare, 'HEAD'), 'utf8'))
      assert.equal(git(bare, 'rev-parse', 'refs/merv/central'), initial);
    manager.dispose();
    db.close();
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    repository,
    config,
    binding,
    ledger,
    db,
    bare,
    git,
    prepare,
    stop,
    reopen,
    get manager() {
      return manager;
    },
  };
}

test('code commit changes only the owned checkout, persists a replayable receipt, and keeps final capture separate', async (t) => {
  const f = fixture(t),
    first = await f.prepare();
  writeFileSync(join(first.handle.path, 'seed.txt'), 'changed\n');
  writeFileSync(join(first.handle.path, 'new.txt'), 'evidence\n');
  const command = first.command();
  const record = structuredClone(first.record),
    input = structuredClone(command);
  const committing = f.manager.checkpointCommit(record, input);
  record.id = 'changed';
  input.message = 'changed';
  const receipt = await committing;
  assert.equal(receipt.parentOid, command.expectedHead);
  assert.notEqual(receipt.headOid, receipt.parentOid);
  assert.deepEqual(receipt.stats, { commitCount: 1, filesChanged: 2, insertions: 2, deletions: 1 });
  assert.equal(f.git(first.handle.path, 'status', '--porcelain'), '');
  assert.equal(f.git(first.handle.path, 'log', '-1', '--format=%B'), command.message);
  assert.equal(f.git(first.handle.path, 'show', '-s', '--format=%at %ct'), '1789475696 1789475696');
  assert.equal(f.manager.get(first.record.id)!.status, 'ready');
  assert.deepEqual(f.manager.pendingCommits(first.record.id), [command]);
  assert.deepEqual(await f.reopen().checkpointCommit(first.record, command), receipt);
  assert.deepEqual(f.manager.commitOutcome(command.id), { receipt });
  await assert.rejects(
    f.manager.checkpointCommit(first.record, { ...command, message: 'different' }),
    /workspace_command_conflict/,
  );
  f.manager.acknowledgeCommit(command.id);
  assert.deepEqual(f.manager.pendingCommits(first.record.id), []);
  const noChange = await f.manager.checkpointCommit(
    first.record,
    first.command('no-change', receipt.headOid),
  );
  assert.equal(
    noChange.headOid,
    receipt.headOid,
    'an unchanged tree does not manufacture an empty commit',
  );
  f.stop(first.record);
  assert.equal((await f.manager.capture(first.record))!.headOid, receipt.headOid);
  await f.manager.close(first.record);
  assert.deepEqual(await f.manager.checkpointCommit(first.record, command), receipt);
});

test('read-only, stopped, uncertain, expired, wrong-host and conflicting-head requests cannot mutate Git', async (t) => {
  const f = fixture(t),
    review = await f.prepare('review', true, 'ephemeral');
  await assert.rejects(
    f.manager.checkpointCommit(review.record, review.command()),
    /workspace_readonly_commit/,
  );
  assert.deepEqual(f.manager.commitOutcome(review.command().id), {
    error: 'workspace_readonly_commit',
  });
  const first = await f.prepare();
  writeFileSync(join(first.handle.path, 'new.txt'), 'must remain uncommitted\n');
  await assert.rejects(
    f.manager.checkpointCommit(first.record, {
      ...first.command('wrong-host'),
      hostRef: 'another',
    }),
    /workspace_command_mismatch/,
  );
  await assert.rejects(
    f.manager.checkpointCommit(first.record, first.command('wrong-head', 'f'.repeat(40))),
    /workspace_head_conflict/,
  );
  for (const status of ['uncertain', 'reserved']) {
    f.db.prepare('UPDATE launches SET status=? WHERE id=?').run(status, first.record.id);
    await assert.rejects(
      f.manager.checkpointCommit(first.record, first.command(status)),
      /workspace_process_not_running/,
    );
  }
  f.db.prepare("UPDATE launches SET status='running',deadline=0 WHERE id=?").run(first.record.id);
  await assert.rejects(
    f.manager.checkpointCommit(first.record, first.command('expired')),
    /workspace_process_not_running/,
  );
  f.stop(first.record);
  await assert.rejects(
    f.manager.checkpointCommit(first.record, first.command('stopped')),
    /workspace_process_not_running/,
  );
  assert.equal(f.git(first.handle.path, 'rev-parse', 'HEAD'), first.handle.snapshot!.headOid);
  assert.equal(f.git(first.handle.path, 'diff', '--cached', '--name-only'), '');
});

test('lost receipt persistence replays the exact committed tree after edits, stop and checkout removal', async (t) => {
  const f = fixture(t),
    first = await f.prepare('ephemeral', false, 'ephemeral');
  writeFileSync(join(first.handle.path, 'seed.txt'), 'first frozen change\n');
  f.db.exec(
    "CREATE TRIGGER fixture_receipt_failure BEFORE UPDATE OF receipt_json ON runner_code_commits WHEN NEW.receipt_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END",
  );
  await assert.rejects(
    f.manager.checkpointCommit(first.record, first.command()),
    /fixture receipt failure/,
  );
  const committed = f.git(first.handle.path, 'rev-parse', 'HEAD');
  assert.notEqual(committed, first.handle.snapshot!.headOid);
  assert.equal(
    f.manager.commitOutcome(first.command().id),
    null,
    'an applied-but-unacknowledged commit is never reported failed',
  );
  writeFileSync(join(first.handle.path, 'seed.txt'), 'later work belongs to final capture\n');
  f.db.exec('DROP TRIGGER fixture_receipt_failure');
  f.stop(first.record);
  const capture = await f.manager.capture(first.record);
  assert.notEqual(capture!.headOid, committed);
  await f.manager.close(first.record);
  const receipt = await f.reopen().checkpointCommit(first.record, first.command());
  assert.equal(receipt.headOid, committed);
  assert.equal(f.git(f.bare, 'show', `${receipt.headOid}:seed.txt`), 'first frozen change');
  assert.deepEqual(f.manager.commitOutcome(first.command().id), { receipt });
});

test('a delayed old Git transaction is fenced after capture and successor ownership even with unchanged HEAD', async (t) => {
  const f = fixture(t),
    first = await f.prepare();
  const fence = f.db
    .prepare('SELECT owner_oid FROM runner_workspace_fences WHERE launch_id=?')
    .get(first.record.id)!;
  const slot = f.db
    .prepare('SELECT slot_id FROM runner_workspaces WHERE launch_id=?')
    .get(first.record.id)!;
  const ownerRef = `refs/merv/owners/${hash(String(slot.slot_id))}`;
  const receiptRef = `refs/merv/commands/${hash('stale-orphan')}`;
  const child = spawn('/usr/bin/git', ['-C', first.handle.path, 'update-ref', '--stdin'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = once(child, 'exit');
  f.stop(first.record);
  await f.manager.capture(first.record);
  await f.manager.close(first.record);
  const next = await f.prepare('successor');
  assert.equal(next.handle.snapshot!.headOid, first.handle.snapshot!.headOid);
  child.stdin.end(
    [
      'start',
      `verify ${ownerRef} ${fence.owner_oid}`,
      `update HEAD ${first.handle.snapshot!.headOid} ${first.handle.snapshot!.headOid}`,
      `create ${receiptRef} ${first.handle.snapshot!.headOid}`,
      'prepare',
      'commit',
      '',
    ].join('\n'),
  );
  assert.notEqual((await exited)[0], 0);
  assert.match(stderr, /cannot lock ref|is at .* but expected/);
  assert.equal(f.git(f.bare, 'for-each-ref', '--format=%(refname)', receiptRef), '');
  assert.equal(f.git(next.handle.path, 'rev-parse', 'HEAD'), next.handle.snapshot!.headOid);
  await assert.rejects(
    f.manager.checkpointCommit(first.record, first.command('late-new')),
    /workspace_process_not_running/,
  );
});

test('changed files over 50 MiB and unsafe Git configuration are rejected before committing', async (t) => {
  const f = fixture(t),
    first = await f.prepare();
  writeFileSync(join(first.handle.path, 'large.bin'), '');
  truncateSync(join(first.handle.path, 'large.bin'), 50 * 1024 * 1024 + 1);
  await assert.rejects(
    f.manager.checkpointCommit(first.record, first.command('large')),
    /workspace_file_too_large/,
  );
  assert.equal(f.git(first.handle.path, 'rev-parse', 'HEAD'), first.handle.snapshot!.headOid);
  assert.equal(f.git(first.handle.path, 'diff', '--cached', '--name-only'), '');
  f.git(f.bare, 'config', 'filter.hostile.clean', 'touch /never-run');
  await assert.rejects(
    f.manager.checkpointCommit(first.record, first.command('unsafe-config')),
    /workspace_unsafe_git_config/,
  );
  f.git(f.bare, 'config', '--unset', 'filter.hostile.clean');
});

test('a killed controller resumes the frozen tree and deterministic commit object without including later edits', async (t) => {
  const f = fixture(t),
    first = await f.prepare();
  writeFileSync(join(first.handle.path, 'seed.txt'), 'frozen before controller death\n');
  const settings = join(f.directory, 'crash-settings.json');
  const observed = join(f.directory, 'commit-object.txt');
  writeFileSync(
    settings,
    JSON.stringify({
      directory: f.ledger.directory,
      binding: f.binding,
      config: f.config,
      launchId: first.record.id,
      command: first.command(),
      observed,
    }),
  );
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'tests/fixtures/runner-commit-crash.mjs', settings],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const [code, signal] = await once(child, 'exit');
  assert.equal(signal, 'SIGKILL', `${code}: ${stderr}`);
  const object = readFileSync(observed, 'utf8').trim();
  const journal = f.db
    .prepare('SELECT tree_oid,target_oid,error FROM runner_code_commits WHERE command_id=?')
    .get(first.command().id)!;
  assert.ok(journal.tree_oid);
  assert.equal(journal.target_oid, null);
  assert.equal(journal.error, null);
  assert.equal(f.git(first.handle.path, 'rev-parse', 'HEAD'), first.handle.snapshot!.headOid);
  writeFileSync(join(first.handle.path, 'seed.txt'), 'later edit must stay uncommitted\n');
  const receipt = await f.reopen().checkpointCommit(first.record, first.command());
  assert.equal(receipt.headOid, object);
  assert.equal(receipt.treeOid, journal.tree_oid);
  assert.equal(
    f.git(f.bare, 'show', `${receipt.headOid}:seed.txt`),
    'frozen before controller death',
  );
  assert.equal(
    readFileSync(join(first.handle.path, 'seed.txt'), 'utf8'),
    'later edit must stay uncommitted\n',
  );
  assert.match(f.git(first.handle.path, 'status', '--porcelain'), /M seed.txt/);
});

test('an uncertain unapplied ref update becomes terminal only after capture fences the launch', async (t) => {
  const f = fixture(t),
    first = await f.prepare();
  writeFileSync(join(first.handle.path, 'seed.txt'), 'pending command\n');
  const internals = f.manager as unknown as { git: (...args: unknown[]) => Promise<string> };
  const original = internals.git.bind(f.manager);
  internals.git = async (...args) => {
    if (
      (args[0] as string[]).includes('update-ref') &&
      String(args[4]).includes('refs/merv/commands/')
    )
      throw new Error('fixture unknown ref result');
    return original(...args);
  };
  await assert.rejects(
    f.manager.checkpointCommit(first.record, first.command()),
    /fixture unknown ref result/,
  );
  assert.equal(f.manager.commitOutcome(first.command().id), null);
  assert.equal(f.git(first.handle.path, 'rev-parse', 'HEAD'), first.handle.snapshot!.headOid);
  assert.throws(
    () => f.manager.acknowledgeCommit(first.command().id),
    /workspace_commit_outcome_required/,
  );
  internals.git = original;
  f.stop(first.record);
  await f.manager.capture(first.record);
  await assert.rejects(
    f.manager.checkpointCommit(first.record, first.command()),
    /workspace_process_not_running/,
  );
  assert.deepEqual(f.manager.commitOutcome(first.command().id), {
    error: 'workspace_process_not_running',
  });
  f.manager.acknowledgeCommit(first.command().id);
  assert.deepEqual(f.manager.pendingCommits(first.record.id), []);
});

test('capture tombstones an unfinished initial ownership claim so a delayed arm cannot strand the next worker', async (t) => {
  const f = fixture(t);
  const internals = f.manager as unknown as { git: (...args: unknown[]) => Promise<string> };
  const original = internals.git.bind(f.manager);
  internals.git = async (...args) => {
    const argv = args[0] as string[];
    if (argv.includes('update-ref') && argv.some((arg) => arg.startsWith('refs/merv/owners/')))
      throw new Error('fixture controller lost before owner claim');
    return original(...args);
  };
  await assert.rejects(f.prepare('unfinished'), /fixture controller lost/);
  internals.git = original;
  const record = f.ledger.get('unfinished')!;
  const fence = f.db
    .prepare('SELECT owner_oid FROM runner_workspace_fences WHERE launch_id=?')
    .get(record.id)!;
  const row = f.db
    .prepare('SELECT slot_id,path FROM runner_workspaces WHERE launch_id=?')
    .get(record.id)!;
  const ownerRef = `refs/merv/owners/${hash(String(row.slot_id))}`;
  const delayed = spawn('/usr/bin/git', ['-C', String(row.path), 'update-ref', '--stdin'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  delayed.stderr.resume();
  delayed.stdout.resume();
  const exited = once(delayed, 'exit');
  f.stop(record);
  await f.manager.capture(record);
  await f.manager.close(record);
  delayed.stdin.end(`create ${ownerRef} ${fence.owner_oid}\n`);
  assert.notEqual(
    (await exited)[0],
    0,
    'a tombstone prevents a delayed old create from restoring ownership',
  );
  const next = await f.prepare('new-owner');
  assert.equal(next.handle.status, 'ready');
  assert.notEqual(f.git(f.bare, 'rev-parse', ownerRef), fence.owner_oid);
});
