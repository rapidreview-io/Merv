import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { MervError, type CodeCheckSpec } from '@merv/contracts';
import type {
  SandboxCheckHandle,
  SandboxCheckPlan,
  SandboxCheckSpec,
  SandboxCheckVerdict,
  SandboxChecks,
} from '@merv/sandboxes';
import { checkScript } from '@merv/sandboxes';
import { checkBriefSections, checkResolutionCheck } from '@merv/code-research/base-check';
import { backends, optional } from './fixtures/code-store.js';
import { baseFixture } from './fixtures/code-bases.js';

/**
 * The project check of a base, end to end against a scripted adapter. Nothing here executes
 * a command: a fixture that ran a project check on a developer's machine would be a
 * counter-example to the one rule this whole slice exists to keep.
 */

const SPEC: CodeCheckSpec = {
  command: 'make test',
  timeoutSeconds: 600,
  image: { provider: 'thunder_compute', offerId: 'a6000_x1:thunder', snapshotId: null },
};
const ISOLATION: SandboxCheckHandle['isolation'] = {
  network: 'on',
  sourceReadOnly: false,
  imagePinned: 'offer',
  facts: ['The check had outbound network access.'],
};
const ran = (exit: number, head = 'out'): SandboxCheckVerdict => ({
  state: exit === 0 ? 'succeeded' : 'failed',
  result: { exit, bytes: head.length, head, tail: '' },
  setup: null,
  startedAt: '2026-09-22T00:00:00.000Z',
  finishedAt: '2026-09-22T00:05:00.000Z',
  usage: { amount: '0.035', currency: 'USD' },
});

/** An adapter that answers from a queue and rents nothing. Its log is the whole assertion. */
function scripted(verdicts: SandboxCheckVerdict[] = [], readyAfter = 1) {
  const log: string[] = [];
  const handles = new Map<string, SandboxCheckHandle>();
  const sources: number[] = [];
  let made = 0;
  let steps = 0;
  const checks: SandboxChecks = {
    async start(_projectId: string, spec: SandboxCheckSpec) {
      log.push(`start ${spec.idempotencyKey}`);
      // The service's own idempotency: a repeated key is the same object and machine.
      const known = handles.get(spec.idempotencyKey);
      if (known) return known;
      sources.push(spec.source.bytes.byteLength);
      made += 1;
      const handle: SandboxCheckHandle = {
        sandboxId: `sbx_${made}`,
        objectId: `obj_${made}`,
        jobId: null,
        restoreJobId: null,
        sha256: spec.source.sha256,
        ready: false,
        environment: null,
        isolation: ISOLATION,
      };
      handles.set(spec.idempotencyKey, handle);
      return handle;
    },
    async step(_projectId: string, plan: SandboxCheckPlan, handle: SandboxCheckHandle) {
      log.push('step');
      if (!handle.ready)
        return (steps += 1) < readyAfter
          ? handle
          : {
              ...handle,
              ready: true,
              environment: {
                provider: plan.provider,
                offerId: plan.offerId,
                snapshotId: plan.snapshotId,
              },
            };
      const advanced = { ...handle, jobId: `job_${handle.sandboxId}` };
      log.push(`job ${advanced.jobId}`);
      handles.set(plan.idempotencyKey, advanced);
      return advanced;
    },
    async follow() {
      log.push('follow');
      return (
        verdicts.shift() ?? {
          state: 'running',
          result: null,
          setup: null,
          startedAt: null,
          finishedAt: null,
          usage: null,
        }
      );
    },
    async release(_projectId: string, handle: SandboxCheckHandle) {
      log.push(`release ${handle.sandboxId} ${handle.jobId} ${handle.objectId}`);
    },
  };
  return { checks, log, sources, machines: () => made };
}

type Fixture = Awaited<ReturnType<typeof baseFixture>>;

