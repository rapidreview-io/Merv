import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { WorkflowWorkspacePolicy } from '@merv/contracts';
import type { Session } from '@merv/sessions/types';
import { LocalLedger } from '../packages/runner/src/ledger.js';
import { GitWorkspaceManager } from '../packages/runner/src/workspaces.js';
import { validateRunnerConfig } from '../packages/runner/src/index.js';

function setup(
  t: TestContext,
  options: { largeTrackedFile?: boolean; assignmentScratch?: boolean } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-workspaces-'));
  const assignmentPath = options.assignmentScratch ? join(directory, 'assignments') : undefined;
  if (assignmentPath) mkdirSync(assignmentPath, { mode: 0o700 });
  const assignmentWorkspaceDirectory = assignmentPath ? realpathSync(assignmentPath) : undefined;
  const repository = join(directory, 'source');
  mkdirSync(repository);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], {
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
  if (options.largeTrackedFile) {
    writeFileSync(join(repository, 'historical-large.bin'), '');
    truncateSync(join(repository, 'historical-large.bin'), 50 * 1024 * 1024 + 1);
  }
  symlinkSync('seed.txt', join(repository, 'seed-link'));
  git(repository, 'add', '.');
  const commit = (cwd: string, message: string) =>
    git(
      cwd,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      message,
    );
  commit(repository, 'initial');
  const initial = git(repository, 'rev-parse', 'HEAD');
  writeFileSync(join(repository, 'second.txt'), 'second\n');
  git(repository, 'add', '.');
  commit(repository, 'second');
  const second = git(repository, 'rev-parse', 'HEAD');
  const sourceBefore = {
    refs: git(repository, 'show-ref'),
    config: readFileSync(join(repository, '.git/config'), 'utf8'),
    status: git(repository, 'status', '--porcelain'),
  };
  const ledger = new LocalLedger({
    directory: join(directory, 'machine'),
    binding: { baseUrl: 'http://127.0.0.1:7000', projectId: 'project', sourceId: 'source-digest' },
  });
  const config = { repository, baseRef: 'refs/heads/main' };
  let manager = new GitWorkspaceManager(ledger, config, assignmentWorkspaceDirectory);
  const reserve = (id: string) =>
    ledger.reserve({
      id,
      sessionId: `session-${id}`,
      deadline: Date.now() + 60000,
    });
  const policy = (
    overrides: Partial<Extract<WorkflowWorkspacePolicy, { mode: 'persistent' }>> = {},
  ): WorkflowWorkspacePolicy => ({
    mode: 'persistent',
    namespace: 'tests',
    base: 'central',
    retain: true,
    perBase: false,
    advancesCentral: false,
    ...overrides,
  });
  const session = (
    id: string,
    workspace: WorkflowWorkspacePolicy = policy(),
    options: {
      readOnly?: boolean;
      references?: Record<string, string | string[]>;
      instanceId?: string;
    } = {},
  ) =>
    ({
      id: `session-${id}`,
      projectId: 'project',
      instanceId: options.instanceId ?? 'instance',
      execution: {
        policy: { readOnly: options.readOnly ?? false, tools: [], workspace },
        references: options.references ?? {},
      },
    }) as unknown as Session;
  const stop = (id: string) => ledger.end(id, 'cancelled_before_spawn', 'reserved');
  const reopen = () => {
    manager.dispose();
    manager = new GitWorkspaceManager(ledger, config, assignmentWorkspaceDirectory);
    return manager;
  };
  t.after(() => {
    assert.deepEqual(
      {
        refs: git(repository, 'show-ref'),
        config: readFileSync(join(repository, '.git/config'), 'utf8'),
        status: git(repository, 'status', '--porcelain'),
      },
      sourceBefore,
      'the source repository must never change',
    );
    manager.dispose();
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    assignmentWorkspaceDirectory,
    repository,
    ledger,
    get manager() {
      return manager;
    },
    reserve,
    policy,
    session,
    stop,
    reopen,
    git,
    commit,
    initial,
    second,
    bare: join(ledger.directory, 'workspaces/repository.git'),
  };
}

test('isolated scratch cwd is outside the private ledger while Git storage stays private', async (t) => {
  const f = setup(t, { assignmentScratch: true });
  const scratch = f.reserve('isolated-scratch');
  const handle = await f.manager.prepare(scratch, f.session(scratch.id, { mode: 'none' }));
  assert.equal(
    handle.path,
    join(f.assignmentWorkspaceDirectory!, createHash('sha256').update(scratch.id).digest('hex')),
  );
  assert.equal(statSync(handle.path).mode & 0o777, 0o700);
  assert.equal(handle.path.startsWith(f.ledger.directory), false);
  assert.equal(existsSync(f.bare), false);
  assert.deepEqual(
    await f.reopen().prepare(scratch, f.session(scratch.id, { mode: 'none' })),
    handle,
  );
  writeFileSync(join(handle.path, 'result.txt'), 'assignment output\n');
  f.stop(scratch.id);
  assert.equal(await f.manager.capture(scratch), undefined);
  await f.manager.close(scratch);
  assert.equal(readFileSync(join(handle.path, 'result.txt'), 'utf8'), 'assignment output\n');
});

test("an isolated machine takes no runner repository: its Git checkouts are its driver's", () => {
  const isolated = {
    directory: '/tmp/merv-runner',
    baseUrl: 'http://127.0.0.1:7000',
    projectId: 'project',
    credentialEnv: 'MERV_SOURCE',
    capacity: 1,
    oneAssignment: true,
    assignmentWorkspaceDirectory: '/workspace/assignments',
    profiles: [
      {
        name: 'hosted-codex',
        harness: 'codex',
        executable: process.execPath,
        isolatedLauncher: process.execPath,
        enabled: true,
        parallelism: 1,
      },
    ],
  };
  assert.equal(
    validateRunnerConfig(isolated).assignmentWorkspaceDirectory,
    isolated.assignmentWorkspaceDirectory,
  );
  assert.throws(
    () => validateRunnerConfig({ ...isolated, workspace: { repository: '/src', baseRef: 'main' } }),
    { code: 'invalid_runner_config' },
  );
});

test('private clone, idempotent prepare, bounded WIP capture and persistent resume preserve per-launch history', async (t) => {
  const f = setup(t),
    first = f.reserve('first');
  const preparingRecord = structuredClone(first),
    preparingSession = f.session('first');
  const preparing = f.manager.prepare(preparingRecord, preparingSession);
  preparingRecord.id = preparingSession.id = 'changed';
  preparingSession.execution.policy.readOnly = true;
  const handle = await preparing;
  assert.equal(handle.readOnly, false);
  assert.equal(handle.snapshot?.baseOid, f.second);
  assert.equal(handle.snapshot?.treeOid, f.git(handle.path, 'rev-parse', 'HEAD^{tree}'));
  assert.match(handle.snapshot!.branch!, /^codex\/merv\//);
  assert.equal(f.git(f.bare, 'remote'), '');
  assert.equal(existsSync(join(f.bare, 'objects/info/alternates')), false);
  assert.deepEqual(await f.reopen().prepare(first, f.session('first')), handle);
  writeFileSync(join(handle.path, 'seed.txt'), 'updated\nmore\n');
  await assert.rejects(f.manager.capture(first), /workspace_process_stop_unconfirmed/);
  f.stop(first.id);
  const capturingRecord = structuredClone(first);
  const capturing = f.manager.capture(capturingRecord);
  capturingRecord.id = 'changed';
  const result = await capturing;
  assert.notEqual(result?.headOid, handle.snapshot!.headOid);
  assert.equal(result?.treeOid, f.git(handle.path, 'rev-parse', 'HEAD^{tree}'));
  assert.notEqual(result?.treeOid, handle.snapshot!.treeOid);
  assert.deepEqual(result?.stats, { commitCount: 1, filesChanged: 1, insertions: 2, deletions: 1 });
  assert.equal(
    f.git(handle.path, 'show', 'HEAD:seed-link'),
    'seed.txt',
    'normal tracked symlinks are data',
  );
  assert.deepEqual(await f.manager.capture(first), result);
  const second = f.reserve('second');
  // The owner has ended and will free the slot: the successor is put off, not failed.
  await assert.rejects(f.manager.prepare(second, f.session('second')), {
    name: 'WorkspaceDeferred',
    cause: 'checkout_busy',
    code: 'workspace_owned_by_another_launch',
  });
  const closingRecord = structuredClone(first);
  const closing = f.manager.close(closingRecord);
  closingRecord.id = 'changed';
  await closing;
  const resumed = await f.reopen().prepare(second, f.session('second'));
  assert.equal(resumed.path, handle.path);
  assert.equal(resumed.snapshot!.headOid, result!.headOid);
  assert.equal(resumed.snapshot!.workspaceId, result!.workspaceId);
  writeFileSync(join(resumed.path, 'new.txt'), 'later\n');
  f.stop(second.id);
  await f.manager.capture(second);
  await f.manager.close(second);
  assert.deepEqual(
    f.manager.get(first.id)?.snapshot,
    result,
    'later work cannot overwrite old final capture',
  );
});

test('full-OID per-base lineages split, retain=false removes only checkouts, and ephemeral work is detached', async (t) => {
  const f = setup(t);
  const pinned = f.policy({ base: 'reference:code', perBase: true, retain: false });
  const first = f.reserve('base-a');
  const a = await f.manager.prepare(
    first,
    f.session(first.id, pinned, { references: { code: f.initial } }),
  );
  assert.ok(a.path.endsWith(f.initial));
  writeFileSync(join(a.path, 'retained.txt'), 'commit survives checkout removal\n');
  f.stop(first.id);
  const result = await f.manager.capture(first);
  await f.manager.close(first);
  assert.equal(existsSync(a.path), false);
  const next = f.reserve('base-a-resume');
  const resumed = await f.manager.prepare(
    next,
    f.session(next.id, pinned, { references: { code: f.initial } }),
  );
  assert.equal(resumed.snapshot?.headOid, result?.headOid);
  const other = f.reserve('base-b');
  const b = await f.manager.prepare(
    other,
    f.session(other.id, pinned, { references: { code: f.second } }),
  );
  assert.notEqual(b.path, a.path);
  assert.ok(b.path.endsWith(f.second));
  assert.equal(b.snapshot?.headOid, f.second);
  const ephemeral = f.reserve('ephemeral');
  const ephemeralPolicy: WorkflowWorkspacePolicy = {
    mode: 'ephemeral',
    namespace: 'review',
    base: 'reference:code',
    retain: false,
  };
  const e = await f.manager.prepare(
    ephemeral,
    f.session(ephemeral.id, ephemeralPolicy, {
      references: { code: result!.headOid },
      readOnly: true,
    }),
  );
  assert.equal(e.snapshot?.branch, null);
  assert.equal(e.snapshot?.baseOid, result!.headOid);
  f.stop(ephemeral.id);
  await f.manager.capture(ephemeral);
  await f.manager.close(ephemeral);
  assert.equal(existsSync(e.path), false);
});

test('reference bases never fall back and non-per-base persistent branches refuse a changed explicit base', async (t) => {
  const f = setup(t),
    pinned = f.policy({ base: 'reference:code' });
  const missing = f.reserve('missing');
  const invalidReferences: Record<string, string | string[]>[] = [
    {},
    { code: [f.initial] },
    { code: 'main' },
    { code: 'f'.repeat(40) },
  ];
  for (const references of invalidReferences) {
    await assert.rejects(
      f.manager.prepare(missing, f.session(missing.id, pinned, { references })),
      /workspace_(?:base_reference_required|invalid_oid|git_failed)/,
    );
    assert.equal(f.manager.get(missing.id), undefined);
  }
  const first = f.reserve('first');
  await f.manager.prepare(first, f.session(first.id, pinned, { references: { code: f.initial } }));
  f.stop(first.id);
  await f.manager.capture(first);
  await f.manager.close(first);
  const next = f.reserve('next');
  await assert.rejects(
    f.manager.prepare(next, f.session(next.id, pinned, { references: { code: f.second } })),
    /workspace_base_changed/,
  );
});

test('a retained reviewer that changed what it judged is reported as attached and put back on it', async (t) => {
  const f = setup(t),
    record = f.reserve('review');
  const handle = await f.manager.prepare(
    record,
    f.session(record.id, f.policy(), { readOnly: true }),
  );
  // Ignored files (dependencies, caches) are the checkout's own and survive the restore.
  mkdirSync(join(f.bare, 'info'), { recursive: true });
  writeFileSync(join(f.bare, 'info/exclude'), 'cache/\n');
  mkdirSync(join(handle.path, 'cache'));
  writeFileSync(join(handle.path, 'cache/kept'), 'ignored\n');
  writeFileSync(join(handle.path, 'staged.txt'), 'staged\n');
  f.git(handle.path, 'add', '.');
  f.commit(handle.path, 'unexpected commit');
  writeFileSync(join(handle.path, 'seed.txt'), 'tracked edit\n');
  writeFileSync(join(handle.path, 'new.txt'), 'untracked\n');
  f.stop(record.id);
  const captured = await f.manager.capture(record);
  assert.deepEqual(captured, handle.snapshot);
  assert.equal(f.git(handle.path, 'symbolic-ref', '--short', 'HEAD'), handle.snapshot!.branch);
  assert.equal(f.git(handle.path, 'rev-parse', 'HEAD'), handle.snapshot!.headOid);
  assert.equal(f.git(handle.path, 'status', '--porcelain', '--untracked-files=all'), '');
  assert.equal(readFileSync(join(handle.path, 'cache/kept'), 'utf8'), 'ignored\n');
  await f.manager.close(record);
  assert.equal(f.manager.get(record.id)?.status, 'closed');
});

test('a reviewer computes in a checkout it is about to lose, and is reported as attached', async (t) => {
  const f = setup(t),
    record = f.reserve('review');
  // Not retained: the worktree is removed at release, so untracked scratch goes with it.
  const handle = await f.manager.prepare(
    record,
    f.session(record.id, f.policy({ retain: false }), { readOnly: true }),
  );
  f.stop(record.id);
  writeFileSync(join(handle.path, 'rerun.py'), 'print(1)\n');
  writeFileSync(join(handle.path, 'out.json'), '{"reproduced": true}\n');
  const captured = await f.manager.capture(record);
  assert.equal(captured?.headOid, handle.snapshot!.headOid);
  assert.equal(captured?.stats.commitCount, 0);
  assert.equal(f.git(handle.path, 'rev-parse', 'HEAD'), handle.snapshot!.headOid);

  const second = f.reserve('review-2');
  const changed = await f.manager.prepare(
    second,
    f.session(second.id, f.policy({ retain: false }), {
      readOnly: true,
      instanceId: 'instance-reviewed',
    }),
  );
  f.stop(second.id);
  writeFileSync(join(changed.path, 'seed.txt'), 'edited by the reviewer\n');
  f.git(changed.path, 'switch', '--detach');
  assert.deepEqual(await f.manager.capture(second), changed.snapshot);
  await f.manager.close(second);
  assert.equal(existsSync(changed.path), false);
});

test('uncertain ownership never releases a persistent checkout and branch/commondir tampering is refused', async (t) => {
  const f = setup(t),
    record = f.reserve('uncertain');
  const handle = await f.manager.prepare(record, f.session(record.id));
  f.ledger.markUncertain(record.id, 'missing_supervisor');
  const next = f.reserve('next');
  await assert.rejects(
    f.manager.prepare(next, f.session(next.id)),
    /workspace_owned_by_another_launch/,
  );
  await assert.rejects(f.manager.capture(record), /workspace_process_stop_unconfirmed/);
  await assert.rejects(f.manager.close(record), /workspace_process_stop_unconfirmed/);
  f.git(handle.path, 'switch', '--detach');
  await assert.rejects(
    f.reopen().prepare(record, f.session(record.id)),
    /workspace_branch_changed/,
  );
  f.git(handle.path, 'symbolic-ref', 'HEAD', `refs/heads/${handle.snapshot!.branch}`);
  const admin = readFileSync(join(handle.path, '.git'), 'utf8').trim().slice(8);
  writeFileSync(join(admin, 'commondir'), `${join(f.repository, '.git')}\n`);
  await assert.rejects(
    f.manager.prepare(record, f.session(record.id)),
    /workspace_foreign_checkout/,
  );
});

/** The launch's workspace diagnostics, as the runner reports them. */
const notes = (f: ReturnType<typeof setup>, id: string) =>
  f.ledger.get(id)!.metadata.workspaceNotes as Record<string, Record<string, unknown>> | undefined;

for (const retain of [true, false])
  test(`a ${retain ? 'retained' : 'non-retained'} writer's oversized file is moved aside, visibly, and the rest captured`, async (t) => {
    const f = setup(t),
      record = f.reserve('large');
    const policy = retain
      ? f.policy()
      : ({ mode: 'ephemeral', namespace: 'tests', base: 'central', retain: false } as const);
    const handle = await f.manager.prepare(record, f.session(record.id, policy));
    writeFileSync(join(handle.path, 'seed.txt'), 'kept beside the refused file\n');
    writeFileSync(join(handle.path, 'large.bin'), '');
    truncateSync(join(handle.path, 'large.bin'), 51 * 1024 * 1024);
    f.stop(record.id);
    const result = (await f.manager.capture(record))!;
    assert.equal(
      f.git(handle.path, 'show', `${result.headOid}:seed.txt`),
      'kept beside the refused file',
    );
    assert.equal(f.git(handle.path, 'ls-tree', '--name-only', result.headOid, 'large.bin'), '');
    assert.equal(f.git(handle.path, 'status', '--porcelain', '--untracked-files=all'), '');
    assert.equal(
      f.git(f.bare, 'cat-file', '--batch-all-objects', '--batch-check').includes(' 53477376'),
      false,
    );
    const aside = `${handle.path}.refused-${record.id}`;
    assert.deepEqual(notes(f, record.id)?.workspace_capture_refused_file, {
      aside,
      paths: ['large.bin'],
    });
    await f.manager.close(record);
    assert.equal(statSync(join(aside, 'large.bin')).size, 51 * 1024 * 1024);
    const next = f.reserve('after-large');
    const resumed = await f.manager.prepare(next, f.session(next.id, policy));
    assert.equal(resumed.snapshot!.headOid, retain ? result.headOid : handle.snapshot!.headOid);
  });

test('a tracked directory a writer replaced with a symlink is moved aside and restored from HEAD', async (t) => {
  const f = setup(t),
    record = f.reserve('linked');
  const handle = await f.manager.prepare(record, f.session(record.id));
  mkdirSync(join(handle.path, 'lib'));
  writeFileSync(join(handle.path, 'lib/a.txt'), 'tracked\n');
  agent(f, handle.path, 'add', 'lib');
  agent(f, handle.path, 'commit', '-m', 'lib');
  rmSync(join(handle.path, 'lib'), { recursive: true });
  symlinkSync(f.directory, join(handle.path, 'lib'));
  writeFileSync(join(handle.path, 'work.txt'), 'captured\n');
  f.stop(record.id);
  const result = (await f.manager.capture(record))!;
  assert.equal(f.git(handle.path, 'show', `${result.headOid}:lib/a.txt`), 'tracked');
  assert.equal(f.git(handle.path, 'show', `${result.headOid}:work.txt`), 'captured');
  assert.equal(f.git(handle.path, 'status', '--porcelain', '--untracked-files=all'), '');
  const aside = `${handle.path}.refused-${record.id}`;
  assert.equal(realpathSync(join(aside, 'lib')), realpathSync(f.directory));
  assert.deepEqual(notes(f, record.id)?.workspace_capture_refused_file?.paths, ['lib']);
});

test("a writer's hours of work beside one oversized dataset survive on disk, and the drop is reported", async (t) => {
  // Also what an upgraded runner does with a capture an older one left wedged on such a file.
  const f = setup(t),
    record = f.reserve('large-work');
  const handle = await f.manager.prepare(record, f.session(record.id));
  writeFileSync(join(handle.path, 'analysis.py'), 'UNIQUE-WRITER-WORK-1f3a\n');
  writeFileSync(join(handle.path, 'seed.txt'), 'UNIQUE-WRITER-EDIT-9c2e\n');
  writeFileSync(join(handle.path, 'dataset.csv'), '');
  truncateSync(join(handle.path, 'dataset.csv'), 51 * 1024 * 1024);
  f.stop(record.id);
  const result = (await f.manager.capture(record))!;
  assert.notEqual(result.headOid, handle.snapshot!.headOid);
  assert.equal(
    f.git(handle.path, 'show', `${result.headOid}:analysis.py`),
    'UNIQUE-WRITER-WORK-1f3a',
  );
  assert.equal(f.git(handle.path, 'show', `${result.headOid}:seed.txt`), 'UNIQUE-WRITER-EDIT-9c2e');
  assert.equal(readFileSync(join(handle.path, 'analysis.py'), 'utf8'), 'UNIQUE-WRITER-WORK-1f3a\n');
  const aside = `${handle.path}.refused-${record.id}`;
  assert.equal(statSync(join(aside, 'dataset.csv')).size, 51 * 1024 * 1024);
  assert.deepEqual(notes(f, record.id)?.workspace_capture_refused_file?.paths, ['dataset.csv']);
});

test('an unchanged historical large file does not block small WIP capture', async (t) => {
  const f = setup(t, { largeTrackedFile: true }),
    record = f.reserve('small-change');
  const handle = await f.manager.prepare(record, f.session(record.id));
  writeFileSync(join(handle.path, 'small.txt'), 'small evidence\n');
  f.stop(record.id);
  assert.deepEqual((await f.manager.capture(record))?.stats, {
    commitCount: 1,
    filesChanged: 1,
    insertions: 1,
    deletions: 0,
  });
});

test('crash after checkout creation replays durable intent without resetting existing files', async (t) => {
  const f = setup(t),
    record = f.reserve('crash');
  const db = new DatabaseSync(f.ledger.path);
  db.exec(
    "CREATE TRIGGER crash_before_ready BEFORE UPDATE OF status ON runner_workspaces WHEN NEW.status='ready' BEGIN SELECT RAISE(ABORT,'fixture crash'); END;",
  );
  await assert.rejects(f.manager.prepare(record, f.session(record.id)), /fixture crash/);
  const handle = f.manager.get(record.id)!;
  assert.equal(handle.status, 'preparing');
  writeFileSync(join(handle.path, 'kept.txt'), 'preserve partial checkout\n');
  db.exec('DROP TRIGGER crash_before_ready');
  db.close();
  const recovered = await f.reopen().prepare(record, f.session(record.id));
  assert.equal(recovered.path, handle.path);
  assert.equal(recovered.status, 'ready');
  assert.equal(readFileSync(join(handle.path, 'kept.txt'), 'utf8'), 'preserve partial checkout\n');
  f.stop(record.id);
  assert.equal((await f.manager.capture(record))?.stats.filesChanged, 1);
});

test('a failed validation after a new branch is added still records the lineage base', async (t) => {
  const f = setup(t),
    policy = f.policy({ retain: false }),
    first = f.reserve('first');
  const manager = f.manager as unknown as { validateCheckout(row: unknown): Promise<void> };
  const validate = manager.validateCheckout.bind(manager);
  manager.validateCheckout = async () => {
    manager.validateCheckout = validate;
    throw new Error('fixture validation failure');
  };
  await assert.rejects(
    f.manager.prepare(first, f.session(first.id, policy)),
    /fixture validation failure/,
  );
  f.stop(first.id);
  await f.manager.capture(first);
  await f.manager.close(first);
  assert.notEqual(f.git(f.bare, 'for-each-ref', 'refs/merv/bases/'), '');
  const next = f.reserve('next');
  const resumed = await f.manager.prepare(next, f.session(next.id, policy));
  assert.equal(existsSync(resumed.path), true);
});

test('unsafe private Git configuration is removed before any checkout runs its filters', async (t) => {
  const f = setup(t),
    first = f.reserve('first');
  await f.manager.prepare(first, f.session(first.id));
  const canary = join(f.directory, 'executed');
  f.git(f.bare, 'config', 'filter.hostile.smudge', `touch '${canary}'; cat`);
  // info/attributes would select the hostile filter even for unchanged tracked content.
  mkdirSync(join(f.bare, 'info'), { recursive: true });
  writeFileSync(join(f.bare, 'info/attributes'), '* filter=hostile\n');
  const next = f.reserve('other');
  await f.manager.prepare(next, f.session(next.id, f.policy(), { instanceId: 'other' }));
  assert.equal(existsSync(canary), false);
  assert.doesNotMatch(readFileSync(join(f.bare, 'config'), 'utf8'), /hostile/);
});

test('foreign paths are not adopted and failed unstarted preparation can close while preserving files', async (t) => {
  const f = setup(t),
    first = f.reserve('prime');
  await f.manager.prepare(first, f.session(first.id));
  const foreign = join(
    f.ledger.directory,
    'workspaces/checkouts/persistent/shared/tests/project/foreign',
  );
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, 'keep'), 'foreign');
  const next = f.reserve('foreign');
  await assert.rejects(
    f.manager.prepare(next, f.session(next.id, f.policy(), { instanceId: 'foreign' })),
    /workspace_foreign_checkout/,
  );
  const pending = f.reserve('pending');
  const db = new DatabaseSync(f.ledger.path);
  db.exec(
    "CREATE TRIGGER crash_before_ready BEFORE UPDATE OF status ON runner_workspaces WHEN NEW.status='ready' BEGIN SELECT RAISE(ABORT,'fixture crash'); END;",
  );
  await assert.rejects(
    f.manager.prepare(pending, f.session(pending.id, f.policy(), { instanceId: 'pending' })),
    /fixture crash/,
  );
  const partial = f.manager.get(pending.id)!;
  db.exec('DROP TRIGGER crash_before_ready');
  db.close();
  writeFileSync(join(partial.path, '.git'), 'foreign git marker\n');
  f.stop(pending.id);
  assert.equal(await f.manager.capture(pending), undefined);
  await f.manager.close(pending);
  assert.equal(f.manager.get(pending.id)?.status, 'closed');
  assert.equal(existsSync(partial.path), true);
  assert.equal(readFileSync(join(foreign, 'keep'), 'utf8'), 'foreign');
});

