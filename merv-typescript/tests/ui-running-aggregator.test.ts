import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Context } from 'cordis';
import {
  MervError,
  type Caller,
  type RunningAttention,
  type RunningBoard,
  type RunningLaneName,
  type RunningNode,
  type RunningPanelPart,
  type RunningSection,
  type RunningSummary,
} from '@merv/contracts';
import { UiRegistry, type RunningContribution, type RunningRead } from '@merv/ui';
import {
  LANE_CAP,
  RunningRegistry,
  actionOf,
  attentionOf,
  compose,
  edgesOf,
  fold,
  markOf,
  nodeOf,
  order,
  phraseOf,
  runningBoard,
  runningPanel,
  sectionOf,
  targetOf,
  type RunningSources,
} from '@merv/ui/running';
import { createApp } from './fixtures/app.js';

/**
 * The Running board's composition rules, held with fake contributions: no plugin, no
 * PostgreSQL. The last test reads both tools through the assembled application.
 */

const caller: Caller = { actorId: 'actor_operator', projectId: 'project_running' };
const TOOLS = ['session.halt', 'session.dispatch', 'sandbox.extend', 'sandbox.release'];

const sources = (contributions: RunningContribution[], tools = TOOLS): RunningSources => {
  const registry = new RunningRegistry();
  for (const contribution of contributions) registry.contribute(contribution);
  return { contributions: () => registry.contributions(), tools: async () => tools };
};
const board = async (...contributions: RunningContribution[]) =>
  await runningBoard(sources(contributions), caller);
const node = (
  key: string,
  lane: RunningLaneName = 'work',
  extra: Partial<RunningNode> = {},
): RunningNode => ({ key, lane, title: key, lines: [], look: 'solid', ...extra });
const red = (says: string, who = 'An operator'): RunningAttention => ({ says: [says], who });
const draws = (owner: string, nodes: RunningNode[], extra: Partial<RunningContribution> = {}) =>
  ({ owner, nodes: async () => ({ nodes }), ...extra }) as RunningContribution;
const keys = (answer: RunningBoard, lane: RunningLaneName) =>
  answer.lanes[lane].nodes.map(({ key }) => key);
const find = (answer: RunningBoard, key: string) =>
  Object.values(answer.lanes)
    .flatMap(({ nodes }) => nodes)
    .find((node) => node.key === key);
const refusal = (status: number) => new MervError('refused', 'Not for this caller', status);

test('a session that absorbs its Fleet machine takes its place, its links and its attention, and its own attention outranks it', async () => {
  const answer = await board(
    draws(
      'fleet',
      [
        node('fleet:A', 'sessions', {
          attention: red('Could not start the machine'),
          links: [{ to: 'work:T', verb: 'rented for', waiting: true }],
        }),
        node('fleet:B', 'sessions', { attention: red('Could not start the other machine') }),
      ],
      { lanes: ['sessions'] },
    ),
    draws(
      'sessions',
      [
        node('session:1', 'sessions', {
          aliases: ['fleet:A'],
          dot: 'live',
          links: [{ to: 'work:T', verb: 'works on' }],
        }),
        node('session:2', 'sessions', { aliases: ['fleet:B'], attention: red('Quiet') }),
      ],
      { lanes: ['sessions'] },
    ),
    draws('sandboxes', [
      node('check:C', 'hardware', { links: [{ to: 'fleet:A', verb: 'checks' }] }),
    ]),
    draws('tasks', [node('work:T')]),
  );
  // Both need a person now: one for its own reason, one for the machine it absorbed.
  assert.deepEqual(keys(answer, 'sessions'), ['session:1', 'session:2']);
  assert.deepEqual(find(answer, 'session:1')!.attention, red('Could not start the machine'));
  assert.deepEqual(find(answer, 'session:2')!.attention, red('Quiet'));
  assert.deepEqual(find(answer, 'session:1')!.aliases, ['fleet:A']);
  // A link aimed at the absorbed key lands on its absorber; the absorbed node's own are gone.
  assert.deepEqual(answer.edges, [
    { from: 'session:1', to: 'work:T', verb: 'works on', waiting: false },
    { from: 'check:C', to: 'session:1', verb: 'checks', waiting: false },
  ]);
  assert.equal(answer.lanes.sessions.needsYou, 2);
  assert.equal(find(answer, 'session:1')!.owner, 'sessions');
});