/** The project's check, written where CodeStore.configure writes it. */
async function configure(f: Fixture, check: CodeCheckSpec | null): Promise<void> {
  await f.state.transaction(async (tx) => {
    const limits = JSON.stringify({ format: 1, denyGlobs: [], secretExemptGlobs: [], check });
    const updated = await tx.run(
      'UPDATE code_projects SET limits_json=? WHERE project_id=?',
      limits,
      f.projectId,
    );
    if (!updated.changes)
      await tx.run(
        'INSERT INTO code_projects (project_id,mode,repository_id,binding_json,main_json,limits_json,warnings_json,updated_at) VALUES (?,?,?,?,?,?,?,?)',
        f.projectId,
        'local',
        'repository-bases',
        '{}',
        '{}',
        limits,
        '[]',
        new Date().toISOString(),
      );
  });
}

const row = async (f: Fixture, key: string) =>
  (await f.state.read((sql) =>
    sql.get<{
      state: string;
      check_state: string;
      check_json: string | null;
      check_job_json: string | null;
      result_json: string | null;
      conflict_json: string | null;
      blocker: string | null;
    }>(
      'SELECT state,check_state,check_json,check_job_json,result_json,conflict_json,blocker FROM code_bases WHERE project_id=? AND base_key=?',
      f.projectId,
      key,
    ),
  ))!;

const held = (f: Fixture, key: string) =>
  execFileSync(
    'git',
    ['--git-dir', f.bare, 'rev-parse', '--verify', '-q', `refs/merv/bases/${key}`],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  ).trim();
const absent = (f: Fixture, key: string) => {
  assert.throws(() => held(f, key), 'the base still holds a ref');
};

/** Merge and then advance the check until it stops moving. */
async function settle(f: Fixture, passes = 6): Promise<void> {
  for (let i = 0; i < passes; i += 1) await f.bases.work(f.projectId);
}

for (const backend of backends)
  test(
    `[${backend}] a passing check seals the base with a receipt, and the machine and its source go back`,
    optional(backend),
    async (t) => {
      const f = await baseFixture(t, backend);
      const adapter = scripted([ran(0, 'all good')]);
      f.bases.checks = adapter.checks;
      await configure(f, SPEC);
      const { a, b } = f.commits;
      const base = await f.state.transaction((tx) => f.bases.ensure(tx, f.projectId, [a, b]));
      await settle(f);
      const record = (await f.state.read((sql) => f.bases.find(sql, f.projectId, [a, b])))!;
      assert.equal(record.state, 'resolved');
      assert.equal(record.result!.method, 'auto');
      assert.equal(record.checkState, 'passed');
      const receipt = record.check!.receipt!;
      assert.equal(receipt.exitCode, 0);
      assert.equal(receipt.timedOut, false);
      assert.equal(receipt.output.head, 'all good');
      assert.deepEqual(receipt.environment, {
        provider: 'thunder_compute',
        offerId: 'a6000_x1:thunder',
        snapshotId: null,
      });
      assert.deepEqual(receipt.usage, { amount: '0.035', currency: 'USD' });
      assert.deepEqual(
        {
          network: receipt.isolation.network,
          sourceReadOnly: receipt.isolation.sourceReadOnly,
          imagePinned: receipt.isolation.imagePinned,
        },
        { network: 'on', sourceReadOnly: false, imagePinned: 'offer' },
        'the ruling’s three facts are on the record, not inferred by a reader',
      );
      assert.ok(receipt.isolation.facts.length, 'and the sentences they stand for come with them');
      assert.ok(adapter.sources[0]! > 0, 'a tree was shipped');
      assert.equal(adapter.machines(), 1, 'one machine for one base');
      assert.ok(
        adapter.log.includes(`release ${receipt.sandboxId} ${receipt.jobId} ${receipt.objectId}`),
        'the machine and the source are both given back',
      );
      assert.equal((await row(f, base.key)).check_job_json, null, 'and the handle is forgotten');
      assert.equal(held(f, base.key), record.result!.commit);
    },
  );