test('scratch needs no repository and same-namespace Git modes never nest their checkouts', async (t) => {
  const f = setup(t),
    scratch = f.reserve('scratch');
  const s = await f.manager.prepare(scratch, f.session(scratch.id, { mode: 'none' }));
  assert.equal(existsSync(f.bare), false);
  writeFileSync(join(s.path, 'output.txt'), 'scratch data\n');
  // The directory is the launch's own: nothing in it marks ownership, or could be deleted.
  assert.deepEqual(readdirSync(s.path), ['output.txt']);
  f.stop(scratch.id);
  assert.equal(await f.manager.capture(scratch), undefined);
  await f.manager.close(scratch);
  assert.equal(readFileSync(join(s.path, 'output.txt'), 'utf8'), 'scratch data\n');
  const persistent = f.reserve('persistent');
  const p = await f.manager.prepare(
    persistent,
    f.session(persistent.id, f.policy({ namespace: '_work' })),
  );
  const ephemeral = f.reserve('ephemeral');
  const e = await f.manager.prepare(
    ephemeral,
    f.session(ephemeral.id, {
      mode: 'ephemeral',
      namespace: '_work',
      base: 'central',
      retain: false,
    }),
  );
  assert.equal(e.path.startsWith(p.path + '/'), false);
  assert.equal(p.path.startsWith(e.path + '/'), false);
  const perBase = f.reserve('per-base');
  const b = await f.manager.prepare(
    perBase,
    f.session(perBase.id, f.policy({ namespace: '_work', perBase: true })),
  );
  for (const left of [p, b, e])
    for (const right of [p, b, e]) {
      if (left !== right) assert.equal(left.path.startsWith(right.path + '/'), false);
    }
  assert.equal(f.git(p.path, 'status', '--porcelain'), '');
  const dangling = join(
    f.ledger.directory,
    'workspaces/checkouts/persistent/shared/_work/project/dangling',
  );
  symlinkSync(join(f.directory, 'missing-target'), dangling);
  const record = f.reserve('dangling');
  await assert.rejects(
    f.manager.prepare(
      record,
      f.session(record.id, f.policy({ namespace: '_work' }), { instanceId: 'dangling' }),
    ),
    /workspace_foreign_checkout/,
  );
  assert.equal(existsSync(join(f.directory, 'missing-target')), false);
});