test('a mark holds its key on the board, reaches every nodes() as include, colours the node below its own attention, and is dropped where nothing draws it', async () => {
  const seen: Record<string, string[]> = {};
  const merge = {
    says: ['Waiting on a person to merge the pull request'],
    who: 'A signed-in operator',
  };
  const answer = await board(
    {
      owner: 'code-research',
      marks: async () => [
        { key: 'work:T', ...merge },
        { key: 'work:gone', says: ['Nothing draws this'] },
        { key: 'work:U', says: ['Held after 3 failed launches'] },
        { key: 'Not a key', says: ['Dropped'] },
      ],
    },
    {
      owner: 'tasks',
      lanes: ['work'],
      nodes: async (read) => {
        seen.tasks = [...read.include].sort();
        return {
          nodes: [
            // A done task stays only because another owner holds it.
            ...(read.include.has('work:T')
              ? [node('work:T', 'work', { look: 'quiet', lines: [['Done']] })]
              : []),
            node('work:U', 'work', { attention: red('Suspended') }),
            node('work:V'),
          ],
        };
      },
    },
    {
      owner: 'experiments',
      nodes: async (read) => {
        seen.experiments = [...read.include].sort();
        return { nodes: [] };
      },
    },
  );
  assert.deepEqual(seen, {
    tasks: ['work:T', 'work:U', 'work:gone'],
    experiments: ['work:T', 'work:U', 'work:gone'],
  });
  assert.deepEqual(find(answer, 'work:T')!.attention, merge);
  assert.deepEqual(find(answer, 'work:U')!.attention, red('Suspended'));
  assert.equal(find(answer, 'work:V')!.attention, undefined);
  assert.equal(find(answer, 'work:gone'), undefined);
  assert.equal(answer.lanes.work.needsYou, 2);
});

test('a quiet mark replaces the line without the red, needs nobody, sorts by rank, and any red outranks it', async () => {
  const quiet = { says: ['Ready · launch failed 2 times, retrying'], quiet: true as const };
  const answer = await board(
    {
      owner: 'code-research',
      marks: async () => [{ key: 'work:Q', ...quiet }],
    },
    {
      owner: 'sessions',
      marks: async () => [
        { key: 'work:R', ...quiet },
        { key: 'work:Q', says: ['Held after 3 failed launches'], who: 'An operator' },
      ],
    },
    draws('tasks', [node('work:A', 'work', { title: 'A' }), node('work:R', 'work', { rank: 2 })]),
    draws('experiments', [node('work:Q', 'work', { rank: 5 })]),
  );
  assert.deepEqual(find(answer, 'work:R')!.attention, quiet);
  assert.deepEqual(find(answer, 'work:Q')!.attention, {
    says: ['Held after 3 failed launches'],
    who: 'An operator',
  });
  assert.deepEqual(keys(answer, 'work'), ['work:Q', 'work:A', 'work:R']);
  assert.equal(answer.lanes.work.needsYou, 1);
});

test('edges keep only links between drawn nodes, once each, and never a node to itself', async () => {
  const drawn = [
    node('work:A', 'work', {
      links: [
        { to: 'work:B', verb: 'waits on', waiting: true },
        { to: 'work:B', verb: 'waits on' },
        { to: 'work:A', verb: 'waits on' },
        { to: 'work:done', verb: 'waits on', waiting: true },
      ],
    }),
    node('work:B'),
  ];
  assert.deepEqual(edgesOf(drawn, new Map()), [
    { from: 'work:A', to: 'work:B', verb: 'waits on', waiting: true },
  ]);
  const answer = await board(draws('tasks', drawn));
  assert.deepEqual(answer.edges, [
    { from: 'work:A', to: 'work:B', verb: 'waits on', waiting: true },
  ]);
});

test('a lane reads what needs a person first, then rank, then owner, then title, and counts what it cannot draw', async () => {
  const answer = await board(
    draws('beta', [
      node('work:b1', 'work', { title: 'Zeta' }),
      node('work:b2', 'work', { title: 'Alpha', rank: -1 }),
      node('work:b3', 'work', { title: 'Red', rank: 5, attention: red('Stopped') }),
    ]),
    draws('alpha', [
      node('work:a1', 'work', { title: 'Mid' }),
      node('work:a2', 'work', { title: 'Beta' }),
      node('work:a3', 'work', { title: 'Calm', attention: { says: ['Ready'], quiet: true } }),
    ]),
    draws(
      'sandboxes',
      Array.from({ length: LANE_CAP + 5 }, (_, at) =>
        node(`sandbox:m${at}`, 'hardware', { title: `m${String(at).padStart(3, '0')}` }),
      ),
    ),
  );
  assert.deepEqual(keys(answer, 'work'), [
    'work:b3',
    'work:b2',
    'work:a2',
    'work:a3',
    'work:a1',
    'work:b1',
  ]);
  assert.equal(answer.lanes.hardware.nodes.length, LANE_CAP);
  assert.equal(answer.lanes.hardware.more, 5);
  assert.equal(answer.lanes.work.more, undefined);
  assert.deepEqual(
    order([node('work:x', 'work', { title: 'B' }), node('work:y', 'work', { title: 'A' })], []).map(
      ({ key }) => key,
    ),
    ['work:y', 'work:x'],
  );
});

