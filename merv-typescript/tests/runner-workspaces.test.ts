import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { WorkflowWorkspacePolicy } from '@merv/contracts';
import type { Session } from '@merv/sessions/types';
import { LocalLedger } from '../packages/runner/src/ledger.js';
import { RunnerWorkspaces } from '../packages/runner/src/workspaces.js';
import { MachineRunner, validateRunnerConfig } from '../packages/runner/src/index.js';

function setup(t: TestContext, workInstanceId?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-workspaces-'));
  let assignment: { directory: string; workInstanceId: string } | undefined;
  if (workInstanceId) {
    const path = join(directory, 'assignments');
    mkdirSync(path, { mode: 0o700 });
    assignment = { directory: realpathSync(path), workInstanceId };
  }
  const ledger = new LocalLedger({
    directory: join(directory, 'machine'),
    binding: { baseUrl: 'http://127.0.0.1:7000', projectId: 'project', sourceId: 'source-digest' },
  });
  const open = () => new RunnerWorkspaces(ledger, assignment);
  let manager = open();
  const reserve = (id: string) =>
    ledger.reserve({ id, sessionId: `session-${id}`, deadline: Date.now() + 60000 });
  const session = (
    id: string,
    workspace: WorkflowWorkspacePolicy = { mode: 'none' },
    instanceId = 'instance',
  ) =>
    ({
      id: `session-${id}`,
      projectId: 'project',
      instanceId,
      execution: { policy: { readOnly: false, tools: [], workspace }, references: {} },
    }) as unknown as Session;
  t.after(() => {
    manager.dispose();
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    assignment,
    ledger,
    get manager() {
      return manager;
    },
    reserve,
    session,
    stop: (id: string) => ledger.end(id, 'cancelled_before_spawn', 'reserved'),
    reopen() {
      manager.dispose();
      manager = open();
      return manager;
    },
  };
}

const hosted = {
  directory: '/tmp/merv-runner',
  baseUrl: 'http://127.0.0.1:7000',
  projectId: 'project',
  credentialEnv: 'MERV_SOURCE',
  capacity: 1,
  workInstanceId: 'instance',
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

test('one work item retains exactly one scratch cwd across sequential sessions and controller restart', async (t) => {
  const f = setup(t, 'instance');
  const paths: string[] = [];
  for (const name of ['planner', 'design-reviewer', 'executor', 'results-reviewer']) {
    const record = f.reserve(name);
    const handle = await f.manager.prepare(record, f.session(name));
    paths.push(handle.path);
    assert.equal(statSync(handle.path).mode & 0o777, 0o700);
    assert.equal(handle.path.startsWith(f.ledger.directory), false);
    if (name === 'planner')
      writeFileSync(join(handle.path, 'dataset.txt'), 'retained research data');
    assert.equal(readFileSync(join(handle.path, 'dataset.txt'), 'utf8'), 'retained research data');
    // Preparing it again after a restart gives the same directory.
    assert.deepEqual(await f.reopen().prepare(record, f.session(name)), handle);
    f.stop(name);
    assert.equal(await f.manager.capture(record), undefined);
    await f.manager.close(record);
    f.reopen();
  }
  assert.equal(new Set(paths).size, 1);
  // Each step's status row is the only record: there is no slot table.
  const db = new DatabaseSync(f.ledger.path, { readOnly: true });
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='runner_checkout_slots'").get()!
      .n,
    0,
  );
  db.close();
  assert.equal(
    paths[0],
    join(f.assignment!.directory, createHash('sha256').update('instance').digest('hex')),
  );
  const other = f.reserve('other');
  await assert.rejects(
    f.manager.prepare(other, f.session('other', { mode: 'none' }, 'different')),
    /workspace_work_mismatch/,
  );
});

test('a retained workspace cannot pass from a running or uncaptured session to another', async (t) => {
  const f = setup(t, 'instance');
  const first = f.reserve('first'),
    second = f.reserve('second');
  const handle = await f.manager.prepare(first, f.session('first'));
  writeFileSync(join(handle.path, 'pending.txt'), 'must survive');
  await assert.rejects(
    f.manager.prepare(second, f.session('second')),
    /workspace_owned_by_another_launch/,
  );
  f.stop('first');
  await assert.rejects(f.manager.close(first), /workspace_capture_required/);
  assert.equal(readFileSync(join(handle.path, 'pending.txt'), 'utf8'), 'must survive');
});

test('a work host needs both its assignment root and its work item, and no runner has a repository', () => {
  assert.equal(
    validateRunnerConfig(hosted).assignmentWorkspaceDirectory,
    hosted.assignmentWorkspaceDirectory,
  );
  for (const config of [
    { ...hosted, workInstanceId: undefined },
    { ...hosted, assignmentWorkspaceDirectory: undefined },
    { ...hosted, workspace: { repository: '/src', baseRef: 'main' } },
  ])
    assert.throws(() => validateRunnerConfig(config), { code: 'invalid_runner_config' });
  assert.throws(
    () =>
      new MachineRunner({
        directory: '/tmp/merv-runner',
        baseUrl: 'http://127.0.0.1:7000',
        projectId: 'project',
        credentialEnv: 'MERV_SOURCE',
        workspace: { repository: '/src', baseRef: 'main' },
        profiles: [],
      } as never),
    { code: 'invalid_runner_config' },
  );
});

test('a scratch directory is the launch’s own, and Git work that names no driver is refused', async (t) => {
  const f = setup(t),
    scratch = f.reserve('scratch');
  const s = await f.manager.prepare(scratch, f.session(scratch.id));
  writeFileSync(join(s.path, 'output.txt'), 'scratch data\n');
  // Nothing in it marks ownership, or could be deleted.
  assert.deepEqual(readdirSync(s.path), ['output.txt']);
  f.stop(scratch.id);
  assert.equal(await f.manager.capture(scratch), undefined);
  await f.manager.close(scratch);
  assert.equal(readFileSync(join(s.path, 'output.txt'), 'utf8'), 'scratch data\n');
  const git = f.reserve('git');
  await assert.rejects(
    f.manager.prepare(
      git,
      f.session(git.id, {
        mode: 'ephemeral',
        namespace: 'n',
        base: 'reference:code',
        retain: false,
        driver: 'code.v2',
      }),
    ),
    /workspace_repository_required/,
  );
  assert.equal(existsSync(join(f.ledger.directory, 'workspaces')), false);
});
