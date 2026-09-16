import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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

function setup(t: TestContext, options: { largeTrackedFile?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-workspaces-'));
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
  let manager = new GitWorkspaceManager(ledger, config);
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
  const stop = (id: string) => ledger.cancelReservation(id);
  const reopen = () => {
    manager.dispose();
    manager = new GitWorkspaceManager(ledger, config);
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

test('private clone, idempotent prepare, bounded WIP capture and persistent resume preserve per-launch history', async (t) => {
  const f = setup(t),
    first = f.reserve('first');
  const handle = await f.manager.prepare(first, f.session('first'));
  assert.equal(handle.snapshot?.baseOid, f.second);
  assert.equal(handle.snapshot?.treeOid, f.git(handle.path, 'rev-parse', 'HEAD^{tree}'));
  assert.match(handle.snapshot!.branch!, /^codex\/merv\//);
  assert.equal(f.git(f.bare, 'remote'), '');
  assert.equal(existsSync(join(f.bare, 'objects/info/alternates')), false);
  assert.deepEqual(await f.reopen().prepare(first, f.session('first')), handle);
  writeFileSync(join(handle.path, 'seed.txt'), 'updated\nmore\n');
  await assert.rejects(f.manager.capture(first), /workspace_process_stop_unconfirmed/);
  f.stop(first.id);
  const result = await f.manager.capture(first);
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
  await assert.rejects(
    f.manager.prepare(second, f.session('second')),
    /workspace_owned_by_another_launch/,
  );
  await f.manager.close(first);
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

test('read-only work refuses dirty files, staged changes and unexpected HEAD without auto-committing', async (t) => {
  const f = setup(t),
    record = f.reserve('review');
  const handle = await f.manager.prepare(
    record,
    f.session(record.id, f.policy(), { readOnly: true }),
  );
  f.stop(record.id);
  writeFileSync(join(handle.path, 'new.txt'), 'unexpected\n');
  await assert.rejects(f.manager.capture(record), /workspace_readonly_dirty/);
  assert.equal(f.git(handle.path, 'rev-parse', 'HEAD'), handle.snapshot!.headOid);
  f.git(handle.path, 'add', '.');
  await assert.rejects(f.manager.capture(record), /workspace_readonly_dirty/);
  f.commit(handle.path, 'unexpected commit');
  await assert.rejects(f.manager.capture(record), /workspace_readonly_head_changed/);
  assert.equal(f.manager.get(record.id)?.status, 'capturing');
  assert.equal(readFileSync(join(handle.path, 'new.txt'), 'utf8'), 'unexpected\n');
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

test('oversized changed files are preserved and rejected before WIP commit', async (t) => {
  const f = setup(t),
    record = f.reserve('large');
  const handle = await f.manager.prepare(record, f.session(record.id));
  const file = join(handle.path, 'large.bin');
  writeFileSync(file, '');
  truncateSync(file, 50 * 1024 * 1024 + 1);
  f.stop(record.id);
  await assert.rejects(f.manager.capture(record), /workspace_file_too_large/);
  assert.equal(f.git(handle.path, 'rev-parse', 'HEAD'), handle.snapshot!.headOid);
  assert.equal(f.git(handle.path, 'diff', '--cached', '--name-only'), '');
  assert.equal(existsSync(file), true);
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

test('unsafe private Git filters refuse checkout creation without executing smudge commands', async (t) => {
  const f = setup(t),
    first = f.reserve('first');
  await f.manager.prepare(first, f.session(first.id));
  const canary = join(f.directory, 'executed');
  f.git(f.bare, 'config', 'filter.hostile.smudge', `touch '${canary}'; cat`);
  // info/attributes would select the hostile filter even for unchanged tracked content.
  mkdirSync(join(f.bare, 'info'), { recursive: true });
  writeFileSync(join(f.bare, 'info/attributes'), '* filter=hostile\n');
  const next = f.reserve('other');
  await assert.rejects(
    f.manager.prepare(next, f.session(next.id, f.policy(), { instanceId: 'other' })),
    /workspace_unsafe_git_config/,
  );
  assert.equal(existsSync(canary), false);
  assert.equal(f.manager.get(next.id), undefined);
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