for (const backend of backends)
  test(
    `[${backend}] a failing check drops the auto-merge ref, so the one resolution task can seal it`,
    optional(backend),
    async (t) => {
      const f = await baseFixture(t, backend);
      const adapter = scripted([ran(7, 'two tests failed')]);
      f.bases.checks = adapter.checks;
      await configure(f, SPEC);
      const { a, b } = f.commits;
      const base = await f.state.transaction((tx) => f.bases.ensure(tx, f.projectId, [a, b]));
      await settle(f);
      const merged = await f.state.read((sql) => f.bases.find(sql, f.projectId, [a, b]));
      assert.equal(merged!.state, 'awaiting_resolution');
      assert.equal(merged!.checkState, 'failed');
      assert.equal(merged!.result, null);
      assert.deepEqual(merged!.conflict!.paths, [], 'a check failure conflicts over no path');
      assert.match(merged!.conflict!.messages, /make test/);
      assert.match(merged!.conflict!.messages, /two tests failed/);
      // The regression this whole branch turns on: acceptTask refuses a resolution whose
      // commit is not the one the ref holds, so a check-failed base must hold none.
      absent(f, base.key);
      const stored = await row(f, base.key);
      assert.equal(stored.result_json, null);
      // The dropped commit is recomputable: the merge is pinned to one identity and moment.
      const again = await f.state.read(async (sql) => {
        const [left, right] = await f.bases.inputs(sql, f.projectId, merged!);
        return { left: left!, right: right! };
      });
      assert.ok(again.left && again.right);

      // Accept a resolution that is not the auto-merge commit, exactly as a worker would.
      const resolution = execFileSync(
        'git',
        [
          '--git-dir',
          f.bare,
          'commit-tree',
          `${again.left}^{tree}`,
          '-p',
          again.left,
          '-p',
          again.right,
          '-m',
          'resolved',
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Worker',
            GIT_AUTHOR_EMAIL: 'worker@localhost',
            GIT_COMMITTER_NAME: 'Worker',
            GIT_COMMITTER_EMAIL: 'worker@localhost',
          },
        },
      ).trim();
      await f.state.transaction((tx) =>
        f.bases.linkTask(tx, f.projectId, base.key, 'task_resolution'),
      );
      await f.state.transaction(async (tx) =>
        f.bases.recordAcceptance(
          tx,
          f.projectId,
          (await f.bases.find(tx, f.projectId, [a, b]))!,
          resolution,
        ),
      );
      await f.bases.work(f.projectId);
      const sealed = (await f.state.read((sql) => f.bases.find(sql, f.projectId, [a, b])))!;
      assert.equal(sealed.state, 'resolved');
      assert.equal(sealed.result!.method, 'task');
      assert.equal(sealed.result!.commit, resolution);
      assert.equal(sealed.checkState, 'failed', 'the verdict of the automatic check stands');
      assert.equal(sealed.check!.receipt!.exitCode, 7);
      // No automatic re-check loop: the acceptance is the verification of this round.
      const jobs = adapter.log.filter((line) => line.startsWith('job ')).length;
      await settle(f, 3);
      assert.equal(
        adapter.log.filter((line) => line.startsWith('job ')).length,
        jobs,
        'no second job and no second machine',
      );
      assert.equal(adapter.machines(), 1);
    },
  );