test('valid declaration namespaces have collision-free Git-safe branch components', async (t) => {
  const f = setup(t),
    branches = new Set<string>();
  for (const namespace of ['x..y', 'x.lock', 'x.', 'encoded-eC4ueQ']) {
    const record = f.reserve(`namespace-${branches.size}`);
    const handle = await f.manager.prepare(record, f.session(record.id, f.policy({ namespace })));
    const branch = handle.snapshot!.branch!;
    assert.equal(branches.has(branch), false);
    f.git(f.bare, 'check-ref-format', `refs/heads/${branch}`);
    branches.add(branch);
  }
});

/** An agent's Git command in its checkout; a merge, rebase or cherry-pick that stops exits non-zero. */
const agent = (f: ReturnType<typeof setup>, cwd: string, ...args: string[]) => {
  try {
    f.git(cwd, '-c', 'user.name=Agent', '-c', 'user.email=agent@example.test', ...args);
  } catch {
    // Left half-done, as an agent may leave it.
  }
};
const adminOf = (path: string) => readFileSync(join(path, '.git'), 'utf8').trim().slice(8);
/** A second line of work from the lineage's base, changing what the lineage changes. */
const conflicting = (f: ReturnType<typeof setup>, path: string, branch: string) => {
  agent(f, path, 'switch', '-c', 'upstream');
  writeFileSync(join(path, 'seed.txt'), 'upstream\n');
  agent(f, path, 'commit', '-am', 'upstream');
  agent(f, path, 'switch', branch);
  writeFileSync(join(path, 'seed.txt'), 'lineage\n');
  agent(f, path, 'commit', '-am', 'lineage');
};

