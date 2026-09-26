import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from 'cordis';
import {
  createService,
  type Caller,
  type RunningBoard,
  type RunningNode,
  type RunningPanel,
  type RunningPhrase,
  type RunningSection,
  type WorkflowPolicy,
} from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions, type SessionsConfig } from '@merv/sessions';
import { UiRegistry } from '@merv/ui';
import { runningBoard, runningPanel, type RunningSources } from '@merv/ui/running';
import type { SandboxRuntimes } from '@merv/sandboxes';
import { FleetService } from '../packages/fleet/src/index.js';
import { fleetUiPlugin } from '../packages/fleet/src/ui.js';
import { sessionsUiPlugin } from '../packages/sessions/src/ui.js';
import { briefText, face, leaseNode, type Lease } from '../packages/sessions/src/running.js';
import { createApp } from './fixtures/app.js';
import { openState } from './fixtures/state.js';

const secret = () => `ms_${randomBytes(32).toString('base64url')}`;
const request = () => randomBytes(10).toString('hex');
const platform = {
  name: 'codex',
  harness: 'codex' as const,
  model: 'fixture-model',
  enabled: true,
  parallelism: 2,
};
const presence = (runnerId = 'machine', hostname = 'mac-studio') => ({
  runnerId,
  machine: { hostname, system: 'darwin', architecture: 'arm64' },
  platforms: [platform],
  capacity: 2,
});
const auto = (runnerId = 'machine') => ({
  runnerId,
  requestId: request(),
  secret: secret(),
  platform: { name: 'codex', harness: 'codex' as const, model: 'fixture-model' },
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => (resolve = yes));
  return { promise, resolve };
}
/** Every string a person reads on the board or a sidebar: phrases, titles, rows. No keys. */
function words(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) value.forEach((item) => words(item, into));
  else if (value && typeof value === 'object')
    for (const [name, item] of Object.entries(value))
      if (!['key', 'from', 'to', 'link', 'input', 'aliases', 'owner', 'route', 'at'].includes(name))
        words(item, into);
  return into;
}
const noIds = (value: unknown) =>
  assert.deepEqual(
    words(value).filter((text) => /(session|runner|wf|flt|agent|actor)_[A-Za-z0-9]/.test(text)),
    [],
  );