for (const backend of backends)
  test(
    `[${backend}] a check holds its own reservation and never the project’s merge lane`,
    optional(backend),
    async (t) => {
      const f = await baseFixture(t, backend);
      // A machine that takes three passes to become ready, so the check is in flight while
      // the drain does its other work.
      const adapter = scripted([ran(0), ran(0)], 3);
      f.bases.checks = adapter.checks;
      await configure(f, SPEC);
      const { a, b, d } = f.commits;
      const first = await f.state.transaction((tx) => f.bases.ensure(tx, f.projectId, [a, b]));
      await f.bases.work(f.projectId);
      assert.equal((await row(f, first.key)).check_state, 'queued');
      const work = await f.state.read((sql) =>
        sql.all<{ provider: string; execution_epoch: number | string }>(
          'SELECT provider,execution_epoch FROM session_service_work WHERE operation_id=? ORDER BY provider',
          `${f.projectId}:${first.key}`,
        ),
      );
      assert.deepEqual(
        work.map((entry) => entry.provider),
        ['code', 'code.check'],
        'the check is its own line against the project’s capacity',
      );
      assert.equal(
        Number(work[0].execution_epoch),
        Number(work[1].execution_epoch),
        'and shares the merge’s epoch, so one disposition fences both',
      );
      // The drain reaches the next base in the same pass rather than waiting on a machine:
      // what stops it here is the project's own capacity, said in the blocker.
      const second = await f.state.transaction((tx) => f.bases.ensure(tx, f.projectId, [b, d]));
      await f.bases.work(f.projectId);
      const waiting = await row(f, second.key);
      assert.equal(waiting.state, 'retry_wait');
      assert.equal(waiting.blocker, 'capacity_full');
      assert.equal((await row(f, first.key)).state, 'running', 'the first is still checking');
      // Once the first check settles its line, the second base takes it and runs its own.
      await settle(f, 10);
      assert.equal((await row(f, first.key)).check_state, 'passed');
      f.advance(120_000);
      await settle(f, 10);
      assert.equal((await row(f, second.key)).check_state, 'passed');
      assert.equal(adapter.machines(), 2, 'one machine each, never two at once');
    },
  );

for (const backend of backends)
  test(
    `[${backend}] a suspended check gives its machine back, and a quarantine keeps a recorded verdict`,
    optional(backend),
    async (t) => {
      const f = await baseFixture(t, backend);
      const adapter = scripted([], 1000);
      f.bases.checks = adapter.checks;
      await configure(f, SPEC);
      const { a, b } = f.commits;
      const base = await f.state.transaction((tx) => f.bases.ensure(tx, f.projectId, [a, b]));
      await settle(f, 2);
      assert.ok((await row(f, base.key)).check_job_json, 'a machine is named on the row');
      await f.bases.control(f.scope, f.admin, {
        key: base.key,
        action: 'suspend',
        reason: 'the operator stops this base',
        requestId: 'req-suspend',
      });
      const suspended = await row(f, base.key);
      assert.equal(suspended.check_state, 'none', 'a check with no verdict is put back');
      assert.ok(suspended.check_job_json, 'and the handle stays so the machine can be reclaimed');
      await f.bases.work(f.projectId);
      assert.ok(
        adapter.log.some((line) => line.startsWith('release sbx_1')),
        'the next pass cancels the job, deletes the machine and deletes the source',
      );
      assert.equal((await row(f, base.key)).check_job_json, null);

      // A resolved base whose check passed keeps its verdict through an operator's quarantine.
      const passing = scripted([ran(0)]);
      f.bases.checks = passing.checks;
      await f.bases.control(f.scope, f.admin, {
        key: base.key,
        action: 'resume',
        reason: 'back to work',
        requestId: 'req-resume',
      });
      await settle(f);
      assert.equal((await row(f, base.key)).check_state, 'passed');
      await f.bases.control(f.scope, f.admin, {
        key: base.key,
        action: 'quarantine',
        reason: 'the operator distrusts this base',
        requestId: 'req-quarantine',
      });
      const quarantined = await row(f, base.key);
      assert.equal(quarantined.check_state, 'passed', 'a recorded verdict is never unwritten');
      assert.ok(quarantined.check_json);
    },
  );