test('a writer that leaves a conflicted merge is captured as one commit with its markers', async (t) => {
  const f = setup(t),
    record = f.reserve('merge');
  const handle = await f.manager.prepare(record, f.session(record.id));
  conflicting(f, handle.path, handle.snapshot!.branch!);
  const before = f.git(handle.path, 'rev-parse', 'HEAD');
  agent(f, handle.path, 'merge', 'upstream');
  assert.ok(existsSync(join(adminOf(handle.path), 'MERGE_HEAD')));
  f.stop(record.id);
  const result = await f.manager.capture(record);
  assert.equal(
    f.git(handle.path, 'rev-list', '--parents', '-n1', handle.snapshot!.branch!),
    `${result!.headOid} ${before}`,
  );
  assert.match(f.git(handle.path, 'show', 'HEAD:seed.txt'), /^<<<<<<< /m);
  assert.equal(existsSync(join(adminOf(handle.path), 'MERGE_HEAD')), false);
  await f.manager.close(record);
  const next = f.reserve('after-merge');
  const resumed = await f.manager.prepare(next, f.session(next.id));
  assert.equal(resumed.snapshot!.headOid, result!.headOid);
  assert.equal(f.git(resumed.path, 'status', '--porcelain'), '');
});

for (const operation of ['rebase', 'cherry-pick'] as const)
  test(`a writer stopped mid-${operation} continues its lineage from HEAD, and the next session sees no ${operation}`, async (t) => {
    const f = setup(t),
      record = f.reserve(operation);
    const handle = await f.manager.prepare(record, f.session(record.id));
    const branch = handle.snapshot!.branch!;
    conflicting(f, handle.path, branch);
    const state = join(adminOf(handle.path), operation === 'rebase' ? 'rebase-merge' : 'sequencer');
    if (operation === 'rebase') agent(f, handle.path, 'rebase', 'upstream');
    else {
      writeFileSync(join(handle.path, 'second.txt'), 'upstream again\n');
      agent(f, handle.path, 'switch', 'upstream');
      writeFileSync(join(handle.path, 'second.txt'), 'upstream again\n');
      agent(f, handle.path, 'commit', '-am', 'upstream again');
      agent(f, handle.path, 'switch', branch);
      agent(f, handle.path, 'cherry-pick', 'upstream~1', 'upstream');
    }
    assert.ok(existsSync(state));
    const stopped = f.git(handle.path, 'rev-parse', 'HEAD');
    f.stop(record.id);
    const result = await f.manager.capture(record);
    assert.equal(f.git(f.bare, 'rev-parse', `refs/heads/${branch}`), result!.headOid);
    assert.equal(
      f.git(f.bare, 'rev-list', '--parents', '-n1', result!.headOid),
      `${result!.headOid} ${stopped}`,
    );
    assert.equal(existsSync(state), false);
    await f.manager.close(record);
    const next = f.reserve(`after-${operation}`);
    const resumed = await f.manager.prepare(next, f.session(next.id));
    assert.equal(resumed.snapshot!.headOid, result!.headOid);
    assert.doesNotMatch(f.git(resumed.path, 'status'), /rebas|cherry|bisect/i);
  });

