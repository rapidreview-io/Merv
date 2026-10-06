import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MachineRunner, validateRunnerConfig } from '@merv/runner';
import { machine, offer, server, until } from './fixtures/runner-stand-in.js';

const workInstanceId = 'work_retained';
const profile = {
  name: 'codex',
  harness: 'codex' as const,
  executable: process.execPath,
  isolatedLauncher: process.execPath,
  enabled: true,
  parallelism: 1,
};
const phase = (name: string) => {
  const session = offer(name, { workspace: { mode: 'none' } });
  session.instanceId = workInstanceId;
  session.execution.instanceId = workInstanceId;
  session.assignment.instanceId = workInstanceId;
  return session;
};

test('four fresh agents run serially in one retained directory after every cleanup barrier', async (t) => {
  const queue = ['planner', 'design_review', 'executor', 'results_review'].map(phase);
  const fake = server(() => queue.shift() ?? null);
  let resets = 0;
  let privateMarker = '';
  const f = machine(t, [profile], fake.fetch, {
    config: { workInstanceId, capacity: 1 },
    resetAssignment: async () => {
      resets++;
      rmSync(privateMarker, { force: true });
    },
  });
  const root = realpathSync(f.root);
  privateMarker = join(root, 'private-agent-state');
  const assignments = join(root, 'assignments');
  mkdirSync(assignments, { mode: 0o700 });
  f.config.assignmentWorkspaceDirectory = assignments;
  const launcher = join(root, 'stand-in-codex');
  writeFileSync(
    launcher,
    `#!${process.execPath}\n` +
      `
const fs = require('node:fs');
const crypto = require('node:crypto');
const marker = ${JSON.stringify(privateMarker)};
if (fs.existsSync(marker)) process.exit(70);
fs.writeFileSync(marker, 'private context');
const path = require('node:path').join(process.cwd(), 'research.jsonl');
fs.appendFileSync(path, JSON.stringify({ cwd:process.cwd(), credential:crypto.createHash('sha256').update(process.env.MERV_AGENT_SESSION_TOKEN || '').digest('hex') })+'\\n');
`,
    { mode: 0o700 },
  );
  f.config.profiles = [{ ...profile, isolatedLauncher: launcher }];
  const runner = f.make();
  await runner.start();
  await until(
    runner,
    () =>
      runner.snapshot().launches.length === 4 &&
      runner
        .snapshot()
        .launches.every(
          (l) =>
            ['exited', 'stopped'].includes(l.status) &&
            !l.releasePending &&
            !l.transcriptPending &&
            !l.workspace?.capturePending,
        ),
    'four fully settled agents',
  );
  const expected = join(assignments, createHash('sha256').update(workInstanceId).digest('hex'));
  const rows = readFileSync(join(expected, 'research.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s));
  assert.equal(rows.length, 4);
  assert.deepEqual([...new Set(rows.map((r) => r.cwd))], [expected]);
  assert.equal(
    new Set(rows.map((r) => r.credential)).size,
    4,
    'no worker session bearer is reused',
  );
  assert.equal(resets, 12, 'before launch, before capture, after capture for each phase');
  assert.equal(existsSync(privateMarker), false);
  const presences = fake.calls.filter((c) => c.path.endsWith('/runners/heartbeat'));
  assert.ok(presences.every((c) => c.body?.capabilities.includes('workflow.workhost.1')));
  assert.equal(new Set(presences.map((c) => c.body?.runnerId)).size, 1);
  await runner.stop();
  f.config.workInstanceId = 'another_work';
  assert.throws(() => f.make(), /history belongs to another work item/);
  f.config.workInstanceId = workInstanceId;
  const resumed = f.make();
  await resumed.start();
  assert.equal(resumed.snapshot().runnerId, runner.snapshot().runnerId);
  assert.equal(resumed.snapshot().launches.length, 4);
  assert.equal(readFileSync(join(expected, 'research.jsonl'), 'utf8').trim().split('\n').length, 4);
});

test('cleanup refusal prevents another agent from being leased or started', async (t) => {
  const queue = [phase('first'), phase('second')];
  const fake = server(() => queue.shift() ?? null);
  let attempts = 0;
  const f = machine(t, [profile], fake.fetch, {
    config: { workInstanceId, capacity: 1 },
    resetAssignment: async () => {
      attempts++;
      throw Object.assign(new Error('refused'), { code: 'assignment_cleanup_failed' });
    },
  });
  const assignments = join(realpathSync(f.root), 'assignments');
  mkdirSync(assignments, { mode: 0o700 });
  f.config.assignmentWorkspaceDirectory = assignments;
  const runner = f.make();
  await runner.start();
  for (let i = 0; i < 4; i++) await runner.tick();
  assert.equal(fake.leases('codex').length, 1);
  assert.equal(runner.snapshot().launches.length, 1);
  assert.equal(runner.snapshot().lastError, 'assignment_cleanup_failed');
  assert.ok(attempts > 0);
});

test('retained mode cannot run without a trusted cleanup barrier or admit a second unit', async (t) => {
  const fake = server(() => offer('different'));
  const f = machine(t, [profile], fake.fetch, {
    config: { workInstanceId, capacity: 1 },
    resetAssignment: async () => {},
  });
  const assignments = join(realpathSync(f.root), 'assignments');
  mkdirSync(assignments, { mode: 0o700 });
  f.config.assignmentWorkspaceDirectory = assignments;
  assert.throws(() => new MachineRunner(f.config, { fetch: fake.fetch }), /cleanup barrier/);
  assert.throws(
    () => validateRunnerConfig({ ...f.config, assignmentWorkspaceDirectory: undefined }),
    /assignment root/,
  );
  assert.throws(
    () => validateRunnerConfig({ ...f.config, workInstanceId: undefined }),
    /assignment root/,
  );
  assert.throws(() => validateRunnerConfig({ ...f.config, capacity: 2 }), /capacity one/);
  const runner = f.make();
  await runner.start();
  assert.equal(runner.snapshot().launches.length, 0);
  assert.equal(runner.snapshot().lastError, 'invalid_control_response');
});