for (const backend of backends)
  test(
    `[${backend}] the database refuses an unpaired verdict, a second verdict and an unresolved seal`,
    optional(backend),
    async (t) => {
      const f = await baseFixture(t, backend);
      f.bases.checks = scripted([ran(0)]).checks;
      await configure(f, SPEC);
      const { a, b } = f.commits;
      const base = await f.state.transaction((tx) => f.bases.ensure(tx, f.projectId, [a, b]));
      await settle(f);
      const update = (set: string, ...args: (string | null)[]) =>
        f.state.transaction((tx) =>
          tx.run(
            `UPDATE code_bases SET ${set} WHERE project_id=? AND base_key=?`,
            ...args,
            f.projectId,
            base.key,
          ),
        );
      // SQLite says which rule refused; PostgreSQL does not disclose the constraint, so what
      // both prove is that each of the three is refused by the database and not by a service.
      const said = (sqlite: RegExp) => (backend === 'sqlite' ? sqlite : /constraint/);
      await assert.rejects(
        update("check_state='none'"),
        said(/recorded together/),
        'a receipt without its verdict is refused',
      );
      await assert.rejects(
        update('check_json=?', JSON.stringify({ state: 'passed' })),
        said(/recorded once/),
        'a second verdict is refused',
      );
      await assert.rejects(
        update("check_state='failed'"),
        said(/accepted resolution/),
        'a failed check cannot stand on a sealed base without a resolution',
      );
    },
  );

for (const backend of backends)
  test(
    `[${backend}] a configured command with no adapter leaves the base unsealed for an operator`,
    optional(backend),
    async (t) => {
      const f = await baseFixture(t, backend);
      await configure(f, SPEC);
      const { a, b } = f.commits;
      const base = await f.state.transaction((tx) => f.bases.ensure(tx, f.projectId, [a, b]));
      await settle(f, 3);
      const blocked = await row(f, base.key);
      assert.equal(blocked.state, 'blocked_infra');
      assert.equal(blocked.check_state, 'unavailable');
      assert.equal(blocked.check_json, null, 'nothing was verified, so nothing is recorded');
      assert.equal(blocked.result_json, null, 'and the base is not sealed as verified');
      assert.match(blocked.blocker!, /^code_check_unavailable: /);
      // code.base.retry is already the remedy: no operator verb is added for this.
      const adapter = scripted([ran(0)]);
      f.bases.checks = adapter.checks;
      await f.bases.control(f.scope, f.admin, {
        key: base.key,
        action: 'retry',
        reason: 'the sandbox connection is configured now',
        requestId: 'req-retry',
      });
      await settle(f);
      const sealed = await row(f, base.key);
      assert.equal(sealed.state, 'resolved');
      assert.equal(sealed.check_state, 'passed');
      assert.equal(adapter.machines(), 1);
    },
  );

for (const backend of backends)
  test(
    `[${backend}] a timeout is a verdict, and a job with no result is infrastructure`,
    optional(backend),
    async (t) => {
      const f = await baseFixture(t, backend);
      // The command's own clock is the wrapper's, so an overrun comes back as a written
      // result the adapter names as a timeout. A job that wrote nothing outran its setup.
      const adapter = scripted([
        {
          state: 'timed_out',
          result: { exit: 124, bytes: 0, head: '', tail: '' },
          setup: null,
          startedAt: null,
          finishedAt: null,
          usage: null,
        },
      ]);
      f.bases.checks = adapter.checks;
      await configure(f, SPEC);
      const { a, b } = f.commits;
      const timed = await f.state.transaction((tx) => f.bases.ensure(tx, f.projectId, [a, b]));
      await settle(f);
      const stopped = await row(f, timed.key);
      assert.equal(stopped.state, 'awaiting_resolution');
      assert.equal(stopped.check_state, 'failed');
      assert.equal(JSON.parse(stopped.check_json!).receipt.timedOut, true);
      assert.equal(adapter.machines(), 1, 'one rental, one verdict: a timeout is not retried');

      // A terminal job that wrote no result judged nothing, so nobody is asked to resolve it.
      const g = await baseFixture(t, backend);
      const broken = scripted([
        {
          state: 'failed',
          result: null,
          setup: 'the downloaded source did not match its digest',
          startedAt: null,
          finishedAt: null,
          usage: null,
        },
      ]);
      g.bases.checks = broken.checks;
      await configure(g, SPEC);
      const base = await g.state.transaction((tx) =>
        g.bases.ensure(tx, g.projectId, [g.commits.a, g.commits.b]),
      );
      await settle(g);
      const unsealed = await row(g, base.key);
      assert.equal(unsealed.check_state, 'none');
      assert.notEqual(unsealed.state, 'awaiting_resolution');
      assert.match(unsealed.blocker!, /digest/);
    },
  );