test('a writer stopped mid-rebase keeps its unreplayed commits reachable from a rescue ref', async (t) => {
  const f = setup(t),
    record = f.reserve('rebase-work');
  const handle = await f.manager.prepare(record, f.session(record.id));
  conflicting(f, handle.path, handle.snapshot!.branch!);
  writeFileSync(join(handle.path, 'later.txt'), 'committed later\n');
  agent(f, handle.path, 'add', 'later.txt');
  agent(f, handle.path, 'commit', '-m', 'later, committed work');
  const committed = f.git(handle.path, 'rev-parse', 'HEAD');
  agent(f, handle.path, 'rebase', 'upstream'); // stops on the first commit's conflict
  f.stop(record.id);
  await f.manager.capture(record);
  assert.equal(f.git(f.bare, 'rev-parse', 'refs/merv/rescued/rebase-work'), committed);
  assert.deepEqual(notes(f, record.id)?.workspace_commits_rescued, {
    refs: ['refs/merv/rescued/rebase-work'],
  });
});

test("a writer that rewinds its lineage keeps the old tip under a rescue ref; one that doesn't, none", async (t) => {
  const f = setup(t),
    record = f.reserve('rewind');
  const handle = await f.manager.prepare(record, f.session(record.id));
  writeFileSync(join(handle.path, 'kept.txt'), 'acknowledged\n');
  f.stop(record.id);
  const first = (await f.manager.capture(record))!;
  await f.manager.close(record);
  assert.equal(notes(f, record.id), undefined);
  const next = f.reserve('rewinder');
  const resumed = await f.manager.prepare(next, f.session(next.id));
  agent(f, resumed.path, 'reset', '--hard', handle.snapshot!.headOid);
  f.stop(next.id);
  const second = (await f.manager.capture(next))!;
  assert.equal(second.headOid, handle.snapshot!.headOid);
  assert.equal(f.git(f.bare, 'rev-parse', 'refs/merv/rescued/rewinder'), first.headOid);
  assert.deepEqual(notes(f, next.id)?.workspace_commits_rescued, {
    refs: ['refs/merv/rescued/rewinder'],
  });
});