test('a part that fails names its owner in its lanes and leaves the rest standing, while a refused part is simply absent', async () => {
  const at = '2026-09-25T10:00:00.000Z';
  const answer = await board(
    {
      owner: 'broken',
      lanes: ['sessions', 'hardware'],
      nodes: async () => {
        throw new Error('connection reset');
      },
    },
    {
      owner: 'sync',
      nodes: () => {
        throw new Error('thrown before any promise');
      },
    },
    {
      owner: 'hidden',
      lanes: ['sessions'],
      nodes: async () => {
        throw refusal(403);
      },
      summary: async () => {
        throw refusal(404);
      },
    },
    {
      owner: 'marker',
      lanes: ['hardware'],
      marks: async () => {
        throw new Error('marks failed');
      },
      nodes: async () => ({ nodes: [node('sandbox:still-here', 'hardware')] }),
    },
    {
      owner: 'cached',
      lanes: ['hardware'],
      nodes: async () => ({
        nodes: [node('sandbox:old', 'hardware')],
        asOf: at,
        failed: true,
      }),
    },
    {
      owner: 'malformed',
      lanes: ['sessions'],
      nodes: async () => ({ nodes: 'not a list' }) as never,
    },
    {
      owner: 'summarizer',
      lanes: ['sessions'],
      summary: async () => {
        throw new Error('summary failed');
      },
    },
    draws('tasks', [node('work:fine')]),
  );
  assert.deepEqual(answer.lanes.work.failed, ['marker', 'sync']);
  assert.deepEqual(answer.lanes.sessions.failed, ['broken', 'malformed', 'summarizer']);
  assert.deepEqual(answer.lanes.hardware.failed, ['broken', 'cached']);
  assert.deepEqual(keys(answer, 'work'), ['work:fine']);
  assert.deepEqual(keys(answer, 'hardware').sort(), ['sandbox:old', 'sandbox:still-here']);
  assert.equal(answer.lanes.hardware.asOf, at);
  assert.equal(answer.lanes.work.asOf, undefined);
});

test('a cache that was never filled leaves its lane pending, and a lane goes stale when its first cache does', async () => {
  const pending = await board({
    owner: 'sandboxes',
    lanes: ['hardware'],
    nodes: async () => ({ nodes: [], pending: true }),
  });
  assert.equal(pending.lanes.hardware.pending, true);
  assert.equal(pending.lanes.hardware.asOf, undefined);
  assert.equal(pending.lanes.work.pending, undefined);
  const t0 = Date.parse('2026-09-25T10:00:00.000Z');
  const cached = await board(
    {
      owner: 'sandboxes',
      lanes: ['hardware'],
      nodes: async () => ({
        nodes: [node('sandbox:a', 'hardware')],
        asOf: new Date(t0).toISOString(),
        freshForMs: 60_000,
      }),
    },
    {
      owner: 'racks',
      lanes: ['hardware'],
      nodes: async () => ({
        nodes: [],
        asOf: new Date(t0 + 10_000).toISOString(),
        freshForMs: 10_000,
      }),
    },
  );
  assert.equal(cached.lanes.hardware.asOf, new Date(t0).toISOString());
  assert.equal(cached.lanes.hardware.freshForMs, 20_000);
  assert.equal(cached.lanes.hardware.pending, undefined);
});

test('a work node takes its dot from the sessions on it, never from its owner, and a session that needs a person lends none', async () => {
  const session = (key: string, dot: RunningNode['dot'], to: string, extra = {}) =>
    node(key, 'sessions', { dot, links: [{ to, verb: 'works on' }], ...extra });
  const answer = await board(
    draws('reflections', [node('work:W', 'work', { aliases: ['work:L1', 'work:L2'] })]),
    draws('tasks', [
      node('work:T', 'work', { dot: 'live' }),
      node('work:U'),
      node('work:V'),
      node('work:X'),
      node('work:Y'),
    ]),
    draws('sessions', [
      session('session:1', 'starting', 'work:U'),
      node('session:2', 'sessions', {
        dot: 'moving',
        links: [{ to: 'work:U', verb: 'reviews' }],
      }),
      session('session:3', 'live', 'work:V', { attention: red('Machine silent') }),
      session('session:4', 'live', 'work:L2'),
      node('session:5', 'sessions', { dot: 'live', links: [{ to: 'work:X', verb: 'reads' }] }),
      session('session:6', 'live', 'work:Y', {
        attention: { says: ['Ready · retrying'], quiet: true },
      }),
    ]),
  );
  assert.equal(find(answer, 'work:T')!.dot, undefined);
  assert.equal(find(answer, 'work:U')!.dot, 'moving');
  assert.equal(find(answer, 'work:V')!.dot, undefined);
  assert.equal(find(answer, 'work:W')!.dot, 'live');
  assert.equal(find(answer, 'work:X')!.dot, undefined);
  assert.equal(find(answer, 'work:Y')!.dot, 'live');
  // Sessions keep their own dots, and a lens's session lands on its wave.
  assert.equal(find(answer, 'session:1')!.dot, 'starting');
  assert.ok(
    answer.edges.some(
      (edge) => edge.from === 'session:4' && edge.to === 'work:W' && edge.verb === 'works on',
    ),
  );
});