for (const backend of backends)
  test(
    `[${backend}] an interrupted first step rents nothing twice, and no command means no machine`,
    optional(backend),
    async (t) => {
      const f = await baseFixture(t, backend);
      const adapter = scripted([ran(0)]);
      f.bases.checks = adapter.checks;
      await configure(f, SPEC);
      const { a, b } = f.commits;
      const base = await f.state.transaction((tx) => f.bases.ensure(tx, f.projectId, [a, b]));
      await settle(f, 2);
      assert.ok((await row(f, base.key)).check_job_json, 'the machine is named on the row');
      // A crash between shipping the source and recording what it reached: the epoch has not
      // moved, so the step repeats under the same key and finds the same machine.
      await f.state.transaction((tx) =>
        tx.run(
          'UPDATE code_bases SET check_job_json=NULL WHERE project_id=? AND base_key=?',
          f.projectId,
          base.key,
        ),
      );
      await settle(f);
      const keys = new Set(
        adapter.log.filter((line) => line.startsWith('start ')).map((line) => line.slice(6)),
      );
      assert.equal(keys.size, 1, 'the repeated step asked under the same key');
      assert.equal(adapter.machines(), 1, 'and rented nothing twice');
      assert.equal((await row(f, base.key)).check_state, 'passed');

      // With no command nothing is rented at all and the record is the pre-slice one.
      const g = await baseFixture(t, backend);
      const quiet = scripted([ran(0)]);
      g.bases.checks = quiet.checks;
      await configure(g, null);
      await g.state.transaction((tx) =>
        g.bases.ensure(tx, g.projectId, [g.commits.a, g.commits.b]),
      );
      await settle(g, 2);
      const skipped = (await g.state.read((sql) =>
        g.bases.find(sql, g.projectId, [g.commits.a, g.commits.b]),
      ))!;
      assert.equal(skipped.state, 'resolved');
      assert.equal(skipped.checkState, 'skipped');
      assert.equal(skipped.check!.reason, 'no-command');
      assert.equal(quiet.machines(), 0, 'no command, no machine');
    },
  );

