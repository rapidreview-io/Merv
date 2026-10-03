import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { Caller, Data } from '@merv/contracts';
import { MachineRunner } from '@merv/runner';
import { CodeWorkspaceDriver } from '@merv/code/driver/index';
import { CodeRepositories } from '@merv/code/store/repository';
import { createApp } from './fixtures/app.js';
import { waitForManagedCode } from './fixtures/managed-code.js';
import { git } from './fixtures/code-store.js';
import { reviewedFindings } from './fixtures/task-evidence.js';

type App = Awaited<ReturnType<typeof createApp>>;
/** What the server makes a runner wait after a close it counted; sessions' dispatch backoff. */
const dispatchBackoffMs = 30_000;
/** What one control call costs when it has to be abandoned; the runner client's own timeout. */
const controlTimeoutMs = 10_000;
/**
 * How long one wait of this test may take. It must outlast a backoff and an abandoned call,
 * or a single counted close reads here as a mute timeout instead of the outcome this test
 * asserts a few lines further down.
 */
const waitMs = dispatchBackoffMs + controlTimeoutMs + 5_000;
interface Worker {
  cwd: string;
  assignment: Data;
  tool<T = Data>(name: string, input: Data): Promise<T>;
  /** A tool call that closes this worker's session by handing off; see `step`. */
  handoff(name: string, input: Data): Promise<Data>;
  write(path: string, content: string | null): Promise<void>;
  read(path: string): Promise<string | null>;
  git(...args: string[]): Promise<string>;
}

