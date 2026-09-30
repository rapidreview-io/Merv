import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkspaceDriverFactory, WorkspaceHandle } from '@merv/contracts';
import { MachineRunner, type RunnerConfig } from '../packages/runner/src/index.js';
import { LocalLedger, terminalLaunch, type LaunchMetadata } from '../packages/runner/src/ledger.js';
import type { ProcessHost } from '../packages/runner/src/process-host.js';
import { offer, server } from './fixtures/runner-stand-in.js';

const binary =
  process.env.MERV_RUNNER_SETTLEMENT_LEAN_BINARY ??
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../verification/lean/.lake/build/bin/runner_settlement_model',
  );
const options = {
  skip:
    !existsSync(binary) && process.env.MERV_REQUIRE_LEAN !== '1'
      ? 'Build runner_settlement_model'
      : undefined,
};
type Answer = 'complete' | 'retry' | 'crash' | 'final';
type Command =
  | {
      kind: 'poll';
      release?: Answer;
      capture?: boolean;
      receipt?: Answer;
      result?: Answer;
      close?: boolean;
    }
  | { kind: 'restart' }
  | { kind: 'driver'; present: boolean }
  | { kind: 'terminate'; evidence: boolean };
type Initial = { terminal?: boolean; workspace?: boolean; driver?: boolean };
type Observation = {
  terminal: boolean;
  driver: boolean;
  workspace: boolean;
  release: { done: boolean; calls: number };
  receipt: { done: boolean; calls: number };
  result: { done: boolean; calls: number };
  captured: boolean;
  closed: boolean;
  settled: boolean;
  captures: number;
  closes: number;
};
function model(commands: Command[], initial: Initial = {}): Observation[] {
  const result = spawnSync(binary, [], {
    encoding: 'utf8',
    input: JSON.stringify({ commands, initial }),
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).observations;
}

/** Lifecycle-only scratch driver with a durable abstract receipt journal. It creates no
 * checkout, imports no Code implementation, and assumes nothing about Git correctness. */
async function implementation(
  commands: Command[],
  initial: Initial = {},
  mutation?: 'release-marker' | 'receipt-marker' | 'result-marker' | 'uncertain-settlement',
) {
  const root = mkdtempSync(join(tmpdir(), 'merv-runner-lean-settle-'));
  const credentialEnv = `MERV_LEAN_SETTLE_${process.pid}`;
  const source = `mk_${'j'.repeat(43)}`;
  process.env[credentialEnv] = source;
  const config: RunnerConfig = {
    directory: join(root, 'machine'),
    baseUrl: 'http://127.0.0.1:9',
    projectId: 'project_fixture',
    credentialEnv,
    profiles: [
      {
        name: 'lean',
        harness: 'codex',
        executable: process.execPath,
        isolatedLauncher: process.execPath,
        enabled: false,
        parallelism: 1,
      },
    ],
    oneAssignment: true,
    capacity: 1,
  };
  const binding = {
    baseUrl: config.baseUrl,
    projectId: config.projectId,
    sourceId: createHash('sha256').update(source).digest('hex'),
  };
  const ledger = new LocalLedger({ directory: config.directory, binding });
  const work = offer('lean_settlement');
  work.runnerId = ledger.runnerId;
  work.hostRef = 'launch';
  work.status = 'released';
  const snapshot = {
    repositoryId: 'repository_abstract',
    workspaceId: 'workspace_abstract',
    mode: 'ephemeral' as const,
    branch: null,
    baseOid: '1'.repeat(40),
    headOid: '2'.repeat(40),
    stats: { commitCount: 1, filesChanged: 1, insertions: 1, deletions: 0 },
  };
  work.workspace = { attachment: snapshot, result: null };
  ledger.reserve({
    id: 'launch',
    sessionId: work.id,
    deadline: Date.now() + 600_000,
    metadata: { workspaceDriver: 'abstract.lean', remoteClosed: true, attached: true },
  });
  if (initial.terminal !== false) ledger.end('launch', 'cancelled_before_spawn', 'reserved');
  else {
    ledger.markUncertain('launch');
    work.status = 'active';
  }
  const command = {
    id: 'command_abstract',
    projectId: work.projectId,
    sessionId: work.id,
    actorId: work.actorId,
    instanceId: work.instanceId,
    expectedRevision: 0,
    runnerId: ledger.runnerId,
    hostRef: 'launch',
    workspace: snapshot,
    expectedHead: snapshot.headOid,
    message: 'Abstract receipt',
    createdAt: '2026-09-29T00:00:00.000Z',
  };
  const journal = join(root, 'driver.json');
  type Journal = { captured: boolean; closed: boolean; acknowledged: boolean };
  const saveJournal = (data: Journal) => writeFileSync(journal, JSON.stringify(data));
  const readJournal = (): Journal => JSON.parse(readFileSync(journal, 'utf8'));
  saveJournal({ captured: false, closed: false, acknowledged: false });
  let control: Extract<Command, { kind: 'poll' }> = { kind: 'poll' };
  let captures = 0,
    closes = 0,
    releaseCalls = 0,
    receiptCalls = 0,
    resultCalls = 0;
  const remoteEffects = { release: 0, receipt: 0, result: 0 };
  const events: string[] = [];
  const fake = server(() => null);
  fake.sessions.set(work.id, work);
  const refusal = (answer: Answer | undefined) =>
    Response.json(
      {
        error: {
          code: answer === 'final' ? 'invalid_abstract_result' : 'state_busy',
          message: 'abstract failure',
        },
      },
      { status: answer === 'final' ? 400 : 503 },
    );
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const debt = path.endsWith('/release')
      ? 'release'
      : path.endsWith('/workspace-result')
        ? 'result'
        : path === '/code/commands/complete'
          ? 'receipt'
          : undefined;
    if (debt) {
      events.push(debt);
      if (debt === 'release') releaseCalls++;
      if (debt === 'receipt') receiptCalls++;
      if (debt === 'result') resultCalls++;
      if (control[debt] === 'retry' || control[debt] === 'final') return refusal(control[debt]);
      remoteEffects[debt]++;
      if (debt === 'receipt')
        return Response.json({
          operation: { command, status: 'failed', receipt: null, error: 'workspace_stopped' },
        });
    }
    return fake.fetch(input, init);
  };
  const factory: WorkspaceDriverFactory = {
    name: 'abstract.lean',
    create: () => ({
      get: () =>
        initial.workspace === false
          ? undefined
          : ({
              path: root,
              snapshot,
              readOnly: false,
              retain: false,
              status: readJournal().closed
                ? 'closed'
                : readJournal().captured
                  ? 'captured'
                  : 'ready',
            } satisfies WorkspaceHandle),
      prepare: async () => {
        throw new Error('No checkout may be prepared in this conformance test');
      },
      capture: async () => {
        events.push('capture');
        captures++;
        if (control.capture === false) throw new Error('capture interrupted');
        saveJournal({ ...readJournal(), captured: true });
        return snapshot;
      },
      close: async () => {
        events.push('close');
        closes++;
        if (control.close === false) throw new Error('close interrupted');
        saveJournal({ ...readJournal(), closed: true });
      },
      pendingCommits: () => (readJournal().acknowledged ? [] : [command]),
      commitOutcome: () => ({ error: 'workspace_stopped' }),
      checkpointCommit: async () => {
        throw new Error('Outcome is already durable');
      },
      acknowledgeCommit: () => {
        if (control.receipt === 'crash') throw new Error('crash before receipt acknowledgement');
        if (mutation !== 'receipt-marker') saveJournal({ ...readJournal(), acknowledged: true });
      },
      dispose() {},
    }),
  };
  type Internals = { ledger: LocalLedger; host: ProcessHost; workspaces: { dispose(): void } };
  let runner: MachineRunner | undefined;
  let started = false,
    driver = initial.driver !== false;
  const abandon = () => {
    if (runner) {
      const internal = runner as unknown as Internals;
      // Simulated process crash: release local resources without the graceful stop protocol.
      internal.workspaces.dispose();
      internal.ledger.close();
      runner = undefined;
      started = false;
    }
  };
  const compose = () => {
    runner = new MachineRunner(config, {
      fetch: fetcher,
      autoPoll: false,
      drivers: driver ? [factory] : [],
    });
    const internal = runner as unknown as Internals;
    const update = internal.ledger.updateMetadata.bind(internal.ledger);
    internal.ledger.updateMetadata = (id: string, patch: LaunchMetadata) => {
      if (patch.usageReported === true && control.release === 'crash')
        throw new Error('crash before release marker');
      if (patch.workspaceReported === true && control.result === 'crash')
        throw new Error('crash before result marker');
      if (mutation === 'release-marker' && patch.usageReported === true)
        patch = { ...patch, usageReported: false };
      if (mutation === 'result-marker' && patch.workspaceReported === true)
        patch = { ...patch, workspaceReported: false };
      return update(id, patch);
    };
  };
  const observations: Observation[] = [];
  try {
    compose();
    for (const action of commands) {
      if (action.kind === 'poll') {
        control = action;
        if (mutation === 'uncertain-settlement' && !terminalLaunch(ledger.get('launch')!)) {
          // Incorrect adapter supplies unearned boot evidence to the real host.
          ledger.updateMetadata('launch', { boot: 'old-boot' });
          Object.defineProperty((runner as unknown as Internals).host, 'boot', {
            value: 'new-boot',
            configurable: true,
          });
        }
        if (!started) {
          started = true;
          await runner!.start();
        } else await runner!.tick();
      } else if (action.kind === 'restart' || action.kind === 'driver') {
        abandon();
        if (action.kind === 'driver') driver = action.present;
        compose();
      } else if (action.evidence && !terminalLaunch(ledger.get('launch')!)) {
        const host = (runner as unknown as Internals).host;
        ledger.updateMetadata('launch', { boot: 'old-boot' });
        Object.defineProperty(host, 'boot', { value: 'new-boot', configurable: true });
        await host.inspect('launch');
        work.status = 'released';
      }
      const row = ledger.get('launch')!;
      const j = readJournal();
      observations.push({
        terminal: terminalLaunch(row),
        driver,
        workspace: initial.workspace !== false,
        release: { done: row.metadata.usageReported === true, calls: releaseCalls },
        receipt: { done: j.acknowledged, calls: receiptCalls },
        result: { done: row.metadata.workspaceReported === true, calls: resultCalls },
        captured: j.captured,
        closed: j.closed,
        settled: ledger.open().length === 0,
        captures,
        closes,
      });
    }
    return { observations, remoteEffects, events };
  } finally {
    abandon();
    ledger.close();
    delete process.env[credentialEnv];
    rmSync(root, { recursive: true, force: true });
  }
}