test('absorption carries what an absorbed node absorbed, gives a key to its first claimant, and refuses a loop', async () => {
  const chain = fold([
    node('fleet:F', 'sessions', { aliases: ['sandbox:X'] }),
    node('session:S', 'sessions', { aliases: ['fleet:F', 'session:S'] }),
  ]);
  assert.deepEqual(
    [...chain.alias],
    [
      ['sandbox:X', 'session:S'],
      ['fleet:F', 'session:S'],
    ],
  );
  assert.deepEqual([...chain.absorbed], [['session:S', ['sandbox:X', 'fleet:F']]]);
  const twice = fold([
    node('check:A', 'hardware', { aliases: ['sandbox:K'] }),
    node('compute:B', 'hardware', { aliases: ['sandbox:K'] }),
  ]);
  assert.deepEqual([...twice.alias], [['sandbox:K', 'check:A']]);
  const loop = fold([
    node('session:A', 'sessions', { aliases: ['fleet:B'] }),
    node('fleet:B', 'sessions', { aliases: ['session:A'] }),
  ]);
  assert.deepEqual([...loop.alias], [['fleet:B', 'session:A']]);

  const answer = await board(
    draws('fleet', [node('fleet:F', 'sessions', { aliases: ['sandbox:X'] })]),
    draws('sandboxes', [node('sandbox:X', 'hardware', { attention: red('Connection lost') })]),
    draws('sessions', [node('session:S', 'sessions', { aliases: ['fleet:F'] })]),
  );
  assert.deepEqual(keys(answer, 'hardware'), []);
  assert.deepEqual(keys(answer, 'sessions'), ['session:S']);
  assert.deepEqual(find(answer, 'session:S')!.attention, red('Connection lost'));
  assert.deepEqual(find(answer, 'session:S')!.aliases, ['sandbox:X', 'fleet:F']);
});

test('once() runs a read one time per answer for each owner, and never across answers', async () => {
  let reads = 0;
  const shared = (read: RunningRead) => read.once('board', async () => ++reads);
  const sessions: RunningContribution = {
    owner: 'sessions',
    lanes: ['sessions'],
    marks: async (read) => (await shared(read), []),
    nodes: async (read) => ({ nodes: [node(`session:${await shared(read)}`, 'sessions')] }),
    summary: async (read) => ({
      lane: 'sessions',
      says: [{ count: await shared(read) }],
      actions: [],
    }),
  };
  const other: RunningContribution = {
    owner: 'other',
    nodes: async (read) => (await read.once('board', async () => ++reads), { nodes: [] }),
  };
  const first = await board(sessions, other);
  assert.equal(reads, 2);
  assert.deepEqual(keys(first, 'sessions'), ['session:1']);
  const again = await board(sessions);
  assert.equal(reads, 3);
  assert.deepEqual(again.lanes.sessions.summaries[0].says, [{ count: 3 }]);
});

test('the board and the sidebar refuse leased workers and managed runners before any owner is read', async () => {
  let asked = 0;
  const spy: RunningContribution = {
    owner: 'spy',
    kinds: ['work'],
    marks: async () => (asked++, []),
    nodes: async () => (asked++, { nodes: [] }),
    panel: async () => (asked++, null),
  };
  const workers: Caller[] = [
    { ...caller, session: { id: 'session_worker' } },
    {
      ...caller,
      managed: { allocationId: 'allocation', epoch: 1, credentialHash: 'hash' },
    },
  ];
  for (const worker of workers) {
    await assert.rejects(runningBoard(sources([spy]), worker), {
      code: 'running_forbidden',
      status: 403,
    });
    await assert.rejects(runningPanel(sources([spy]), worker, 'work:T'), {
      code: 'running_forbidden',
      status: 403,
    });
  }
  assert.equal(asked, 0);
});

test('the registry checks each contribution, refuses a second one per owner, and a disposer removes only its own', () => {
  const registry = new RunningRegistry();
  for (const invalid of [
    { owner: 'Tasks' },
    { owner: 'tasks', kinds: ['Work'] },
    { owner: 'tasks', lanes: ['elsewhere'] },
    { owner: 'tasks', nodes: 'not a function' },
  ])
    assert.throws(() => registry.contribute(invalid as never), { code: 'invalid_contribution' });
  const disposeTasks = registry.contribute({ owner: 'tasks' });
  registry.contribute({ owner: 'code-research' });
  assert.throws(() => registry.contribute({ owner: 'tasks' }), {
    code: 'contribution_conflict',
    status: 409,
  });
  assert.deepEqual(
    registry.contributions().map(({ owner }) => owner),
    ['code-research', 'tasks'],
  );
  disposeTasks();
  const disposeNewer = registry.contribute({ owner: 'tasks' });
  disposeTasks();
  assert.deepEqual(
    registry.contributions().map(({ owner }) => owner),
    ['code-research', 'tasks'],
  );
  disposeNewer();
  assert.deepEqual(
    registry.contributions().map(({ owner }) => owner),
    ['code-research'],
  );
});

test('a contribution registered in an effect leaves the board when its adapter unloads', async (t) => {
  const ctx = new Context();
  t.after(async () => await ctx.fiber.dispose());
  const ui = new UiRegistry();
  ctx.provide('ui', ui);
  const fiber = ctx.plugin({
    name: 'merv-probe-ui',
    inject: ['ui'],
    apply(ctx: Context) {
      ctx.effect(() => ctx.ui.contribute(draws('probe', [node('work:P')], { lanes: ['work'] })));
    },
  });
  await fiber;
  const running = { contributions: () => ui.contributions(), tools: async () => [] };
  assert.deepEqual(keys(await runningBoard(running, caller), 'work'), ['work:P']);
  await fiber.dispose();
  assert.deepEqual(ui.contributions(), []);
  assert.deepEqual(keys(await runningBoard(running, caller), 'work'), []);
});