/** One machine: a runner with its own ledger and credential, and the workers the test plays on it. */
function machine(
  t: TestContext,
  app: App,
  root: string,
  name: string,
  token: string,
  owner: Caller,
  fetcher?: typeof fetch,
) {
  const credentialEnv = `MERV_V2_INTEGRATION_${name.toUpperCase()}`;
  const previous = process.env[credentialEnv];
  process.env[credentialEnv] = token;
  const control = join(root, `${name}-control`);
  // A command profile has no sandbox and may not take a read-only lease, so the puppet
  // stands in for an agent CLI: a script that ignores that CLI's arguments.
  const executable = join(root, `${name}-agent.sh`);
  writeFileSync(
    executable,
    `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(
      new URL('./fixtures/runner-puppet-worker.mjs', import.meta.url),
    )}" "${control}"\n`,
    { mode: 0o700 },
  );
  const runner = new MachineRunner(
    {
      directory: join(root, name),
      baseUrl: app.ctx.api.url!,
      projectId: owner.projectId,
      credentialEnv,
      profiles: [
        {
          name: 'worker',
          harness: 'claude',
          executable,
          enabled: true,
          parallelism: 1,
        },
      ],
    },
    {
      autoPoll: false,
      ...(fetcher ? { fetch: fetcher } : {}),
      drivers: [
        {
          name: 'code.v2',
          create: (host, transport) => new CodeWorkspaceDriver(host, transport, { pollMs: 25 }),
        },
      ],
    },
  );
  t.after(async () => {
    await runner.stop();
    if (previous === undefined) delete process.env[credentialEnv];
    else process.env[credentialEnv] = previous;
  });
  const seen = new Set<string>();
  const until = async <T>(
    what: string,
    found: () => T | undefined | Promise<T | undefined>,
    { tick = true } = {},
  ) => {
    const deadline = Date.now() + waitMs;
    for (;;) {
      if (tick) await runner.tick();
      const value = await found();
      if (value !== undefined) return value;
      assert.ok(
        Date.now() < deadline,
        `${name}: ${what}: ${JSON.stringify(runner.snapshot())} ${JSON.stringify(
          (
            await app.ctx.state.read(
              async (sql) =>
                await sql.all<{ session_json: string }>('SELECT session_json FROM worker_sessions'),
            )
          ).map((row) => {
            const session = JSON.parse(row.session_json) as Data;
            return [session.role, session.status, session.outcome, session.closeReason];
          }),
        )}`,
      );
      await delay(40);
    }
  };
  return {
    runner,
    until,
    /** Tick until this machine has launched a worker the test has not played yet. */
    async worker(): Promise<Worker> {
      const directory = await until('a worker starts', () => {
        const next = (existsSync(control) ? readdirSync(control) : []).find(
          (entry) => !seen.has(entry) && existsSync(join(control, entry, 'ready.json')),
        );
        return next && join(control, next);
      });
      seen.add(directory.slice(control.length + 1));
      const ready = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8')) as {
        cwd: string;
        assignment: Data;
      };
      let steps = 0;
      const step = async <T>(input: Data, { handoff = false } = {}): Promise<T> => {
        const number = ++steps;
        // The worker polls for this file and reads it whole. A plain write is visible from the
        // moment it is created, so under load its reader beats its bytes; the step arrives as
        // an empty file and the worker dies on it. Hand it over the way the worker hands its
        // answers back: written aside, then named in one step.
        const handover = join(directory, `step-${number}.json`);
        writeFileSync(`${handover}.part`, JSON.stringify(input));
        renameSync(`${handover}.part`, handover);
        // A handoff closes the session as it commits, before its reply reaches the worker. A
        // tick that saw the session closed would stop this 'claude'-harness launch at once
        // (handoffGraceMs is 0 for it), which may kill the worker before it writes the reply.
        // So the runner does not tick until the reply is in; nothing on the server waits on it.
        const result = await until(
          `step ${JSON.stringify(input).slice(0, 120)}`,
          () => {
            const file = join(directory, `step-${number}.result.json`);
            return existsSync(file)
              ? (JSON.parse(readFileSync(file, 'utf8')) as {
                  ok: boolean;
                  value: T;
                  error?: string;
                })
              : undefined;
          },
          { tick: !handoff },
        );
        assert.ok(result.ok, `${name}: ${JSON.stringify(input).slice(0, 200)}: ${result.error}`);
        return result.value;
      };
      return {
        ...ready,
        tool: (tool, input) => step({ kind: 'tool', name: tool, input }),
        handoff: (tool, input) => step({ kind: 'tool', name: tool, input }, { handoff: true }),
        write: (path, content) => step({ kind: 'write', path, content }),
        read: (path) => step({ kind: 'read', path }),
        git: (...args) => step({ kind: 'git', args }),
      };
    },
    /** Whether this machine asks for new work; what it already runs is finished either way. */
    async accepting(enabled: boolean) {
      const presence = (await app.ctx.sessions.projectStatus(owner)).runners.find(
        (item) => item.runnerId === runner.snapshot().runnerId,
      )!;
      await app.ctx.sessions.setRunnerSettings(owner, {
        runnerId: presence.id,
        settings: { platforms: [{ name: 'worker', enabled, parallelism: 1 }] },
      });
      await runner.tick();
    },
    /** Tick until every launch of this machine has handed over and closed its checkout. */
    settled: async () =>
      await until('its checkouts close', () =>
        runner
          .snapshot()
          .launches.every(
            (launch) => launch.workspace?.status === 'closed' && !launch.releasePending,
          )
          ? true
          : undefined,
      ),
  };
}