test('a retained reviewer stopped mid-rebase is put back on what it judged', async (t) => {
  const f = setup(t),
    record = f.reserve('review');
  const handle = await f.manager.prepare(
    record,
    f.session(record.id, f.policy(), { readOnly: true }),
  );
  conflicting(f, handle.path, handle.snapshot!.branch!);
  agent(f, handle.path, 'rebase', 'upstream');
  assert.ok(existsSync(join(adminOf(handle.path), 'rebase-merge')));
  f.stop(record.id);
  assert.deepEqual(await f.manager.capture(record), handle.snapshot);
  assert.equal(existsSync(join(adminOf(handle.path), 'rebase-merge')), false);
  assert.equal(f.git(handle.path, 'symbolic-ref', '--short', 'HEAD'), handle.snapshot!.branch);
  assert.equal(f.git(handle.path, 'rev-parse', 'HEAD'), handle.snapshot!.headOid);
  assert.equal(f.git(handle.path, 'status', '--porcelain'), '');
});

test('work a writer did on a side branch becomes its lineage, even with the lineage branch deleted', async (t) => {
  const f = setup(t),
    record = f.reserve('side');
  const handle = await f.manager.prepare(record, f.session(record.id));
  const branch = handle.snapshot!.branch!;
  agent(f, handle.path, 'switch', '-c', 'feature');
  writeFileSync(join(handle.path, 'feature.txt'), 'committed\n');
  agent(f, handle.path, 'add', '.');
  agent(f, handle.path, 'commit', '-m', 'feature');
  agent(f, handle.path, 'branch', '-D', branch);
  writeFileSync(join(handle.path, 'seed.txt'), 'dirty\n');
  f.stop(record.id);
  const result = await f.manager.capture(record);
  assert.equal(f.git(handle.path, 'symbolic-ref', '--short', 'HEAD'), branch);
  assert.equal(f.git(handle.path, 'rev-parse', 'HEAD'), result!.headOid);
  assert.equal(f.git(handle.path, 'show', `${branch}:feature.txt`), 'committed');
  assert.equal(f.git(handle.path, 'show', `${branch}:seed.txt`), 'dirty');
  await f.manager.close(record);
});