for (const backend of backends)
  test(
    `[${backend}] an unbound adapter keeps the handle, and withdrawing the command seals the base`,
    optional(backend),
    async (t) => {
      const f = await baseFixture(t, backend);
      const adapter = scripted([], 1000);
      f.bases.checks = adapter.checks;
      await configure(f, SPEC);
      const { a, b } = f.commits;
      const base = await f.state.transaction((tx) => f.bases.ensure(tx, f.projectId, [a, b]));
      await settle(f, 2);
      const machine = (await row(f, base.key)).check_job_json;
      assert.ok(machine, 'a machine is named on the row');
      // The sandboxes plugin is disposed while the machine is out. The handle is the only
      // name Merv holds for it, so a drain with no adapter must not forget it.
      f.bases.checks = undefined;
      await f.bases.control(f.scope, f.admin, {
        key: base.key,
        action: 'suspend',
        reason: 'the operator stops this base',
        requestId: 'req-unbound',
      });
      await settle(f, 2);
      assert.equal(
        (await row(f, base.key)).check_job_json,
        machine,
        'the rented machine is still nameable when an adapter comes back',
      );

      // An operator who turns verification off mid-check has said no verification is wanted;
      // the merge is already complete, so the base seals as one with no command does.
      f.bases.checks = adapter.checks;
      await f.bases.control(f.scope, f.admin, {
        key: base.key,
        action: 'resume',
        reason: 'back to work',
        requestId: 'req-unbound-resume',
      });
      await settle(f, 2);
      assert.ok((await row(f, base.key)).check_job_json, 'a second machine is out');
      await configure(f, null);
      await settle(f);
      const sealed = await row(f, base.key);
      assert.equal(sealed.state, 'resolved');
      assert.equal(sealed.check_state, 'skipped');
      assert.equal(JSON.parse(sealed.check_json!).reason, 'no-command');
      assert.equal(sealed.check_job_json, null, 'and the machine went back');
      assert.ok(adapter.log.some((line) => line.startsWith('release ')));
    },
  );

test('the wrapper carries the command once and reports its verdict in the result, never the exit', () => {
  const script = checkScript(
    "make test && echo 'done'",
    'https://bucket.invalid/o?sig=1',
    'a'.repeat(64),
    600,
  );
  assert.equal(script.match(/make test && echo/g)!.length, 1);
  assert.match(script, /'https:\/\/bucket\.invalid\/o\?sig=1'/);
  assert.match(script, new RegExp(`'${'a'.repeat(64)}'`));
  for (const code of [121, 122, 123, 124, 125]) assert.match(script, new RegExp(`exit ${code}`));
  // The command has a clock of its own, so its overrun is a written result and the job's own
  // timeout can only mean the download and unpack outran their separate allowance.
  assert.match(script, /timeout 600 sh -c /);
  assert.ok(!script.includes('/workspace'), 'and it works where the service guarantees it can');
  assert.match(script, /\$HOME\/merv-check/);
  assert.ok(
    script.indexOf('SBX_RESULT_PATH') < script.indexOf('curl'),
    'a machine that gave the job no result path is said once, not rediscovered by re-renting',
  );
  assert.ok(
    script.indexOf('SBX_RESULT_PATH') < script.lastIndexOf('exit 0'),
    'the result is written before the wrapper reports success',
  );
  assert.ok(script.trimEnd().endsWith('exit 0'), 'so no command can impersonate a setup failure');
  assert.ok(!script.includes('export '), 'and nothing of Merv’s is put in the environment');
});

test('a failing check replaces both Git headings in the brief with what has to pass', () => {
  const base = {
    checkState: 'failed' as const,
    conflict: { paths: [], messages: '' },
    check: {
      state: 'failed' as const,
      spec: SPEC,
      receipt: {
        sandboxId: 'sbx_1',
        jobId: 'job_1',
        objectId: 'obj_1',
        exitCode: 7,
        timedOut: false,
        startedAt: null,
        finishedAt: null,
        output: { head: 'FAIL test_one', tail: '', bytes: 13 },
        environment: { provider: 'thunder_compute', offerId: 'a6000_x1:thunder', snapshotId: null },
        usage: null,
        isolation: ISOLATION,
      },
      reason: null,
      at: '2026-09-22T00:00:00.000Z',
    },
  } as unknown as Parameters<typeof checkBriefSections>[0];
  const sections = checkBriefSections(base)!;
  assert.match(sections[0], /^Project check:/);
  assert.match(sections[0], /make test/);
  assert.match(sections[1], /^Check output:/);
  assert.match(sections[1], /FAIL test_one/);
  assert.match(checkResolutionCheck(base)!, /failed with exit 7/);
  assert.equal(
    checkBriefSections({ ...base, checkState: 'passed' } as typeof base),
    null,
    'a Git conflict keeps Git’s own headings',
  );
});