test('nodes, marks, phrases and targets that break the contract are left out', async () => {
  const valid = node('work:ok', 'work', {
    kind: 'Task',
    lines: [
      [
        'Waits on ',
        { mono: 'main' },
        { state: 'in_review' },
        { ago: '2026-09-25T10:00:00Z' },
        { since: '2026-09-25T10:00:00Z', of: 3600 },
        { until: '2026-09-25T11:00:00Z' },
        { count: 2, of: 4 },
        {
          money: { amount: '2.10', currency: 'USD' },
          of: null,
          rate: { amount: '0.0049', currency: 'USD' },
        },
        { actor: 'actor_producer', prefix: 'with ', unnamed: 'claimed' },
        { link: { key: 'work:ok', route: '/tasks/ok' }, text: 'Open' },
      ],
    ],
    units: { count: 8, busy: true },
    rank: 1,
  });
  assert.deepEqual(nodeOf(valid), valid);
  for (const broken of [
    { ...valid, key: 'Work:ok' },
    { ...valid, key: 'work:' },
    { ...valid, key: 'work:a b' },
    { ...valid, lane: 'elsewhere' },
    { ...valid, title: '' },
    { ...valid, title: 'x'.repeat(201) },
    { ...valid, lines: [[], [], []] },
    { ...valid, lines: [Array.from({ length: 17 }, () => 'x')] },
    { ...valid, lines: [[{ since: 'yesterday' }]] },
    { ...valid, lines: [[{ count: -1 }]] },
    { ...valid, lines: [[{ money: { amount: '1,00', currency: 'USD' } }]] },
    { ...valid, lines: [[{ colour: 'red' }]] },
    { ...valid, look: 'bold' },
    { ...valid, dot: 'fast' },
    { ...valid, units: { count: 65, busy: true } },
    { ...valid, links: [{ to: 'work:x', verb: 'blocks' }] },
    { ...valid, aliases: Array.from({ length: 17 }, (_, at) => `fleet:${at}`) },
    { ...valid, rank: Number.NaN },
    { ...valid, attention: { says: [] } },
  ])
    assert.equal(nodeOf(broken), null, JSON.stringify(broken).slice(0, 120));
  assert.equal(markOf({ key: 'work:T', says: ['x'], who: 'y'.repeat(121) }), null);
  assert.equal(markOf({ key: 'work:T', says: Array.from({ length: 17 }, () => 'x') }), null);

  assert.deepEqual(targetOf({ href: 'https://github.com/o/r/pull/12' }), {
    href: 'https://github.com/o/r/pull/12',
  });
  assert.deepEqual(targetOf({ route: '/code/merge/base_1' }), { route: '/code/merge/base_1' });
  for (const unsafe of [
    { href: 'javascript:alert(1)' },
    { href: 'http://example.com' },
    { route: '//evil.example/path' },
    { route: 'relative' },
    { key: 'work:ok', route: 'https://evil.example' },
    { key: 'not a key' },
  ])
    assert.equal(targetOf(unsafe), null, JSON.stringify(unsafe));
  // A link that goes nowhere safe still says its words, and the shell draws the arrow.
  assert.deepEqual(
    phraseOf([
      { link: { href: 'javascript:alert(1)' }, text: 'Open' },
      { link: { route: '/reviews/r1' }, text: 'Open the review →' },
    ]),
    ['Open', { link: { route: '/reviews/r1' }, text: 'Open the review' }],
  );
  // The way to a move that goes nowhere is dropped; the person's need stays.
  assert.deepEqual(
    attentionOf({
      says: ['Waiting on a person to merge the pull request'],
      to: { href: 'javascript:alert(1)', text: 'Merge' },
    }),
    { says: ['Waiting on a person to merge the pull request'] },
  );
  assert.deepEqual(
    attentionOf({ says: ['Merge it'], to: { route: '/code', text: 'Merge reviewed proposal →' } }),
    { says: ['Merge it'], to: { route: '/code', text: 'Merge reviewed proposal' } },
  );

  const answer = await board(
    draws('tasks', [
      { ...node('work:kept'), owner: 'someone-else' },
      { ...node('work:bad'), lane: 'nowhere' as never },
      node('work:kept', 'work', { title: 'A second node under a key already drawn' }),
    ]),
  );
  assert.deepEqual(answer.lanes.work.nodes, [{ ...node('work:kept'), owner: 'tasks' }]);
});