/** Sessions over PostgreSQL with a test clock, its real ui adapter, and the Running reads. */
async function fixture(t: TestContext, options: { config?: SessionsConfig; brief?: string } = {}) {
  let clock = Date.now();
  const env = `MERV_RUNNING_MANAGED_${randomUUID().replaceAll('-', '')}`;
  process.env[env] = randomBytes(48).toString('hex');
  const state = await openState();
  const scope = await createService(new ProjectScope(state, () => clock));
  const workflows = await createService(new WorkflowsService(state, scope));
  const events = await createService(new DurableEvents(state));
  const policy: WorkflowPolicy = {
    successStates: ['done'],
    actions: [
      {
        name: 'finish',
        states: ['working'],
        transitions: ['finish'],
        tool: 'finish',
        instruction: 'Finish.',
        check: async ({ caller, tx }) => {
          await scope.require(caller, 'write', tx);
        },
      },
    ],
    assignments: [
      {
        state: 'working',
        check: async ({ caller, tx }) => {
          await scope.require(caller, 'write', tx);
        },
        build: () => ({
          role: 'producer',
          label: 'Work: Rebuild citation index',
          brief: options.brief ?? 'Rebuild the index.\n\nDone when every key maps to one file.',
          references: [],
          handoff: { instruction: 'Finish', tools: ['finish'] },
          execution: { readOnly: false, tools: [] },
          context: null,
        }),
        execution: {
          readOnly: false,
          tools: [
            {
              name: 'finish',
              alternatives: [
                {
                  instanceId: { kind: 'target', field: 'instanceId' },
                  expectedRevision: { kind: 'target', field: 'revision' },
                },
              ],
            },
          ],
        },
        lease: {
          role: () => 'producer',
          acquire: ({ leaseId }) => ({ leaseId }),
          check: () => {},
          release: () => {},
        },
      },
    ],
  };
  const definition = {
    name: 'running-fixture',
    version: 1,
    initial: 'working',
    states: ['working', 'done'],
    terminal: ['done'],
    edges: [{ from: 'working', action: 'finish', to: 'done' }],
  };
  const handle = await workflows.register(definition, policy);
  const boot = await scope.bootstrap({ projectName: 'Running', actorName: 'Operator' });
  const owner: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const issue = async (name: string, role: 'producer' | 'reader') => {
    const issued = await scope.issueActor(owner, { name, role });
    return {
      actorId: issued.actor.id,
      projectId: boot.project.id,
      credentialId: issued.credential.id,
    } satisfies Caller;
  };
  const source = await issue('Producer', 'producer');
  const reader = await issue('Reader', 'reader');
  const sessions = await createService(
    new LeasedSessions(state, scope, workflows, events, {
      clock: () => clock,
      sweepIntervalMs: 60_000,
      managedSecretEnv: env,
      ...options.config,
    }),
  );
  const ctx = new Context();
  const ui = new UiRegistry();
  ctx.provide('state', state);
  ctx.provide('scope', scope);
  ctx.provide('ui', ui);
  ctx.provide('sessions', sessions);
  await ctx.plugin(sessionsUiPlugin);
  /** What a test composes on top, closed before what it stands on. */
  const closing: (() => Promise<void>)[] = [];
  t.after(async () => {
    await ctx.fiber.dispose();
    for (const close of closing.reverse()) await close();
    await sessions.close();
    await events.close();
    await workflows.close();
    await state.close();
    delete process.env[env];
  });
  const sources: RunningSources = {
    contributions: () => ui.contributions(),
    tools: async () => ['session.halt', 'session.dispatch'],
    isolated: (read) => state.isolated(read),
  };
  // The reads as ui.running and ui.running_panel make them: in one read-only snapshot, where
  // a write is refused, so a part that wrote would name its owner as failed.
  const board = async (caller: Caller) => {
    const answer = await state.snapshot(() => runningBoard(sources, caller));
    for (const lane of Object.values(answer.lanes)) assert.ok(!lane.failed.includes('sessions'));
    return answer;
  };
  return {
    state,
    scope,
    ctx,
    ui,
    sessions,
    handle,
    owner,
    source,
    reader,
    closing,
    advance: (ms: number) => (clock += ms),
    now: () => clock,
    instance: async () =>
      await handle.start(source, { workflow: definition.name, requestId: request() }),
    heartbeat: async (runnerId = 'machine', hostname = 'mac-studio') =>
      await sessions.heartbeatRunner(source, presence(runnerId, hostname)),
    /** One automatic lease, taken up by its worker's first authentication. */
    async active(runnerId = 'machine') {
      const input = auto(runnerId);
      const leased = await sessions.lease(source, input);
      assert.ok(leased.session, leased.reason);
      return { session: leased.session, worker: await sessions.authenticate(input.secret) };
    },
    /** One recorded Merv call, held open until `until` settles. */
    async call(worker: Caller, until?: Promise<void>) {
      await sessions.run(await sessions.prepare(worker, 'finish', {}), async () => {
        await until;
      });
    },
    async fail(outcome: 'launch_failed' | 'preparation_deferred' = 'launch_failed') {
      const leased = await sessions.lease(source, auto());
      assert.ok(leased.session, leased.reason);
      await sessions.release(source, {
        sessionId: leased.session.id,
        runnerId: 'machine',
        outcome,
        ...(outcome === 'preparation_deferred'
          ? { deferral: { cause: 'store_busy', code: 'code_store_full' } }
          : {}),
      });
      clock += 30_001;
      await sessions.heartbeatRunner(source, presence());
    },
    board,
    panel: async (caller: Caller, key: string) =>
      await state.snapshot(() => runningPanel(sources, caller, key)),
  };
}
const node = (board: RunningBoard, key: string): RunningNode | undefined =>
  Object.values(board.lanes)
    .flatMap((lane) => lane.nodes)
    .find((item) => item.key === key);
const section = (panel: { sections: RunningSection[] }, title: string) =>
  panel.sections.find((item) => item.title === title);
const facts = (panel: { sections: RunningSection[] }, title: string) => {
  const found = section(panel, title);
  assert.ok(found?.kind === 'facts', `${title} is a facts section`);
  return Object.fromEntries(found.rows.map((row) => [row.label, row.value]));
};

test('an offered lease is dashed and starting, on the machine that took it, even by hand', async (t) => {
  const f = await fixture(t);
  await f.heartbeat();
  const work = await f.instance();
  const offered = await f.sessions.offer(f.source, {
    instanceId: work.id,
    expectedRevision: work.revision,
    runnerId: 'machine',
    requestId: request(),
    secret: secret(),
  });
  const board = await f.board(f.owner);
  const drawn = node(board, `session:${offered.id}`);
  assert.deepEqual(drawn, {
    key: `session:${offered.id}`,
    lane: 'sessions',
    title: 'Producer',
    name: 'Rebuild citation index',
    lines: [['Offered · not taken up · ', { since: offered.createdAt }], ['on mac-studio']],
    look: 'dashed',
    dot: 'starting',
    links: [{ to: `work:${work.id}`, verb: 'works on' }],
    rank: 0,
    owner: 'sessions',
  });
  assert.deepEqual(board.lanes.sessions.failed, []);
  assert.equal(board.lanes.sessions.needsYou, 0);
  noIds(board);
});