test('a retained checkout deleted between sessions rejoins its lineage', async (t) => {
  const f = setup(t),
    record = f.reserve('deleted');
  const handle = await f.manager.prepare(record, f.session(record.id));
  writeFileSync(join(handle.path, 'kept.txt'), 'captured\n');
  f.stop(record.id);
  const result = await f.manager.capture(record);
  await f.manager.close(record);
  rmSync(handle.path, { recursive: true, force: true });
  const next = f.reserve('after-delete');
  const resumed = await f.manager.prepare(next, f.session(next.id));
  assert.equal(resumed.path, handle.path);
  assert.equal(resumed.snapshot!.headOid, result!.headOid);
});

const unreadable = { skip: process.getuid?.() === 0 && 'root reads every file' };
for (const [name, readOnly, jam] of [
  [
    "a writer's unreadable file",
    false,
    (path: string) => {
      writeFileSync(join(path, 'locked.txt'), 'x\n');
      chmodSync(join(path, 'locked.txt'), 0);
    },
  ],
  [
    "a reviewer's unreadable directory",
    true,
    (path: string) => {
      mkdirSync(join(path, 'locked'));
      writeFileSync(join(path, 'locked/file'), 'x\n');
      chmodSync(join(path, 'locked'), 0);
    },
  ],
  [
    'a stale index.lock',
    false,
    (path: string) => writeFileSync(join(adminOf(path), 'index.lock'), ''),
  ],
] as const)
  test(
    `a capture that fails the same way for 10 minutes is abandoned, not retried forever: ${name}`,
    unreadable,
    async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      let aside = '';
      // Registered before the fixture's cleanup, which must be able to read what it removes.
      t.after(() => {
        if (existsSync(join(aside, 'locked'))) chmodSync(join(aside, 'locked'), 0o700);
      });
      const f = setup(t),
        record = f.reserve('stuck');
      const handle = await f.manager.prepare(
        record,
        f.session(record.id, f.policy(), { readOnly }),
      );
      aside = `${handle.path}.abandoned-${record.id}`;
      writeFileSync(join(handle.path, 'work.txt'), "the session's work\n");
      jam(handle.path);
      f.stop(record.id);
      await assert.rejects(f.manager.capture(record), /workspace_git_failed/);
      t.mock.timers.tick(600_000);
      await assert.rejects(f.manager.capture(record), /workspace_git_failed/);
      await assert.rejects(f.manager.capture(record), /workspace_abandoned/);
      assert.equal(await f.manager.capture(record), undefined);
      await f.manager.close(record);
      assert.equal(f.manager.get(record.id)?.status, 'closed');
      // Moved aside for the user, never deleted, and pointing at no checkout of this repository.
      // (A reviewer's own files were already cleaned away by the restore that failed.)
      assert.ok(existsSync(aside));
      if (!readOnly)
        assert.equal(readFileSync(join(aside, 'work.txt'), 'utf8'), "the session's work\n");
      assert.equal(existsSync(join(aside, '.git')), false);
      const next = f.reserve('after');
      const resumed = await f.manager.prepare(next, f.session(next.id));
      assert.equal(resumed.path, handle.path);
      assert.equal(resumed.snapshot!.headOid, handle.snapshot!.headOid);
      assert.equal(f.git(resumed.path, 'status', '--porcelain'), '');
    },
  );