const traces: { initial?: Initial; commands: Command[] }[] = [
  { commands: [{ kind: 'poll' }, { kind: 'restart' }, { kind: 'poll' }] },
  {
    commands: [
      { kind: 'poll', release: 'retry' },
      { kind: 'poll', release: 'crash' },
      { kind: 'restart' },
      { kind: 'poll', capture: false },
      { kind: 'poll', receipt: 'retry' },
      { kind: 'poll', receipt: 'crash' },
      { kind: 'restart' },
      { kind: 'poll', result: 'retry' },
      { kind: 'poll', result: 'crash' },
      { kind: 'restart' },
      { kind: 'poll', close: false },
      { kind: 'restart' },
      { kind: 'poll' },
      { kind: 'poll' },
    ],
  },
  {
    commands: [
      { kind: 'poll', release: 'final', receipt: 'final', result: 'final', close: false },
      { kind: 'restart' },
      { kind: 'poll' },
    ],
  },
  {
    initial: { driver: false },
    commands: [
      { kind: 'poll' },
      { kind: 'restart' },
      { kind: 'poll' },
      { kind: 'driver', present: true },
      { kind: 'poll' },
    ],
  },
  { initial: { workspace: false }, commands: [{ kind: 'poll' }, { kind: 'poll' }] },
  {
    initial: { terminal: false },
    commands: [
      { kind: 'poll' },
      { kind: 'terminate', evidence: false },
      { kind: 'poll' },
      { kind: 'terminate', evidence: true },
      { kind: 'poll' },
    ],
  },
];
test(
  'compiled settlement traces match real MachineRunner markers, calls and abstract driver progression',
  options,
  async () => {
    for (const { commands, initial } of traces) {
      const actual = await implementation(commands, initial);
      assert.deepEqual(
        actual.observations,
        model(commands, initial),
        JSON.stringify({ commands, initial }),
      );
    }
  },
);
test(
  'crash after remote effect before local marker repeats calls; completed markers block later calls',
  options,
  async () => {
    const commands: Command[] = [
      { kind: 'poll', release: 'crash' },
      { kind: 'restart' },
      { kind: 'poll', receipt: 'crash' },
      { kind: 'restart' },
      { kind: 'poll', result: 'crash' },
      { kind: 'restart' },
      { kind: 'poll', close: false },
      { kind: 'poll' },
      { kind: 'restart' },
      { kind: 'poll' },
    ];
    const actual = await implementation(commands);
    assert.deepEqual(actual.observations, model(commands));
    assert.deepEqual(actual.remoteEffects, { release: 2, receipt: 2, result: 2 });
    const last = actual.observations.at(-1)!;
    assert.equal(last.release.calls, 2);
    assert.equal(last.receipt.calls, 2);
    assert.equal(last.result.calls, 2);
    assert.ok(actual.events.indexOf('release') < actual.events.indexOf('capture'));
    assert.ok(actual.events.indexOf('capture') < actual.events.indexOf('receipt'));
    assert.ok(actual.events.indexOf('receipt') < actual.events.indexOf('result'));
    assert.ok(actual.events.indexOf('result') < actual.events.indexOf('close'));
  },
);
test(
  'settlement comparator detects deleted completion markers and unproven termination',
  options,
  async () => {
    for (const mutation of [
      'release-marker',
      'receipt-marker',
      'result-marker',
      'uncertain-settlement',
    ] as const) {
      const commands: Command[] = [
        { kind: 'poll', close: false },
        { kind: 'restart' },
        { kind: 'poll' },
      ];
      const initial = { terminal: mutation !== 'uncertain-settlement' };
      const actual = await implementation(commands, initial, mutation);
      assert.throws(
        () => assert.deepEqual(actual.observations, model(commands, initial)),
        assert.AssertionError,
        mutation,
      );
    }
  },
);