test('actions are sent only when allowed, for a registered tool, with small JSON input, and only a start wears the accent', async () => {
  const tools = new Set(TOOLS);
  const halt = {
    label: 'Halt lease',
    verb: 'halt',
    tool: 'session.halt',
    input: { sessionId: 'session_1', reason: 'halted_by_operator' },
    allowed: true,
    primary: true,
    guard: { title: 'Halt this lease?', consequence: 'Closes the lease now.' },
    expect: { field: 'halted', min: 1, nothing: 'Nothing was halted.' },
  };
  const { primary: _primary, ...unaccented } = halt;
  assert.deepEqual(actionOf(halt, tools), unaccented);
  const start = {
    label: 'Start dispatch',
    verb: 'start',
    tool: 'session.dispatch',
    input: { enabled: true },
    allowed: true,
    primary: true,
  };
  assert.deepEqual(actionOf(start, tools), start);
  for (const refused of [
    { ...halt, allowed: false },
    { ...halt, tool: 'session.nowhere' },
    { ...halt, tool: 'Session.Halt' },
    { ...halt, verb: 'delete' },
    { ...halt, label: 'x'.repeat(41) },
    { ...halt, input: ['sessionId'] },
    { ...halt, input: { note: 'x'.repeat(4096) } },
    { ...halt, guard: { title: 'Halt?' } },
    { ...halt, expect: { field: 'halted.count', min: 1, nothing: 'Nothing was halted.' } },
  ])
    assert.equal(actionOf(refused, tools), null, JSON.stringify(refused).slice(0, 80));

  const answer = await board({
    owner: 'sessions',
    lanes: ['sessions'],
    summary: async () => ({
      lane: 'sessions',
      says: ['Dispatch ', { state: 'paused' }],
      attention: { says: ['Dispatch paused · ', { count: 3 }, ' waiting'] },
      actions: [
        start,
        { ...start, label: 'Pause dispatch', verb: 'pause', input: { enabled: false } },
        { ...start, tool: 'fleet.halt' },
      ] as never,
    }),
  });
  const [summary] = answer.lanes.sessions.summaries;
  assert.equal(summary.owner, 'sessions');
  assert.deepEqual(
    summary.actions.map(({ label, primary }) => [label, primary]),
    [
      ['Start dispatch', true],
      ['Pause dispatch', undefined],
    ],
  );
  assert.equal(answer.lanes.sessions.needsYou, 1);
  const crowded = await board({
    owner: 'sessions',
    summary: async () => ({
      lane: 'sessions',
      says: ['Dispatch on'],
      actions: Array.from({ length: 5 }, () => start) as never,
    }),
  });
  assert.deepEqual(crowded.lanes.sessions.summaries, []);
});

test('sections that break the contract or say nothing are left out, row by row where a row breaks it', () => {
  const frame = { title: 'Checks', place: 'content' as const };
  assert.equal(sectionOf({ ...frame, kind: 'text', text: '  \n ' }), null);
  assert.equal(sectionOf({ ...frame, kind: 'text', text: 'x'.repeat(16_001) }), null);
  assert.equal(sectionOf({ ...frame, title: 'x'.repeat(61), kind: 'text', text: 'Goal' }), null);
  assert.equal(sectionOf({ ...frame, place: 'sidebar', kind: 'text', text: 'Goal' }), null);
  assert.equal(sectionOf({ ...frame, kind: 'html', text: '<b>Goal</b>' }), null);
  assert.equal(sectionOf({ ...frame, kind: 'facts', rows: [] }), null);
  assert.equal(
    sectionOf({
      ...frame,
      kind: 'facts',
      rows: Array.from({ length: 25 }, () => ({ label: 'Row', value: ['x'] })),
    }),
    null,
  );
  assert.deepEqual(
    sectionOf({
      ...frame,
      kind: 'table',
      columns: ['Check', 'Claim'],
      rows: [
        { cells: [['1 · Runs'], [{ state: 'met' }]], to: { href: 'javascript:void 0' } },
        { cells: [['2 · Only one cell']] },
      ],
    }),
    {
      ...frame,
      kind: 'table',
      columns: ['Check', 'Claim'],
      rows: [{ cells: [['1 · Runs'], [{ state: 'met' }]] }],
    },
  );
  assert.deepEqual(
    sectionOf({
      ...frame,
      kind: 'links',
      rows: [
        { to: { route: '//evil.example' }, name: 'Nowhere' },
        { to: { key: 'work:T', route: '/tasks/T' }, kind: 'Task', name: 'Clean the set' },
      ],
    }),
    {
      ...frame,
      kind: 'links',
      rows: [{ to: { key: 'work:T', route: '/tasks/T' }, kind: 'Task', name: 'Clean the set' }],
    },
  );
  assert.equal(sectionOf({ ...frame, kind: 'stream', items: [], total: 0 }), null);
  assert.deepEqual(sectionOf({ ...frame, kind: 'stream', items: [], total: 3 }), {
    ...frame,
    kind: 'stream',
    items: [],
    total: 3,
  });
  assert.equal(
    sectionOf({ ...frame, kind: 'ladder', graph: { state: 'x', nodes: [], edges: [] } }),
    null,
  );
});

test('sections read what needs a person first, then by place, with code before content, and within a place by who wrote it', () => {
  const section = (title: string, place: RunningSection['place'], extra = {}) => ({
    title,
    place,
    kind: 'text',
    text: title,
    ...extra,
  });
  const composed = compose([
    { owner: 'tasks', sections: [section('Brief', 'content'), section('Details', 'details')] },
    { owner: 'fleet', sections: [section('Fleet notes', 'content')] },
    {
      owner: 'code-research',
      sections: [section('Code', 'code'), section('Needs', 'details', { attention: true })],
    },
    { owner: 'reviews', sections: 'not a list' },
  ]);
  assert.deepEqual(
    composed.map(({ title, owner }) => `${owner}:${title}`),
    [
      'code-research:Needs',
      'code-research:Code',
      'tasks:Brief',
      'fleet:Fleet notes',
      'tasks:Details',
    ],
  );
  assert.equal(
    compose([
      {
        owner: 'tasks',
        sections: Array.from({ length: 20 }, (_, at) => section(`S${at}`, 'content')),
      },
    ]).length,
    16,
  );
});