test('an index.lock gone by the next attempt is captured normally', async (t) => {
  const f = setup(t),
    record = f.reserve('transient');
  const handle = await f.manager.prepare(record, f.session(record.id));
  writeFileSync(join(handle.path, 'work.txt'), 'captured\n');
  writeFileSync(join(adminOf(handle.path), 'index.lock'), '');
  f.stop(record.id);
  await assert.rejects(f.manager.capture(record), /workspace_git_failed/);
  rmSync(join(adminOf(handle.path), 'index.lock'));
  const result = await f.manager.capture(record);
  assert.equal(f.git(handle.path, 'show', `${result!.headOid}:work.txt`), 'captured');
});

test(
  'a close whose checkout cannot be removed is abandoned and still frees its slot',
  unreadable,
  async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    let aside = '';
    t.after(() => chmodSync(join(aside, 'locked'), 0o700));
    const f = setup(t),
      record = f.reserve('unremovable');
    const handle = await f.manager.prepare(
      record,
      f.session(record.id, f.policy({ retain: false })),
    );
    f.stop(record.id);
    await f.manager.capture(record);
    // Something left in the checkout that its removal cannot read.
    mkdirSync(join(handle.path, 'locked'));
    writeFileSync(join(handle.path, 'locked/file'), 'x\n');
    chmodSync(join(handle.path, 'locked'), 0);
    aside = `${handle.path}.abandoned-${record.id}`;
    await assert.rejects(f.manager.close(record));
    t.mock.timers.tick(600_000);
    await assert.rejects(f.manager.close(record));
    await assert.rejects(f.manager.close(record), /workspace_abandoned/);
    await f.manager.close(record);
    assert.equal(f.manager.get(record.id)?.status, 'closed');
    assert.ok(existsSync(join(aside, 'locked')));
    const next = f.reserve('after');
    await f.manager.prepare(next, f.session(next.id, f.policy({ retain: false })));
  },
);

test('a commit size check reads only what changed, however large the tree', async (t) => {
  const f = setup(t),
    record = f.reserve('wide');
  await f.manager.prepare(record, f.session(record.id));
  const index = join(f.directory, 'wide-index');
  const plumb = (args: string[], input?: string) =>
    execFileSync('git', ['--git-dir', f.bare, ...args], {
      input,
      encoding: 'utf8',
      maxBuffer: 1 << 30,
      env: { PATH: '/usr/bin:/bin', GIT_INDEX_FILE: index },
    }).trim();
  const blob = plumb(['hash-object', '-w', '--stdin'], 'x\n');
  // 500,000 paths: listing the whole tree would exceed Git's 32 MiB output bound.
  plumb(
    ['update-index', '--index-info'],
    Array.from({ length: 500_000 }, (_, i) => `100644 ${blob}\td${i % 1000}/f${i}\n`).join(''),
  );
  const parent = plumb(['write-tree']);
  plumb([
    'update-index',
    '--add',
    '--cacheinfo',
    `100644,${plumb(['hash-object', '-w', '--stdin'], 'y\n')},changed`,
  ]);
  const tree = plumb(['write-tree']);
  const manager = f.manager as unknown as {
    row(id: string): unknown;
    checkTreeFiles(row: unknown, parent: string, tree: string): Promise<void>;
  };
  await manager.checkTreeFiles(manager.row(record.id), parent, tree);
});