test(
  'a default task without GitHub crosses machines, resumes retained changes, passes independent review and integrates into managed main',
  { timeout: 3 * waitMs },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'merv-v2-'));
    const app = await createApp({ directory: join(root, 'server'), api: true, port: 0 });
    t.after(async () => {
      await app.stop();
      rmSync(root, { recursive: true, force: true });
    });
    const boot = await app.ctx.scope.bootstrap({ projectName: 'Hosted', actorName: 'Owner' });
    const owner: Caller = {
      projectId: boot.project.id,
      actorId: boot.actor.id,
      credentialId: boot.credential.id,
    };
    const { codeWork: code, tasks, sessions, reviews, state } = app.ctx;

    const initial = await waitForManagedCode(code, owner);
    const main = initial.project!.main.oid;
    assert.equal(initial.store?.source, 'managed');
    assert.equal((await code.github.status(owner)).repository, null);
    assert.equal((await code.status(owner)).project?.durability, 'code');

    const task = await tasks.create(owner, {
      title: 'Harness',
      goal: 'Build the harness.',
      checks: ['It runs'],
      requestId: 'hosted',
    });
    assert.equal(
      task.workflow.version,
      31,
      'new Git work lives in Code once the project is hosted',
    );

    await state.transaction((tx) => code.publishOnAcceptance(owner, { unitId: task.id }, tx));

    let finalizes = 0;
    let dropped = false;
    const issue = async (name: string) =>
      (await app.ctx.scope.issueActor(owner, { name, role: 'operator' })).token;
    const a = machine(t, app, root, 'a', await issue('Machine A'), owner, async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).endsWith('/code/v2/finalize') && response.ok) {
        finalizes++;
        if (!dropped) {
          dropped = true;
          throw new TypeError('Lost the reply to a final capture Code admitted');
        }
      }
      return response;
    });
    const b = machine(t, app, root, 'b', await issue('Machine B'), owner);
    await a.runner.start();
    await b.runner.start();
    // Work is independent of the agent that made it, not of its machine, so the test says
    // which machine asks for work: otherwise whichever ticks first takes the next lease.
    await b.accepting(false);
    await sessions.setDispatch(owner, { enabled: true });
    const unit = async () => await code.unit(owner, task.id);
    const commit = async (worker: Worker, requestId: string) => {
      const expectedHead = await worker.git('rev-parse', 'HEAD');
      let operation = await worker.tool<Data>('code.commit', {
        expectedHead,
        message: `Record ${requestId}`,
        requestId,
      });
      while (operation.status !== 'succeeded') {
        assert.ok(
          ['queued', 'dispatched'].includes(String(operation.status)),
          JSON.stringify(operation),
        );
        operation = await worker.tool<Data>('code.operation', {
          commandId: (operation.command as Data).id,
        });
      }
      return operation as {
        command: { id: string };
        receipt: { headOid: string; parentOid: string };
      };
    };
    const deliver = async (worker: Worker, commandId: string, requestId: string) => {
      const evidence = await worker.tool<{ id: string }>('artifact.create', {
        title: `Evidence ${requestId}`,
        content: 'The harness ran end to end.',
      });
      await worker.handoff('task.submit_delivery', {
        taskId: task.id,
        artifactIds: [evidence.id],
        commandId,
        confirmations: [
          { checkNumber: 1, status: 'met', evidenceIds: [evidence.id], notes: 'Ran it here.' },
        ],
        expectedRevision: (await tasks.get(owner, task.id)).workflow.revision,
        requestId,
      });
    };
    const verdict = async (worker: Worker, value: 'pass' | 'needs_changes') => {
      const current = await tasks.get(owner, task.id);
      const review = await reviews.get(owner, current.reviewId!);
      await worker.handoff('review.submit', {
        ...reviewedFindings(review),
        reviewId: review.id,
        claimId: review.claimId!,
        verdict: value,
        notes: 'Checked out the delivered commit and ran the harness.',
        expectedRevision: current.workflow.revision,
        requestId: `verdict-${value}`,
      });
    };

    // Machine A: generation 1 commits, leaves trailing work behind and hands off.
    const first = await a.worker();
    await a.accepting(false);
    assert.equal(await first.git('rev-parse', 'HEAD'), main);
    assert.equal(await first.git('symbolic-ref', '--short', 'HEAD'), `merv/work/${task.id}`);
    assert.equal((await unit()).generation, 1);
    await first.write('harness.txt', 'one\n');
    const delivered = await commit(first, 'first');
    assert.equal(delivered.receipt.parentOid, main);
    assert.equal((await unit()).canonicalHead, delivered.receipt.headOid);
    await first.write('notes.txt', 'left uncommitted by machine A\n');
    await deliver(first, delivered.command.id, 'delivery-1');
    await a.settled();
    assert.ok(dropped && finalizes >= 2, 'the lost reply to the final capture was replayed');
    const afterFirst = await unit();
    assert.equal(afterFirst.writerState, 'closed');
    assert.notEqual(afterFirst.canonicalHead, delivered.receipt.headOid);
    const repository = new CodeRepositories({
      root: join(root, 'server', 'code'),
      quotaBytes: 0,
      reservedFreeBytes: 0,
    }).paths(owner.projectId).repository;
    assert.equal(
      git(repository, ['rev-parse', `${afterFirst.canonicalHead}~1`]),
      delivered.receipt.headOid,
    );

    // Machine B reviews exactly the delivered commit: none of the trailing work is there.
    await b.accepting(true);
    const reviewer = await b.worker();
    await b.accepting(false);
    assert.equal(await reviewer.git('rev-parse', 'HEAD'), delivered.receipt.headOid);
    assert.equal(await reviewer.read('notes.txt'), null);
    assert.equal(await reviewer.read('harness.txt'), 'one\n');
    await verdict(reviewer, 'needs_changes');
    await b.settled();

    // Machine B resumes as generation 2, from the head that includes what machine A left.
    await b.accepting(true);
    const second = await b.worker();
    await b.accepting(false);
    assert.equal((await unit()).generation, 2);
    assert.equal(await second.git('rev-parse', 'HEAD'), afterFirst.canonicalHead);
    assert.equal(await second.read('notes.txt'), 'left uncommitted by machine A\n');
    await second.write('harness.txt', 'two\n');
    const revised = await commit(second, 'second');
    assert.equal(revised.receipt.parentOid, afterFirst.canonicalHead);
    await deliver(second, revised.command.id, 'delivery-2');
    await b.settled();

    // Machine A reviews the revision at exactly its commit, and passes it.
    await a.accepting(true);
    const final = await a.worker();
    await a.accepting(false);
    assert.equal(await final.git('rev-parse', 'HEAD'), revised.receipt.headOid);
    await verdict(final, 'pass');
    await a.settled();

    assert.equal((await tasks.get(owner, task.id)).workflow.state, 'done');
    const accepted = (await unit()).acceptance!;
    assert.equal(accepted.storage, 'code');
    assert.equal(accepted.reference, revised.receipt.headOid);
    assert.equal(accepted.reviewAttached, true);
    assert.ok(accepted.receipt);
    await a.until('the accepted ref is written', () =>
      git(repository, [
        'for-each-ref',
        '--format=%(objectname)',
        `refs/merv/accepted/${task.id}`,
      ]) === revised.receipt.headOid
        ? true
        : undefined,
    );

    // The work's retries and handoffs did not count as execution failures.
    const all = await sessions.list(owner);
    assert.deepEqual(
      all.map((session) => session.outcome).filter((outcome) => outcome !== 'completed'),
      [],
    );
    assert.deepEqual(
      await state.read(async (sql) => await sql.all('SELECT * FROM session_dispatch_holds')),
      [],
    );
    await code.syncPublications(owner);
    await a.until('reviewed local integration', async () =>
      (await code.status(owner)).project?.main.oid === revised.receipt.headOid ? true : undefined,
    );
    const [publication] = await code.publications(owner);
    assert.equal(publication.destination, 'local');
    assert.equal(publication.verified, true);
    assert.equal((await code.github.status(owner)).repository, null);
    const finals = await state.read(
      async (sql) =>
        await sql.all<{ data_json: string }>(
          "SELECT data_json FROM events WHERE type='code.capture_admitted' ORDER BY id",
        ),
    );
    assert.equal(
      finals.filter((row) => (JSON.parse(row.data_json) as { final: boolean }).final).length,
      2,
      'one final capture for each writer generation, however often it was sent',
    );
  },
);