test('a sidebar comes from its owner, the owners of what it absorbed add sections without controls, and every other owner adds sections by place', async () => {
  const calls: string[] = [];
  const facts = (title: string, place: RunningSection['place'], label = 'Status') => ({
    title,
    place,
    kind: 'facts' as const,
    rows: [{ label, value: ['live'] }],
  });
  const halt = {
    label: 'Halt lease',
    verb: 'halt' as const,
    tool: 'session.halt',
    input: { sessionId: 'S', reason: 'halted_by_operator' },
    allowed: true,
    guard: { title: 'Halt this lease?', consequence: 'Closes the lease now.' },
    expect: { field: 'halted', min: 1, nothing: 'Nothing was halted.' },
  };
  const sessions: RunningContribution = {
    owner: 'sessions',
    kinds: ['session'],
    panel: async (_read, key): Promise<RunningPanelPart | null> =>
      key === 'session:S'
        ? {
            header: { kind: 'Agent', title: 'Clean the held-out set', says: ['Live'] },
            sections: [
              facts('Machine', 'machine', 'Machine'),
              {
                title: 'Merv calls',
                place: 'activity',
                kind: 'stream',
                items: [
                  {
                    call: 'artifact.create',
                    state: 'running',
                    at: '2026-09-25T10:00:00Z',
                    ms: null,
                  },
                ],
                total: 1,
              },
              { title: 'Lease', place: 'activity', kind: 'facts', rows: [] },
              facts('x'.repeat(61), 'details'),
            ],
            actions: [
              halt,
              { ...halt, label: 'Pause dispatch', verb: 'pause', allowed: false },
              { ...halt, label: 'Release machine', verb: 'release', tool: 'fleet.halt' },
            ],
            route: '/sessions',
            live: true,
            aliases: ['fleet:F', 'fleet:F', 'session:S'],
          }
        : null,
  };
  const fleet: RunningContribution = {
    owner: 'fleet',
    kinds: ['fleet'],
    panel: async (_read, key, absorbedBy) => {
      calls.push(`fleet.panel ${key} ${absorbedBy}`);
      return {
        header: { kind: 'Fleet machine', title: 'Agent machine', says: ['Running'] },
        sections: [facts('Fleet machine', 'machine')],
        actions: [{ ...halt, label: 'Release machine', verb: 'release' }],
        live: true,
      };
    },
    sections: async () => {
      calls.push('fleet.sections');
      return [];
    },
  };
  const code: RunningContribution = {
    owner: 'code-research',
    sections: async (_read, keys) => {
      calls.push(`code.sections ${keys.join(',')}`);
      return [facts('Workspace', 'code'), facts('Needs', 'details', 'Needs')].map((section, at) =>
        at ? { ...section, attention: true } : section,
      );
    },
  };
  const broken: RunningContribution = {
    owner: 'broken',
    sections: async () => {
      throw new Error('broken');
    },
  };
  const panel = await runningPanel(sources([sessions, fleet, code, broken]), caller, 'session:S');
  assert.deepEqual(
    panel.sections.map(({ owner, title }) => `${owner}:${title}`),
    [
      'code-research:Needs',
      'sessions:Merv calls',
      'code-research:Workspace',
      'sessions:Machine',
      'fleet:Fleet machine',
    ],
  );
  assert.deepEqual(calls.sort(), [
    'code.sections session:S,fleet:F',
    'fleet.panel fleet:F session:S',
  ]);
  assert.deepEqual(
    panel.actions.map(({ label }) => label),
    ['Halt lease'],
  );
  assert.deepEqual(panel.actions[0].expect, halt.expect);
  assert.deepEqual(panel.header, {
    kind: 'Agent',
    title: 'Clean the held-out set',
    says: ['Live'],
  });
  assert.equal(panel.route, '/sessions');
  assert.equal(panel.live, true);
  assert.deepEqual(panel.aliases, ['fleet:F']);
  assert.equal(panel.key, 'session:S');
});

test('a sidebar belongs to the first owner of its kind that answers; a 404 means not mine, and any other refusal is the answer', async () => {
  const asked: string[] = [];
  const part = (title: string): RunningPanelPart => ({
    header: { kind: 'Task', title, says: ['Ready'] },
    sections: [],
    actions: [],
    live: false,
  });
  const owner = (name: string, kinds: string[], answer: () => Promise<RunningPanelPart | null>) =>
    ({
      owner: name,
      kinds,
      panel: async () => {
        asked.push(name);
        return await answer();
      },
    }) as RunningContribution;
  const tasks = owner('tasks', ['work'], async () => part('Clean the held-out set'));
  const walk = [
    owner('experiments', ['work'], async () => null),
    owner('reflections', ['work'], async () => {
      throw refusal(404);
    }),
    owner('sessions', ['session'], async () => part('Never asked')),
    tasks,
  ];
  const panel = await runningPanel(sources(walk), caller, 'work:T');
  assert.equal(panel.header.title, 'Clean the held-out set');
  assert.deepEqual(asked, ['experiments', 'reflections', 'tasks']);
  assert.deepEqual(panel.aliases, []);
  assert.equal(panel.route, undefined);

  const refusing = owner('code-research', ['work'], async () => {
    throw refusal(403);
  });
  await assert.rejects(runningPanel(sources([refusing, tasks]), caller, 'work:T'), {
    code: 'refused',
    status: 403,
  });
  await assert.rejects(
    runningPanel(
      sources([owner('broken', ['work'], async () => ({ header: {} }) as never)]),
      caller,
      'work:T',
    ),
    { code: 'running_panel_invalid', status: 500 },
  );
  await assert.rejects(runningPanel(sources(walk), caller, 'fleet:nobody'), {
    code: 'running_not_found',
    status: 404,
  });
  await assert.rejects(runningPanel(sources(walk), caller, 'Work:T'), {
    code: 'invalid_input',
    status: 400,
  });
});