test('a lease nobody runs says nothing of a machine, and never turns red for one', async (t) => {
  const f = await fixture(t);
  const work = await f.instance();
  const input = { runnerId: 'never-reported', requestId: request(), secret: secret() };
  const offered = await f.sessions.offer(f.source, {
    instanceId: work.id,
    expectedRevision: work.revision,
    ...input,
  });
  await f.sessions.authenticate(input.secret);
  const activatedAt = new Date(f.now()).toISOString();
  f.advance(10 * 60_000);
  const drawn = node(await f.board(f.owner), `session:${offered.id}`)!;
  assert.deepEqual(drawn.lines, [['No calls yet · ', { since: activatedAt }]]);
  assert.equal(drawn.attention, undefined);
  assert.equal(drawn.dot, 'live');
  assert.equal(section(await f.panel(f.owner, drawn.key), 'Machine'), undefined);
});

test('an active lease names its call in flight, breathes once the call outlasts a read, then says its last call', async (t) => {
  const f = await fixture(t);
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await f.heartbeat();
  await f.instance();
  const { session, worker } = await f.active();
  const key = `session:${session.id}`;
  let drawn = node(await f.board(f.owner), key)!;
  assert.equal(drawn.look, 'solid');
  assert.equal(drawn.dot, 'live');
  assert.equal(drawn.lines[0][0], 'No calls yet · ');

  const hold = deferred();
  const started = f.now();
  const call = f.call(worker, hold.promise);
  const inFlight = async () => {
    for (let tries = 0; tries < 200; tries++) {
      const found = node(await f.board(f.owner), key)!;
      if (typeof found.lines[0][0] === 'object') return found;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail('the call never showed');
  };
  drawn = await inFlight();
  const since = new Date(started).toISOString();
  assert.deepEqual(drawn.lines[0], [{ mono: 'finish' }, ' · ', { since }]);
  assert.equal(drawn.dot, 'live', 'a call just begun does not breathe');
  f.advance(6000);
  drawn = node(await f.board(f.owner), key)!;
  assert.equal(drawn.dot, 'moving');
  hold.resolve();
  await call;
  drawn = node(await f.board(f.owner), key)!;
  assert.deepEqual(drawn.lines[0], ['Last call ', { ago: new Date(f.now()).toISOString() }]);
  assert.equal(drawn.dot, 'live');
  // The work it is on takes the dot from it, once something draws that work.
  const work = { key: `work:${session.instanceId}`, lane: 'work' as const, title: 'Rebuild' };
  const dispose = f.ui.contribute({
    owner: 'tasks',
    kinds: ['work'],
    lanes: ['work'],
    nodes: async () => ({ nodes: [{ ...work, lines: [['Ready']], look: 'solid' }] }),
  });
  const board = await f.board(f.owner);
  assert.equal(node(board, work.key)?.dot, 'live');
  assert.deepEqual(board.edges, [{ from: key, to: work.key, verb: 'works on', waiting: false }]);
  dispose();
});

test('a lease quiet past the idle notice needs a person, and so does one whose machine stopped reporting', async (t) => {
  const f = await fixture(t, { config: { idleNoticeSeconds: 60 } });
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await f.heartbeat();
  await f.instance();
  const { session } = await f.active();
  const key = `session:${session.id}`;
  const activatedAt = new Date(f.now()).toISOString();
  f.advance(61_000);
  await f.heartbeat();
  let board = await f.board(f.reader);
  const who = 'An operator checks the machine or halts the lease';
  assert.deepEqual(node(board, key)?.attention, {
    says: ['Quiet ', { since: activatedAt }],
    who,
  });
  assert.equal(board.lanes.sessions.needsYou, 1);

  const seen = new Date(f.now()).toISOString();
  f.advance(46_000);
  board = await f.board(f.reader);
  assert.deepEqual(node(board, key)?.attention, {
    says: ['Machine offline · last seen ', { ago: seen }],
    who,
  });
  assert.deepEqual(node(board, key)?.lines[1], ['on mac-studio']);
  const panel = await f.panel(f.owner, key);
  assert.deepEqual(panel.header.attention?.says, ['Machine offline · last seen ', { ago: seen }]);
  const machine = section(panel, 'Machine')!;
  assert.equal(machine.attention, true, 'the section that says why comes first');
  assert.equal(panel.sections[0].title, 'Machine');
  assert.deepEqual(facts(panel, 'Machine').Presence, ['offline · last seen ', { ago: seen }]);
  assert.ok(facts(panel, 'Lease').Lapses, 'a lease nothing renews says when it lapses');

  // Its row on the work it is on says what its node says.
  const [rows] = await f.sessions.runningWork(f.reader, [session.instanceId]);
  assert.deepEqual(rows, {
    title: 'Sessions',
    place: 'activity',
    kind: 'links',
    rows: [
      {
        to: { key },
        kind: 'Producer',
        name: 'mac-studio',
        says: ['Machine offline · last seen ', { ago: seen }],
        attention: true,
      },
    ],
    attention: true,
  });
});

test('a revoked key reads as such, and a lease with no runner row is never red for its machine', () => {
  const now = Date.parse('2026-09-25T12:00:00.000Z');
  const at = (ms: number) => new Date(now - ms).toISOString();
  const lease: Lease = {
    id: 'session_1',
    instanceId: 'wf_1',
    status: 'active',
    role: 'reviewer',
    label: 'Review: Draft section 3.2',
    workflow: 'task',
    createdAt: at(600_000),
    activatedAt: at(590_000),
    expiresAt: new Date(now + 3_600_000).toISOString(),
    hardDeadline: new Date(now + 7_200_000).toISOString(),
    platform: { name: 'claude', harness: 'claude' },
    machine: { hostname: 'mac-studio', capacity: 4, lastSeenAt: at(1000), authorized: false },
    fleet: null,
    calls: { lastAt: at(2000), running: null },
  };
  assert.deepEqual(face(lease, now, 1800).attention, {
    says: ['Key revoked'],
    who: 'An operator checks the machine or halts the lease',
  });
  const nobody = leaseNode({ ...lease, machine: null }, 3, true, now, 1800);
  assert.deepEqual(nobody.lines, [['Last call ', { ago: at(2000) }]]);
  assert.equal(nobody.attention, undefined);
  assert.equal(nobody.title, 'Reviewer · claude');
  assert.deepEqual(nobody.links, [{ to: 'work:wf_1', verb: 'reviews' }]);
  // A lease the read saw run out is lapsed, not red; the sweep closes it.
  const ran = face({ ...lease, machine: null, expiresAt: at(1) }, now, 1800);
  assert.deepEqual(ran, { line: ['Lapsed · lease ran out'], look: 'quiet' });
});

test('the lane says how dispatch stands and why queued work waits, and offers its control to an operator only', async (t) => {
  const f = await fixture(t, { config: { refusalSeconds: 30 } });
  await f.instance();
  const summary = async (caller: Caller) =>
    (await f.board(caller)).lanes.sessions.summaries.find(({ owner }) => owner === 'sessions')!;
  let own = await summary(f.owner);
  assert.deepEqual(own.says, ['Dispatch ', { state: 'paused' }, ' · Machines ', { count: 0 }]);
  assert.deepEqual(own.attention, {
    says: ['Dispatch paused · ', { count: 1 }, ' waiting'],
    who: 'An operator starts dispatch',
  });
  assert.deepEqual(own.actions, [
    {
      label: 'Start dispatch',
      verb: 'start',
      tool: 'session.dispatch',
      input: { enabled: true },
      allowed: true,
      primary: true,
    },
  ]);
  const read = await summary(f.reader);
  assert.deepEqual(read.attention, own.attention, 'every reader sees why work waits');
  assert.deepEqual(read.actions, [], 'the control is an operator’s');
  assert.equal((await f.board(f.reader)).lanes.sessions.needsYou, 1);

  await f.sessions.setDispatch(f.owner, { enabled: true });
  f.advance(1000);
  own = await summary(f.owner);
  assert.deepEqual(own.attention, {
    says: ['No machine online · ', { count: 1 }, ' waiting'],
    who: 'Someone with a write key of this project starts a runner',
  });
  const runner = await f.heartbeat();
  own = await summary(f.owner);
  assert.deepEqual(own.says, [
    'Dispatch ',
    { state: 'running' },
    ' · Machines ',
    { count: 1 },
    ' · Free slots ',
    { count: 2 },
  ]);
  assert.equal(own.attention, undefined);
  assert.deepEqual(
    own.actions.map(({ label, input, primary }) => ({ label, input, primary })),
    [{ label: 'Pause dispatch', input: { enabled: false }, primary: undefined }],
  );
  await f.active();
  assert.deepEqual((await summary(f.reader)).says.slice(-1), [{ count: 1 }]);

  // A machine that keeps refusing work names itself once it has refused for refusalSeconds.
  await f.instance();
  await f.sessions.setRunnerSettings(f.owner, {
    runnerId: runner.id,
    settings: { platforms: [{ name: 'codex', enabled: false, parallelism: 2 }] },
  });
  assert.equal((await f.sessions.lease(f.source, auto())).reason, 'platform_disabled');
  f.advance(31_000);
  await f.heartbeat();
  own = await summary(f.owner);
  assert.deepEqual(own.attention?.says, ['mac-studio', ' refuses work']);
  assert.deepEqual(own.says.slice(-1), [{ count: 0 }], 'a machine taking no work has no free slot');
});

test('dispatch marks what it holds, quietly marks what resumes by itself, and tells only an operator what nobody took', async (t) => {
  const f = await fixture(t, { config: { maxLaunchFailures: 2, quietReadySeconds: 60 } });
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await f.heartbeat();
  const held = await f.instance();
  await f.fail();
  let { marks } = await f.sessions.runningMarks(f.reader);
  assert.deepEqual(marks, [
    {
      key: `work:${held.id}`,
      says: ['Ready · launch failed once, retrying'],
      quiet: true,
    },
  ]);
  await f.fail();
  const put = await f.instance();
  for (let attempt = 0; attempt < 3; attempt++) await f.fail('preparation_deferred');
  f.advance(61_000);
  await f.heartbeat();
  const ready = await f.instance();
  f.advance(61_000);
  await f.heartbeat();

  const heldMark = {
    key: `work:${held.id}`,
    says: ['Held after ', { count: 2 }, ' failed launches'],
    who: 'An operator releases the hold',
  };
  const putMark = {
    key: `work:${put.id}`,
    says: ['Ready · ', { count: 3 }, ' machines could not prepare it'],
    quiet: true,
  };
  ({ marks } = await f.sessions.runningMarks(f.reader));
  assert.deepEqual(marks, [heldMark, putMark], 'the same for every reader');
  ({ marks } = await f.sessions.runningMarks(f.owner));
  assert.deepEqual(marks, [
    heldMark,
    {
      key: `work:${ready.id}`,
      says: ['Ready, not taken for ', { since: ready.updatedAt }],
      who: 'An operator checks dispatch and machines',
    },
    putMark,
  ]);

  // On the board a mark colours the work that another owner draws, red or quiet.
  const dispose = f.ui.contribute({
    owner: 'tasks',
    kinds: ['work'],
    lanes: ['work'],
    nodes: async () => ({
      nodes: [held, put].map(({ id }) => ({
        key: `work:${id}`,
        lane: 'work' as const,
        title: 'Task',
        lines: [['Ready']],
        look: 'solid' as const,
      })),
    }),
  });
  const board = await f.board(f.reader);
  assert.deepEqual(node(board, `work:${held.id}`)?.attention?.says, heldMark.says);
  assert.equal(node(board, `work:${put.id}`)?.attention?.quiet, true);
  assert.equal(board.lanes.work.needsYou, 1);
  dispose();
});

test('a lease’s sidebar streams its Merv calls, running first, with its terms, its work, its machine and a guarded halt', async (t) => {
  const long = Array.from({ length: 400 }, (_, n) => `Line ${n}: ${'x'.repeat(60)}`).join('\n');
  const f = await fixture(t, { brief: long });
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await f.heartbeat();
  await f.instance();
  const { session, worker } = await f.active();
  const key = `session:${session.id}`;
  const takenUp = new Date(f.now()).toISOString();
  for (let n = 0; n < 51; n++) {
    f.advance(100);
    await f.call(worker);
  }
  const hold = deferred();
  f.advance(100);
  const running = f.call(worker, hold.promise);
  for (let tries = 0; ; tries++) {
    const count = await f.state.read(
      async (sql) =>
        (await sql.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM session_tool_calls WHERE status='running'",
        ))!.n,
    );
    if (count) break;
    assert.ok(tries < 200);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const panel = await f.panel(f.owner, key);
  assert.equal(panel.header.kind, 'Agent');
  assert.equal(panel.header.title, 'Rebuild citation index');
  assert.deepEqual(panel.header.says, ['Active ', { since: takenUp }, ' · Producer']);
  assert.equal(panel.live, true);
  assert.equal(panel.route, undefined, 'the Sessions page opens no one lease');

  const stream = section(panel, 'Merv calls')!;
  assert.ok(stream.kind === 'stream');
  assert.equal(stream.total, 52);
  assert.deepEqual(stream.aside, [{ count: 50, of: 52 }]);
  assert.equal(stream.items.length, 50, 'the lease’s own moments lie beyond the calls shown');
  assert.deepEqual(stream.items[0], {
    call: 'finish',
    state: 'running',
    at: new Date(f.now()).toISOString(),
    ms: null,
  });
  assert.ok(stream.items.slice(1).every((item) => 'call' in item && item.state === 'succeeded'));

  assert.deepEqual(facts(panel, 'Lease'), {
    Ends: [{ until: session.hardDeadline }],
  });
  const work = section(panel, 'Work')!;
  assert.deepEqual(work.kind === 'links' && work.rows, [
    { to: { key: `work:${session.instanceId}` }, name: 'Rebuild citation index' },
  ]);
  assert.deepEqual(facts(panel, 'Machine'), {
    Machine: ['mac-studio'],
    Presence: ['live · seen ', { ago: takenUp }],
    Platform: ['codex · fixture-model'],
    Slots: [{ count: 1, of: 2 }, ' busy'],
  });

  const brief = section(panel, 'Brief')!;
  assert.ok(brief.kind === 'text');
  assert.equal(brief.folded, true);
  assert.equal(brief.markdown, true);
  assert.equal(brief.truncated, true);
  assert.ok(brief.text.length <= 16_000);
  assert.ok(long.startsWith(`${brief.text}\n`), 'cut at a line end');
  assert.deepEqual(briefText('short'), { text: 'short', truncated: false });

  assert.equal(panel.actions.length, 1);
  const [halt] = panel.actions;
  assert.deepEqual(
    { ...halt, guard: undefined },
    {
      label: 'Halt lease',
      verb: 'halt',
      tool: 'session.halt',
      input: { sessionId: session.id, reason: 'halted_by_operator' },
      allowed: true,
      guard: undefined,
      expect: { field: 'halted', min: 1, nothing: 'Nothing was halted.' },
    },
  );
  assert.equal(halt.guard?.title, 'Halt this lease?');
  assert.match(
    halt.guard!.consequence,
    /^The agent on mac-studio holds this lease on Rebuild citation index as producer\. .*A remote job it started keeps running\.$/,
  );
  assert.ok(halt.guard!.consequence.length <= 400);
  noIds({ ...panel, actions: [] });

  const read = await f.panel(f.reader, key);
  assert.equal(section(read, 'Brief'), undefined, 'the brief is an operator’s');
  assert.deepEqual(read.actions, []);
  hold.resolve();
  await running;

  // The action's input halts this lease and no other, and an open sidebar still reads it.
  assert.deepEqual(await f.sessions.halt(f.owner, halt.input as never), { halted: 1 });
  const closed = await f.panel(f.reader, key);
  assert.equal(closed.live, false);
  assert.deepEqual(closed.actions, []);
  assert.deepEqual(closed.header.says, [
    'Released',
    ' · ',
    { state: 'halted' },
    ' · ',
    { ago: new Date(f.now()).toISOString() },
    ' · Producer',
  ]);
  assert.deepEqual(facts(closed, 'Lease'), {
    Ended: [{ ago: new Date(f.now()).toISOString() }],
    Outcome: [{ state: 'halted' }],
  });
  assert.equal(node(await f.board(f.reader), key), undefined, 'a closed lease leaves the board');
});

test('a short stream carries the lease’s own moments, and a lease is offered or refused as the Sessions page reads it', async (t) => {
  const f = await fixture(t);
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await f.heartbeat();
  await f.instance();
  const input = auto();
  const leased = (await f.sessions.lease(f.source, input)).session!;
  const offeredAt = new Date(f.now()).toISOString();
  let panel = await f.panel(f.owner, `session:${leased.id}`);
  assert.deepEqual(panel.header.says, ['Offered ', { since: offeredAt }, ' · Producer']);
  assert.deepEqual(facts(panel, 'Lease'), {
    Ends: [{ until: leased.hardDeadline }],
    Lapses: [{ until: leased.expiresAt }],
  });
  f.advance(2000);
  const worker = await f.sessions.authenticate(input.secret);
  f.advance(2000);
  await f.call(worker);
  panel = await f.panel(f.owner, `session:${leased.id}`);
  const stream = section(panel, 'Merv calls')!;
  assert.ok(stream.kind === 'stream');
  assert.deepEqual(stream.aside, [{ count: 1 }]);
  assert.deepEqual(
    stream.items.map((item) => ('mark' in item ? item.mark : item.call)),
    ['finish', ['Taken up'], ['Offered']],
  );

  // Not this project's lease, not a leased worker's read, and never a managed runner's.
  assert.equal(await f.sessions.runningPanel(f.owner, 'session_elsewhere'), null);
  await assert.rejects(f.panel(f.owner, 'session:session_elsewhere'), {
    code: 'running_not_found',
  });
  for (const read of [
    () => f.sessions.running(worker),
    () => f.sessions.runningMarks(worker),
    () => f.sessions.runningPanel(worker, leased.id),
    () => f.sessions.runningWork(worker, [leased.instanceId]),
  ])
    await assert.rejects(read(), { status: 403 });
  await assert.rejects(f.board(worker), { code: 'running_forbidden' });
});

test('a lease bound to a Fleet machine takes that machine in, and Fleet describes it in the lease’s sidebar', async (t) => {
  const f = await fixture(t);
  const runtimes = {
    profiles: [{ key: 'standard', id: 'standard-profile', leaseSeconds: 3600 }],
    connected: () => true,
    describe: async () => null,
  } as unknown as SandboxRuntimes;
  const fleet = await createService(
    new FleetService(f.state, f.scope, runtimes, { enabled: true }, f.now),
  );
  fleet.registerOwner('workflow', {
    valid: async () => true,
    bootstrap: async () => 'bootstrap',
    observe: async () => 'starting',
  });
  f.ctx.provide('fleet', fleet);
  await f.ctx.plugin(fleetUiPlugin);
  f.closing.push(async () => await fleet.close());
  f.sessions.registerManagedValidator({ current: async () => true, admits: async () => true });

  const work = await f.instance();
  const allocation = await fleet.request(f.owner, {
    requestId: request(),
    owner: { kind: 'workflow', id: `${work.id}:${work.revision}` },
  });
  const profile = { ...platform, parallelism: 1 };
  const { enrollmentToken } = await f.sessions.ensureManagedEnrollment({
    allocationId: allocation.id,
    epoch: allocation.epoch,
    source: await f.scope.delegationSource(f.source),
    runtimeProfileId: 'standard-profile',
    platform: profile,
    capabilities: [],
    expiresAt: new Date(f.now() + 3_600_000).toISOString(),
  });
  const enrolled = await f.sessions.enrollManaged(enrollmentToken, {
    workerNonce: randomBytes(32).toString('hex'),
  });
  const machine = await f.sessions.authenticateManaged(enrolled.controlToken);
  const runnerId = `managed-${allocation.id}`;
  await f.sessions.heartbeatRunner(machine, {
    runnerId,
    machine: { hostname: 'ip-10-0-0-7', system: 'linux', architecture: 'x64' },
    platforms: [profile],
    capabilities: [],
    capacity: 1,
  });
  await f.sessions.setDispatch(f.owner, { enabled: true });
  const bound = (await f.sessions.lease(machine, { ...auto(runnerId) })).session!;
  assert.ok(bound);
  const key = `session:${bound.id}`;
  const alias = `fleet:${allocation.id}`;

  const board = await f.board(f.owner);
  const drawn = node(board, key)!;
  assert.deepEqual(drawn.aliases, [alias]);
  assert.deepEqual(drawn.lines[1], ['on a Fleet VM']);
  assert.equal(node(board, alias), undefined, 'the machine is drawn once, as the lease');
  assert.deepEqual(board.lanes.sessions.failed, []);
  assert.deepEqual(
    board.lanes.sessions.summaries[0].says.slice(0, 4),
    ['Dispatch ', { state: 'running' }, ' · Machines ', { count: 0 }],
    'a machine Fleet rents is not one of the project’s own',
  );

  const panel = await f.panel(f.owner, key);
  assert.deepEqual(panel.aliases, [alias]);
  // The lease keeps only whether its runner reports; the machine is Fleet's to describe.
  assert.deepEqual(Object.keys(facts(panel, 'Machine')), ['Presence']);
  assert.match(panel.actions[0].guard!.consequence, /Its Fleet machine is then released\.$/);
  assert.ok(panel.actions[0].guard!.consequence.startsWith('The agent on a Fleet VM holds'));
  // Fleet's own machine section follows the lease's, through the alias, wherever Fleet draws on
  // this page; where it does not yet, the alias is all this lease owes it.
  if (f.ui.contributions().some(({ owner }) => owner === 'fleet')) {
    const own = panel.sections.findIndex(
      ({ owner, title }) => owner === 'sessions' && title === 'Machine',
    );
    const fleets = panel.sections.findIndex(
      ({ owner, place }) => owner === 'fleet' && place === 'machine',
    );
    assert.ok(fleets > own, 'Fleet describes the machine the lease took in');
  }
});

/** The default composition over HTTP: the real tools, the real adapters, one snapshot each. */
test('through ui.running and ui.running_panel, operators and readers see a lease, and only an operator its brief and halt', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-running-sessions-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { plugins } = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as { plugins: { id: string; config?: unknown }[] };
  const app = await createApp({
    directory: join(directory, 'data'),
    config: {
      plugins: plugins.map((entry) =>
        entry.id === 'api'
          ? { ...entry, config: { host: '127.0.0.1', port: 0 } }
          : entry.id === 'ui'
            ? { ...entry, config: { assets: join(directory, 'nowhere') } }
            : entry,
      ) as never,
    },
  });
  t.after(() => app.stop());
  const credentials = await app.ctx.scope.bootstrap({ projectName: 'Running', actorName: 'Op' });
  const operator: Caller = {
    actorId: credentials.actor.id,
    projectId: credentials.project.id,
    credentialId: credentials.credential.id,
  };
  const reader = (await app.ctx.scope.issueActor(operator, { name: 'Reader', role: 'reader' }))
    .token;
  const tool = async (name: string, token: string, input: unknown = {}) => {
    const response = await fetch(`${app.ctx.api.url}/tools/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const created = await tool('task.create', credentials.token, {
    title: 'Rebuild citation index',
    goal: 'Every citation key maps to one retained file.',
    checks: ['Every key resolves.'],
    requestId: 'running-sessions',
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const task = created.body.result;
  await app.ctx.sessions.heartbeatRunner(operator, presence('desk', 'mac-studio'));
  const input = { runnerId: 'desk', requestId: request(), secret: secret() };
  const offered = await app.ctx.sessions.offer(operator, {
    instanceId: task.id,
    expectedRevision: task.workflow.revision,
    ...input,
  });
  const worker = await app.ctx.sessions.authenticate(input.secret);
  const key = `session:${offered.id}`;

  for (const token of [credentials.token, reader]) {
    const answer = await tool('ui.running', token);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    const board = answer.body.result as RunningBoard;
    for (const lane of Object.values(board.lanes)) assert.deepEqual(lane.failed, []);
    const drawn = node(board, key)!;
    assert.equal(drawn.title, 'Producer');
    assert.equal(drawn.name, 'Rebuild citation index');
    assert.deepEqual(drawn.lines[1], ['on mac-studio']);
    assert.deepEqual(drawn.links, [{ to: `work:${task.id}`, verb: 'works on' }]);
    assert.equal(board.lanes.sessions.summaries[0].owner, 'sessions');
    noIds(board);
  }
  const panel = async (token: string) => {
    const answer = await tool('ui.running_panel', token, { key });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    return answer.body.result as RunningPanel;
  };
  const own = await panel(credentials.token);
  assert.equal(own.header.title, 'Rebuild citation index');
  assert.ok(section(own, 'Brief'));
  const work = section(own, 'Work')!;
  assert.deepEqual(work.kind === 'links' && work.rows[0], {
    to: { key: `work:${task.id}`, route: `/tasks/${task.id}` },
    kind: 'Task',
    name: 'Rebuild citation index',
  });
  assert.deepEqual(
    own.actions.map(({ tool, input }) => ({ tool, input })),
    [{ tool: 'session.halt', input: { sessionId: offered.id, reason: 'halted_by_operator' } }],
  );
  noIds({ ...own, actions: [] });
  const read = await panel(reader);
  assert.equal(section(read, 'Brief'), undefined);
  assert.deepEqual(read.actions, []);
  const refused = await fetch(`${app.ctx.api.url}/tools/ui.running_panel`, {
    method: 'POST',
    headers: { authorization: `Bearer ${input.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  assert.equal(refused.status, 403);
  assert.ok(worker.session);

  // The control sends its input as given, and the page reads the answer it expects.
  const halted = await tool('session.halt', credentials.token, own.actions[0].input);
  assert.equal(halted.status, 200, JSON.stringify(halted.body));
  assert.ok(halted.body.result[own.actions[0].expect!.field] >= own.actions[0].expect!.min);
  assert.equal((await panel(reader)).live, false);
});

test('the Sessions lane words its states as the Sessions page does', () => {
  // The phrase a board node leads with, for each lease state, drawn from one rule.
  const now = Date.parse('2026-09-25T12:00:00.000Z');
  const lease: Lease = {
    id: 'session_2',
    instanceId: 'wf_2',
    status: 'offered',
    role: 'reader',
    label: 'Work: After the first sweep: next_steps',
    workflow: 'reflection.lens',
    createdAt: new Date(now - 40_000).toISOString(),
    activatedAt: null,
    expiresAt: new Date(now + 260_000).toISOString(),
    hardDeadline: new Date(now + 86_400_000).toISOString(),
    platform: null,
    machine: null,
    fleet: 'flt_1',
    calls: { lastAt: null, running: null },
  };
  const drawn = leaseNode(lease, 0, false, now, 1800);
  assert.equal(drawn.name, 'After the first sweep: next steps');
  assert.deepEqual(drawn.lines, [
    ['Offered · not taken up · ', { since: lease.createdAt }],
    ['on a Fleet VM'],
  ]);
  assert.deepEqual(drawn.aliases, ['fleet:flt_1']);
  assert.deepEqual(drawn.links, [{ to: 'work:wf_2', verb: 'reads' }]);
  const phrases: RunningPhrase[] = [
    ...drawn.lines,
    face({ ...lease, status: 'active', activatedAt: lease.createdAt }, now, 1800).line,
  ];
  for (const phrase of phrases)
    for (const part of phrase)
      if (typeof part === 'string') assert.doesNotMatch(part, /\b(idle|working|silent)\b/i);
});
