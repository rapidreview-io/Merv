import { CodeWorkspaceDriver } from '@merv/code/driver/index';
import { CodeRepositories } from '@merv/code/store/repository';
import { NATIVE_CODE_DRIVER, type Caller, type Data } from '@merv/contracts';
import { MachineRunner } from '@merv/runner';
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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createApp } from './fixtures/app.js';
import { git } from './fixtures/code-store.js';
import { waitForManagedCode } from './fixtures/managed-code.js';

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
  finish(): Promise<void>;
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
          name: NATIVE_CODE_DRIVER,
          create: (host, transport) => new CodeWorkspaceDriver(host, transport),
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
        finish: () => step({ kind: 'exit' }),
      };
    },
    /** Whether this machine asks for new work; what it already runs is finished either way. */
    async accepting(enabled: boolean) {
      const presence = (await app.ctx.sessions.dispatch.projectStatus(owner)).runners.find(
        (item) => item.runnerId === runner.snapshot().runnerId,
      )!;
      await app.ctx.sessions.dispatch.setRunnerSettings(owner, {
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
  'native Git session closure creates no commit; planned shutdown retains dirty files once after a lost acknowledgement',
  { timeout: 3 * waitMs },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'merv-native-runner-'));
    const app = await createApp({ directory: join(root, 'server'), api: true, port: 0 });
    t.after(async () => {
      await app.stop();
      rmSync(root, { recursive: true, force: true });
    });
    const boot = await app.ctx.scope.credentials.bootstrap({
      projectName: 'Native runner',
      actorName: 'Owner',
    });
    const owner: Caller = {
      projectId: boot.project.id,
      actorId: boot.actor.id,
      credentialId: boot.credential.id,
    };
    const { codeWork: code, tasks, sessions, state } = app.ctx;
    const main = (await waitForManagedCode(code, owner)).project!.main.oid;
    const brief = await app.ctx.artifacts.create(owner, {
      title: 'Harness brief',
      content: 'Build the harness. It runs.',
    });
    const task = await tasks.create(owner, {
      title: 'Harness',
      goal: 'Build the harness.',
      checks: ['It runs'],
      briefId: brief.id,
      requestId: 'native-runner',
    });
    assert.equal(task.workflow.version, 46);
    let finalAcknowledgements = 0;
    let dropped = false;
    const token = (
      await app.ctx.scope.credentials.issueActor(owner, {
        name: 'Native machine',
        role: 'operator',
      })
    ).token;
    const host = machine(t, app, root, 'native', token, owner, async (input, init) => {
      const response = await fetch(input, init);
      if (
        String(input).endsWith('/code/v2/pushed') &&
        response.ok &&
        JSON.parse(String(init?.body ?? '{}')).kind === 'final'
      ) {
        finalAcknowledgements++;
        if (!dropped) {
          dropped = true;
          throw new TypeError('Lost the acknowledgement after the native Git capture was retained');
        }
      }
      return response;
    });
    await host.runner.start();
    await sessions.dispatch.setDispatch(owner, { enabled: true });
    const worker = await host.worker();
    await host.accepting(false);
    assert.equal(await worker.git('rev-parse', 'HEAD'), main);
    assert.equal(await worker.git('symbolic-ref', '--short', 'HEAD'), `merv/work/${task.id}`);
    await worker.write('harness.txt', 'agent commit\n');
    await worker.git('add', 'harness.txt');
    await worker.git(
      '-c',
      'user.name=Native agent',
      '-c',
      'user.email=agent@example.test',
      'commit',
      '-m',
      'Build harness',
    );
    const committed = await worker.git('rev-parse', 'HEAD');
    await worker.git('push', 'merv', 'HEAD');
    assert.equal((await code.unit(owner, task.id)).canonicalHead, committed);
    await worker.write('notes.txt', 'remaining work for shutdown\n');
    await worker.finish();
    await host.settled();
    assert.equal(
      git(worker.cwd, ['rev-parse', 'HEAD']),
      committed,
      'ordinary close made no commit',
    );
    assert.equal(
      readFileSync(join(worker.cwd, 'notes.txt'), 'utf8'),
      'remaining work for shutdown\n',
    );
    assert.equal((await code.unit(owner, task.id)).canonicalHead, committed);
    assert.equal((await code.unit(owner, task.id)).writerState, 'closed');
    assert.equal(finalAcknowledgements, 0, 'ordinary close did not request a shutdown capture');

    await assert.rejects(host.runner.prepareShutdown());
    assert.equal(dropped, true);
    const receipt = await host.runner.prepareShutdown();
    assert.equal(receipt.empty, false);
    assert.equal(receipt.captures.length, 1);
    assert.deepEqual(await host.runner.prepareShutdown(), receipt);
    assert.ok(finalAcknowledgements >= 2, 'the retained push acknowledgement was replayed');
    const capture = receipt.captures[0]!;
    assert.equal(capture.unitId, task.id);
    assert.notEqual(capture.headOid, committed);
    const repository = new CodeRepositories({
      root: join(root, 'server', 'code'),
      quotaBytes: 0,
      reservedFreeBytes: 0,
    }).paths(owner.projectId).repository;
    assert.equal(git(repository, ['rev-parse', `${capture.headOid}^`]), committed);
    assert.equal(git(repository, ['rev-parse', `${capture.headOid}^{tree}`]), capture.treeOid);
    assert.equal(
      git(repository, ['show', `${capture.headOid}:notes.txt`]),
      'remaining work for shutdown',
    );
    assert.equal(git(repository, ['rev-list', '--count', `${committed}..${capture.headOid}`]), '1');
    assert.equal((await code.unit(owner, task.id)).canonicalHead, capture.headOid);
    const finals = await state.read((sql) =>
      sql.all<{ id: string }>(
        "SELECT id FROM code_operations WHERE project_id=? AND unit_id=? AND kind='upload' AND status='completed' AND (payload_json::jsonb)->>'kind'='final'",
        owner.projectId,
        task.id,
      ),
    );
    assert.deepEqual(
      finals.map((row) => row.id),
      [capture.operationId],
    );
  },
);