test('the assembled application serves both reads inside one read-only snapshot, to operators and readers alike', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-running-'));
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
  const reader = (
    await app.ctx.scope.issueActor(
      { actorId: credentials.actor.id, projectId: credentials.project.id },
      { name: 'Reader', role: 'reader' },
    )
  ).token;
  const tool = async (name: string, token: string, input: unknown = {}) => {
    const response = await fetch(`${app.ctx.api.url}/tools/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  for (const token of [credentials.token, reader]) {
    const answer = await tool('ui.running', token);
    assert.equal(answer.status, 200);
    const { observedAt, lanes, edges } = answer.body.result as RunningBoard;
    assert.ok(!Number.isNaN(Date.parse(observedAt)));
    assert.deepEqual(Object.keys(lanes), ['work', 'sessions', 'hardware']);
    for (const lane of Object.values(lanes)) {
      assert.ok(Array.isArray(lane.nodes) && Array.isArray(lane.summaries));
      assert.equal(typeof lane.needsYou, 'number');
      assert.deepEqual(lane.failed, []);
    }
    assert.ok(Array.isArray(edges));
    const missing = await tool('ui.running_panel', token, { key: 'work:nothing' });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'running_not_found');
  }
  assert.equal(
    (await tool('ui.running_panel', credentials.token, { key: 'Nope' })).body.error.code,
    'invalid_input',
  );
  const declared = (await app.ctx.tools.list()).filter(({ name }) => name.startsWith('ui.running'));
  assert.deepEqual(
    declared.map((definition) => {
      const { name, readOnly, conversation } = definition as {
        name: string;
        readOnly?: boolean;
        conversation?: string;
      };
      return { name, readOnly, conversation };
    }),
    [
      { name: 'ui.running', readOnly: true, conversation: 'never' },
      { name: 'ui.running_panel', readOnly: true, conversation: 'never' },
    ],
  );

  // Every part reads inside the tool's snapshot, where a write is refused, and an action
  // reaches the page only for a tool this server has.
  const where = () => (app.ctx.state.readScope ? 'Read in the snapshot' : 'Read outside it');
  const dispose = app.ctx.ui.contribute({
    owner: 'probe',
    kinds: ['probe'],
    lanes: ['work'],
    nodes: async () => ({ nodes: [node('work:probe', 'work', { title: where() })] }),
    summary: async (): Promise<RunningSummary> => ({
      lane: 'work',
      says: ['Dispatch on'],
      actions: [
        {
          label: 'Pause dispatch',
          verb: 'pause',
          tool: 'session.dispatch',
          input: { enabled: false },
          allowed: true,
        },
        {
          label: 'Halt lease',
          verb: 'halt',
          tool: 'nowhere.halt',
          input: { reason: 'halted_by_operator' },
          allowed: true,
        },
      ],
    }),
    panel: async (_read, key) => {
      if (key === 'probe:write')
        await app.ctx.state.transaction(
          async (tx) => await tx.run('DELETE FROM events WHERE false'),
        );
      return {
        header: { kind: 'Probe', title: where(), says: [] },
        sections: [],
        actions: [],
        live: false,
      };
    },
  });
  const disposeWriter = app.ctx.ui.contribute({
    owner: 'writer',
    lanes: ['hardware'],
    nodes: async () => {
      await app.ctx.state.transaction(async (tx) => await tx.run('DELETE FROM events WHERE false'));
      return { nodes: [node('sandbox:written', 'hardware')] };
    },
  });
  t.after(() => (dispose(), disposeWriter()));
  const answer = (await tool('ui.running', reader)).body.result as RunningBoard;
  assert.equal(find(answer, 'work:probe')?.title, 'Read in the snapshot');
  assert.equal(find(answer, 'sandbox:written'), undefined);
  assert.ok(answer.lanes.hardware.failed.includes('writer'));
  assert.deepEqual(answer.lanes.work.failed, []);
  assert.deepEqual(
    answer.lanes.work.summaries
      .find(({ owner }) => owner === 'probe')
      ?.actions.map(({ tool }) => tool),
    ['session.dispatch'],
  );
  const read = await tool('ui.running_panel', reader, { key: 'probe:read' });
  assert.equal(read.body.result.header.title, 'Read in the snapshot');
  const write = await tool('ui.running_panel', credentials.token, { key: 'probe:write' });
  assert.equal(write.status, 409);
  assert.equal(write.body.error.code, 'read_only_scope');
});
