/**
 * The Code page, rendered. With no repository and nothing made it says one thing
 * and offers one control; with a repository and nothing made, each section is its
 * name and a zero, and never a sentence about what is not there. With work in it,
 * the model is the one truth the drawing and the phone's list are both built from.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  CodeBasePin,
  CodeBaseRecord,
  CodeUnit,
  CodeUnitAcceptance,
} from '@merv/contracts/code-units';
import type { CodeCommandRecord, CodeProjectStatus } from '@merv/contracts/code';
import type { CodePublication } from '@merv/contracts/types';
import { mount, serve, text, unmount } from './ui-render.js';

const { createElement } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
const { CodePage } = await import('../packages/ui/web/views/code.js');
const { gitModel, relationsOf } = await import('../packages/ui/web/views/code-model.js');
const { canvas, BranchCanvas, BranchList } =
  await import('../packages/ui/web/views/code-canvas.js');

/** jsdom measures nothing, so the one width the drawing places itself from is handed to it. */
const MEASURED = 1440;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver = class {
  constructor(private ran: (entries: { contentRect: { width: number } }[]) => void) {}
  observe() {
    this.ran([{ contentRect: { width: MEASURED } }]);
  }
  disconnect() {}
};
const { UnitCode } = await import('../packages/ui/web/views/code-section.js');

const row = {
  id: 'code',
  label: 'Code',
  group: 'operations',
  order: 30,
  path: '/code',
  view: { kind: 'code' },
  status: {},
  readable: true,
};
const waves = {
  ...row,
  id: 'consolidation',
  path: '/consolidation',
  view: { kind: 'consolidation' },
};
const page = (rows = [row]) =>
  createElement(
    MemoryRouter,
    { initialEntries: ['/code'] },
    createElement(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      CodePage as any,
      { row, shell: { rows, plugins: [] }, operator: true, named: () => undefined },
    ),
  );
const github = (over: Record<string, unknown> = {}) => ({
  body: {
    configured: true,
    revision: 0,
    status: 'disconnected',
    user: null,
    repository: null,
    canManage: true,
    canBrowse: false,
    installUrl: null,
    automationConfigured: false,
    automation: 'off',
    baseBranch: null,
    ...over,
  },
});
const connected = (over: Record<string, unknown> = {}) =>
  github({
    status: 'connected',
    repository: { fullName: 'lab/grokking', defaultBranch: 'main', private: true, url: '' },
    ...over,
  });
const nothingMade = () => {
  serve('/tools/ui.read', { body: { result: { commands: [] } } });
  serve('/tools/ui.home', { body: { result: {} } });
  serve('/code/publications', { body: { publications: [] } });
};

test('with GitHub not connected the page is one empty state and its one control', async (t) => {
  t.after(unmount);
  nothingMade();
  serve('/code/github', github());
  await mount(page());
  const empty = document.querySelector('.empty-state');
  assert.ok(empty, text().slice(0, 400));
  assert.ok(empty.querySelector('svg'), 'the state wears its glyph');
  assert.equal(empty.querySelector('h2')?.textContent, 'GitHub not connected');
  const control = empty.querySelector('a.btn--primary');
  assert.equal(control?.textContent, 'Connect GitHub');
  assert.equal(control?.getAttribute('href'), '/settings/integrations');
  for (const gone of ['Branches', 'Pull requests', 'No branches yet', 'No pull requests yet'])
    assert.ok(!text().includes(gone), `“${gone}” is still on the page: ${text()}`);
});

test('connected with nothing made, a section is its name and a zero', async (t) => {
  t.after(unmount);
  nothingMade();
  serve('/code/github', connected());
  await mount(page());
  assert.equal(document.querySelector('.empty-state'), null);
  assert.ok(text().includes('Branches 0'), text());
  assert.ok(text().includes('Merges 0'), text());
  assert.ok(text().includes('Pull requests 0'), text());
  assert.ok(!/No (branches|pull requests)/.test(text()), text());
});

/* The model ---------------------------------------------------------------- */

/** A unit as Code reports one, with only what the drawing reads spelled out. */
const unit = (id: string, over: Partial<CodeUnit> = {}): CodeUnit => ({
  unitId: id,
  workflow: 'task',
  version: 1,
  declaredAt: '2026-09-01T00:00:00.000Z',
  branch: `merv/work/${id}`,
  base: null,
  baseStatus: { status: 'waiting' },
  acceptance: null,
  generation: 0,
  writerState: 'idle',
  canonicalHead: null,
  mirroredHead: null,
  mirroredAt: null,
  quarantine: null,
  ...over,
});
const pin = (
  kind: CodeBasePin['kind'],
  reference: string,
  sources: string[] = [],
): CodeBasePin => ({
  unitId: '',
  kind,
  reference,
  sources: sources.map((id) => ({ unitId: id, acceptanceHash: `h_${id}` })),
  pinnedAt: '',
  leaseId: '',
});
const accepted = (commit: string): CodeUnitAcceptance => ({
  unitId: '',
  hash: `h_${commit}`,
  acceptedAt: '2026-09-02T00:00:00.000Z',
  terminalRevision: 4,
  submissionRef: 'sub',
  reviewRef: 'review_00000000000000000000000000000001',
  acceptedBy: 'actor_1',
  reference: commit,
  reviewAttached: true,
  storage: 'code',
});
const base = (key: string, over: Partial<CodeBaseRecord>): CodeBaseRecord => ({
  key,
  members: [],
  left: 'l',
  right: 'r',
  parents: [null, null],
  state: 'waiting_inputs',
  quarantined: false,
  result: null,
  conflict: null,
  resolutionTaskId: null,
  resolutionError: null,
  attempts: 0,
  executionEpoch: 1,
  deadline: null,
  sponsors: [],
  blocker: null,
  operatorReason: null,
  updatedAt: '2026-09-03T00:00:00.000Z',
  ...over,
});
const receipt = (id: string, head: string, add: number): CodeCommandRecord => ({
  command: {
    id: `cmd_${head}`,
    projectId: 'p',
    sessionId: 's',
    actorId: 'a',
    instanceId: id,
    expectedRevision: 1,
    runnerId: 'r',
    hostRef: 'h',
    message: `work on ${head}`,
    expectedHead: 'c0',
    createdAt: `2026-09-01T0${add}:00:00.000Z`,
    workspace: {
      repositoryId: 'repo',
      workspaceId: 'w',
      mode: 'persistent',
      branch: `merv/work/${id}`,
      baseOid: 'c0',
      headOid: head,
      stats: { commitCount: 1, filesChanged: 1, insertions: add, deletions: 1 },
    },
  },
  status: 'succeeded',
  receipt: {
    commandId: `cmd_${head}`,
    repositoryId: 'repo',
    workspaceId: 'w',
    baseOid: 'c0',
    parentOid: 'c0',
    headOid: head,
    treeOid: 't',
    stats: { commitCount: 1, filesChanged: 1, insertions: add, deletions: 1 },
  },
  error: null,
});
const published = (over: Partial<CodePublication> = {}): CodePublication => ({
  proposalId: 'p1',
  instanceId: 'u7',
  manifestHash: 'mh',
  repository: 'lab/grokking',
  repositoryId: 1,
  connectionRevision: 1,
  branch: 'merv/publish/p1',
  baseBranch: 'main',
  baseOid: 'c0',
  headOid: 'g1',
  treeOid: 't',
  title: 'Wave one',
  createdAt: '2026-09-05T00:00:00.000Z',
  review: { id: 'r', actorId: 'a', verdict: 'pass', recordedAt: '' },
  pull: null,
  lastError: null,
  merge: { requestId: 'q', actorId: 'a', expectedBase: 'c0', requestedAt: '', commitSha: 'g1' },
  ...over,
});
/** The whole project read, of which the drawing uses two parts. */
const status = (units: CodeUnit[], bases: CodeBaseRecord[]): CodeProjectStatus => ({
  project: null,
  store: null,
  operations: [],
  mirror: null,
  warnings: [],
  blockers: [],
  units,
  bases,
});

/**
 * One project holding every shape the canvas can draw: a lane cut from the trunk
 * with receipts and one without, a lane cut from another lane, a clean merge and
 * the lane pinned on it, a conflicted merge with its resolution task and a lane
 * waiting behind it, a quarantined lane, a lane tainted by a quarantined base,
 * and a publication that reached main.
 */
const project = () => {
  const units = [
    unit('u1', {
      base: pin('main', 'c0'),
      acceptance: accepted('c1'),
      generation: 1,
      writerState: 'closed',
      canonicalHead: 'c1',
      mirroredHead: 'r1',
      mirroredAt: '2026-09-02T00:00:00.000Z',
      baseStatus: null,
    }),
    unit('u2', {
      base: pin('accepted', 'c1', ['u1']),
      acceptance: accepted('c2'),
      canonicalHead: 'c2',
      mirroredHead: 'c2',
      baseStatus: null,
    }),
    unit('u3', {
      base: pin('main', 'c0'),
      acceptance: accepted('c3'),
      canonicalHead: 'c3',
      mirroredHead: 'c3',
      baseStatus: null,
    }),
    unit('u4', {
      base: pin('merged', 'm1', ['u2', 'u3']),
      generation: 2,
      writerState: 'active',
      canonicalHead: 'w4',
      mirroredHead: null,
      baseStatus: { status: 'pinned', pin: pin('merged', 'm1', ['u2', 'u3']) },
    }),
    unit('u5', {
      base: pin('main', 'c0'),
      baseStatus: { status: 'pinned', pin: pin('main', 'c0') },
    }),
    unit('u6', { baseStatus: { status: 'blocked', blockers: [], merge: ['c1', 'm1'] } }),
    unit('u7', {
      base: pin('main', 'c0'),
      acceptance: accepted('c7'),
      canonicalHead: 'c7',
      mirroredHead: 'c7',
      baseStatus: null,
    }),
    unit('u8', {
      quarantine: { operationId: 'op_1' },
      canonicalHead: 'w8',
      generation: 1,
      writerState: 'recovery_required',
      baseStatus: { status: 'pinned', pin: pin('main', 'c0') },
    }),
    // Tainted through a quarantined base rather than by its own capture: the server
    // says so with a blocker and no quarantine of its own.
    unit('u9', {
      baseStatus: {
        status: 'blocked',
        blockers: [
          {
            key: 'quarantine',
            code: 'code_quarantined',
            status: 409,
            message: 'This unit uses a quarantined base.',
            next: 'An administrator creates corrective work.',
            related: [],
          },
        ],
      },
    }),
  ];
  const bases = [
    base('b1', {
      members: ['c2', 'c3'],
      parents: ['c2', 'c3'],
      state: 'resolved',
      quarantined: true,
      result: { method: 'auto', commit: 'm1', tree: 't', engine: 'git' },
    }),
    base('b2', {
      members: ['c1', 'm1'],
      parents: ['c1', 'm1'],
      state: 'awaiting_resolution',
      conflict: { paths: ['train/loop.py'], messages: 'both changed' },
      resolutionTaskId: 'u5',
    }),
  ];
  const names = new Map([
    ['main', { name: 'main' }],
    ['u1', { name: 'Pin the tokenizer', to: '/tasks/u1' }],
    ['u2', { name: 'Baseline p97', to: '/experiments/u2' }],
    ['u3', { name: 'Sweep depth', to: '/experiments/u3' }],
    ['u4', { name: 'Fold both sweeps', to: '/tasks/u4' }],
    ['u5', { name: 'Resolve loader', to: '/tasks/u5' }],
    ['u6', { name: 'Long-run grokking', to: '/experiments/u6' }],
    ['u7', { name: 'Wave one', to: '/consolidation/u7' }],
    ['u9', { name: 'Re-run the ablation grid', to: '/experiments/u9' }],
  ]);
  const commands = [receipt('u1', 'a1', 1), receipt('u1', 'a2', 2), receipt('u1', 'c1', 3)];
  return gitModel(status(units, bases), commands, [published()], names);
};

test('the model draws every kind of node and states every relation a record carries', () => {
  const model = project();
  assert.deepEqual(
    [...new Set(model.nodes.map((node) => node.kind))].sort(),
    ['base', 'main', 'publication', 'unit'],
    'all four node kinds',
  );
  assert.deepEqual(
    [...new Set(model.edges.map((edge) => edge.verb))].sort(),
    [
      'based on',
      'member of',
      'merged from',
      'merged into',
      'pinned to',
      'published from',
      'resolved by',
      'waiting on',
    ],
    'every verb some field expresses',
  );
  const has = (from: string, verb: string, to: string) =>
    model.edges.some((edge) => edge.from === from && edge.verb === verb && edge.to === to);
  assert.ok(has('u1', 'based on', 'u2'), 'a single-source pin is lane to lane');
  assert.ok(has('u2', 'member of', 'b1') && has('u3', 'member of', 'b1'));
  assert.ok(has('b1', 'pinned to', 'u4'), 'the base was handed to the unit that pinned it');
  assert.ok(has('b1', 'merged from', 'b2'), 'the pairwise plan reads as a tree');
  assert.ok(has('b2', 'resolved by', 'u5'), 'the conflict and its cure are one picture');
  assert.ok(has('p1', 'merged into', 'main') && has('u7', 'published from', 'p1'));
  // Waiting is a shape, joined by the member set alone: no key is asked of the server.
  const waiting = model.edges.find((edge) => edge.verb === 'waiting on');
  assert.deepEqual([waiting?.from, waiting?.to, waiting?.dashed], ['b2', 'u6', true]);

  // A unit with receipts is dotted; a unit with none is still one plain segment.
  const lane = (id: string) => model.lanes.find((item) => item.id === id)!;
  assert.deepEqual(
    lane('u1').stops.map((stop) => stop.oid),
    ['a1', 'a2', 'c1'],
  );
  assert.deepEqual(
    lane('u3').stops.map((stop) => stop.stat),
    [null],
    'a lane that never committed through code.commit is drawn all the same',
  );
  assert.equal(lane('u1').mirrored, 0, 'a mirror at a head no receipt names holds the whole lane');
  assert.equal(lane('u2').mirrored, lane('u2').stops.length, 'a level mirror hollows nothing');
  assert.equal(lane('u4').from, 'b1', 'a merged pin is cut from the base it names');
  assert.equal(lane('u2').from, 'u1', 'an accepted pin is cut from the lane it names');
  assert.deepEqual([lane('u1').tip, lane('u4').tip, lane('u6').tip], ['accepted', 'head', 'none']);

  // Ranks are topological, so a merge reads left of what was merged into it.
  const rank = (id: string) => model.ranks.get(id)!;
  assert.equal(rank('main'), 0);
  assert.ok(rank('b1') > rank('u2') && rank('u4') > rank('b1'));
  assert.ok(rank('b2') > rank('b1') && rank('u6') > rank('b2'));

  // One standing word each, and the one shape that says a thing cannot be reused.
  assert.equal(model.word.get('u1'), 'accepted');
  assert.equal(model.word.get('u4'), 'working');
  assert.equal(model.word.get('u6'), 'conflicted');
  assert.equal(model.word.get('u8'), 'quarantined');
  assert.equal(model.word.get('b2'), 'awaiting_resolution');
  // A quarantined base says so in the word as well as in the shape: what it reached is
  // no longer the fact about it, and the hollow mark alone cannot be read aloud.
  assert.equal(model.word.get('b1'), 'quarantined');
  assert.equal(model.word.get('u9'), 'quarantined', 'a taint through the lineage is the same word');
  const hollow = (id: string) => model.nodes.find((node) => node.id === id)?.hollow;
  assert.deepEqual([hollow('u8'), hollow('b1'), hollow('u9')], [true, true, true]);
  assert.equal(hollow('u6'), false, 'a conflict is work in flight and is not a refusal');
  // A lane no list names is drawn as the branch it is, never dropped.
  assert.equal(model.nodes.find((node) => node.id === 'u8')?.name, 'merv/work/u8');
  assert.equal(model.nodes.find((node) => node.id === 'u2')?.colour, 'experiments');
  assert.equal(model.nodes.find((node) => node.id === 'u7')?.colour, 'consolidation');

  // A base is placed where its last member arrives, under the merge it was made from,
  // and what it resolves comes under it.
  const row = (id: string) => model.nodes.find((node) => node.id === id)!.row;
  assert.ok(row('u2') < row('b1') && row('u3') < row('b1') && row('b1') < row('b2'));
  assert.ok(row('b2') < row('u5') && row('u5') < row('u6'));
});

test('a relation is said by the record whose own field says it', () => {
  const model = project();
  const said = relationsOf(model);
  const of = (id: string) => said.get(id) ?? [];
  assert.ok(of('u2').includes('based on Pin the tokenizer'), of('u2').join(' · '));
  assert.ok(!of('u1').some((line) => line.startsWith('based on')), 'never on what it was cut from');
  assert.ok(of('u6').includes('waiting on A merge of 2'), of('u6').join(' · '));
  assert.ok(!of('b2').some((line) => line.startsWith('waiting on')), 'a base waits on nothing');
  assert.ok(of('u4').includes('pinned to A merge of 2'), of('u4').join(' · '));
  assert.ok(of('u2').includes('member of A merge of 2'), 'a member says what it is a member of');
  assert.ok(of('b2').includes('resolved by Resolve loader'), of('b2').join(' · '));
  assert.ok(of('b2').includes('merged from A merge of 2'), 'the later merge names the earlier');
  assert.ok(of('p1').includes('published from Wave one'), of('p1').join(' · '));
  assert.ok(of('p1').includes('merged into main'), of('p1').join(' · '));
});

test('the drawing and the list are placed from the same model, or not placed at all', () => {
  const model = project();
  assert.equal(canvas(model, 899), null, 'below 900 there is no room for a lane and its label');
  for (const width of [1280, 2560]) {
    const placed = canvas(model, width)!;
    assert.ok(placed, `${width} places the drawing`);
    assert.deepEqual(
      placed.lanes.map((lane) => lane.id),
      model.lanes.map((lane) => lane.id),
      'the drawing places every lane the model holds and invents none',
    );
    assert.deepEqual(
      [...placed.at.keys()].sort(),
      model.nodes.map((node) => node.id).sort(),
      'and every node',
    );
    // A lane ends where its own node stands, which is where every edge that names it is
    // drawn to — including a lane that has committed nothing at all.
    for (const lane of placed.lanes)
      assert.equal(lane.tip.x, placed.at.get(lane.id)!.x, `${lane.id} ends at its own node`);
    // The page column uses the width it is given, right up to the widest screen.
    assert.ok(placed.trunk.end > width - 8, `the trunk reaches the edge at ${width}`);
    assert.ok(placed.lanes.every((lane) => lane.tip.x <= width));
    const deepest = Math.max(...[...placed.at.values()].map((point) => point.x));
    const column = (width - 360 - 48) / Math.max(...model.ranks.values());
    assert.ok(width - 48 - deepest < column, `the drawing reaches the right edge at ${width}`);
    // Main is named at the commit the lanes were cut from, merged publication or not.
    assert.ok(placed.trunk.solid > placed.trunk.x0);
  }
  const bare = gitModel(
    status([unit('u1', { base: pin('main', 'c0'), canonicalHead: 'c1', baseStatus: null })], []),
    [],
    [],
    new Map(),
  );
  assert.ok(canvas(bare, 1280)!.trunk.solid > canvas(bare, 1280)!.trunk.x0, 'with nothing merged');
  // The stretch the mirror has not published is an element, never a number.
  const held = canvas(model, 1280)!.lanes.find((lane) => lane.id === 'u1')!;
  assert.ok(held.hollow, 'a lane ahead of its mirror is drawn hollow');
  assert.equal(canvas(model, 1280)!.lanes.find((lane) => lane.id === 'u2')!.hollow, null);
});

test('a mirror part way up a lane hollows the stretch past it and no more', () => {
  const held = unit('u1', {
    base: pin('main', 'c0'),
    canonicalHead: 'a3',
    mirroredHead: 'a2',
    mirroredAt: '2026-09-02T00:00:00.000Z',
    baseStatus: null,
  });
  const model = gitModel(
    status([held], []),
    [receipt('u1', 'a1', 1), receipt('u1', 'a2', 2), receipt('u1', 'a3', 3)],
    [],
    new Map(),
  );
  const lane = model.lanes[0]!;
  assert.equal(lane.stops.length, 3);
  assert.equal(lane.mirrored, 2, 'two of the three commits have been published');
  const placed = canvas(model, 1280)!.lanes[0]!;
  assert.ok(
    placed.hollow?.startsWith(`M ${placed.dots[1]!.x},`),
    `the hollow stretch begins at the last published commit: ${placed.hollow}`,
  );
});

test('too narrow to draw, the same model reads as a list of the same nodes', async (t) => {
  t.after(unmount);
  const model = project();
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/code'] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createElement(BranchList as any, { model }),
    ),
  );
  const rows = [...document.querySelectorAll('.map-node')];
  assert.equal(rows.length, model.nodes.length, 'one row per node the model holds');
  for (const node of model.nodes)
    assert.ok(text().includes(node.name), `${node.name} is on screen`);
  // The words are the drawing's own lines, said by the record each one belongs to.
  const said = (name: string) => rows.find((item) => item.textContent?.includes(name))!.textContent;
  assert.ok(said('Long-run grokking')?.includes('waiting on A merge of 2'), said('Long-run'));
  assert.ok(said('Baseline p97')?.includes('based on Pin the tokenizer'), said('Baseline p97'));
  assert.ok(!said('Fold both sweeps')?.includes('waiting on'), said('Fold both sweeps'));
  // What the drawing would draw hollow wears the refusal here, and says the word too.
  for (const name of ['merv/work/u8', 'Re-run the ablation grid']) {
    const refused = rows.find((item) => item.textContent?.includes(name));
    assert.ok(refused?.className.includes('code-refused'), `${name} wears the refusal`);
    assert.ok(/QUARANTINED/i.test(refused.textContent ?? ''), refused.textContent);
  }
  const merges = rows.filter((item) => item.textContent?.includes('A merge of 2'));
  const refused = merges.filter((item) => item.className.includes('code-refused'));
  assert.equal(refused.length, 1, 'the quarantined base, and only it, wears the refusal');
  assert.ok(/QUARANTINED/i.test(refused[0]!.textContent ?? ''), refused[0]!.textContent);
});

test('the drawing is one SVG, with a mark for every node the model holds', async (t) => {
  t.after(unmount);
  const model = project();
  const placed = canvas(model, MEASURED)!;
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/code'] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createElement(BranchCanvas as any, { model }),
    ),
  );
  const svg = document.querySelector('svg.branch-graph');
  assert.ok(svg, text().slice(0, 300));
  assert.equal(svg.getAttribute('viewBox'), `0 0 ${placed.width} ${placed.height}`);
  assert.ok(svg.querySelector('.bg-trunk--beyond'), 'main runs on past what Merv can name');
  assert.equal(svg.querySelectorAll('.bg-lane:not(.bg-lane--hollow)').length, model.lanes.length);
  assert.equal(
    svg.querySelectorAll('.bg-lane--hollow').length,
    placed.lanes.filter((lane) => lane.hollow).length,
    'every lane ahead of its mirror is drawn hollow, and no other',
  );
  const kindCount = (kind: string) => model.nodes.filter((node) => node.kind === kind).length;
  assert.equal(svg.querySelectorAll('.bg-merge').length, kindCount('base'));
  assert.equal(svg.querySelectorAll('.bg-ring').length, kindCount('publication'));
  assert.equal(svg.querySelectorAll('.bg-edge').length, model.edges.length);
  assert.equal(svg.querySelectorAll('.bg-hollow').length, 2, 'the quarantined marks are hollow');
  // A base key is a digest that names nobody, and is never on screen.
  for (const key of ['b1', 'b2']) assert.ok(!text().includes(key), text());
});

test('the page builds its model from what it reads, and titles nothing twice', async (t) => {
  t.after(unmount);
  serve('/tools/ui.read', {
    body: {
      result: {
        commands: [receipt('u1', 'c1', 3)],
        status: status(
          [
            unit('u1', {
              base: pin('main', 'c0'),
              acceptance: accepted('c1'),
              generation: 1,
              canonicalHead: 'c1',
              mirroredHead: 'c1',
              baseStatus: null,
            }),
            unit('u2', {
              base: pin('main', 'c0'),
              acceptance: accepted('c2'),
              canonicalHead: 'c2',
              baseStatus: null,
            }),
            unit('u7', { base: pin('main', 'c0'), baseStatus: { status: 'waiting' } }),
          ],
          [base('b1', { members: ['c1', 'c2'], state: 'queued' })],
        ),
      },
    },
  });
  serve('/tools/ui.home', {
    body: { result: { tasks: [{ id: 'u1', title: 'Pin the tokenizer' }] } },
  });
  serve('/tools/consolidation.list', { body: { result: [{ id: 'u7', name: 'Wave one' }] } });
  serve('/code/publications', { body: { publications: [published()] } });
  serve('/code/github', connected({ baseBranch: 'trunk' }));
  await mount(page([row, waves]));
  assert.ok(text().includes('Branches 3'), text().slice(0, 400));
  assert.ok(text().includes('Merges 1'), text().slice(0, 400));
  // The shell titles the row, so the page adds no heading of its own.
  assert.equal(document.querySelector('h1'), null, text().slice(0, 200));
  // Only one of the two says the pull request count: the section that lists them.
  assert.equal(text().match(/Pull requests/g)?.length, 1, text());
  const labels = [...document.querySelectorAll('.bg-name')].map((node) => node.textContent);
  assert.ok(
    labels.some((label) => label?.includes('Pin the tokenizer')),
    `a lane is named by its record: ${labels.join(' · ')}`,
  );
  assert.ok(
    labels.some((label) => label?.includes('Wave one')),
    labels.join(' · '),
  );
  assert.equal(document.querySelector('.bg-ref')?.textContent, 'trunk', 'the trunk is named');
});

/* The record's own section ------------------------------------------------- */

test("a record's Code section states the branch, its base, its work and its acceptance", async (t) => {
  t.after(unmount);
  serve('/tools/ui.home', { body: { result: {} } });
  const held = unit('u4', {
    base: pin('merged', 'm1', ['u2', 'u3']),
    generation: 2,
    writerState: 'active',
    canonicalHead: 'w4commit0000',
    mirroredHead: 'w3commit0000',
    mirroredAt: '2026-09-04T00:00:00.000Z',
    baseStatus: { status: 'pinned', pin: pin('merged', 'm1', ['u2', 'u3']) },
  });
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/tasks/u4'] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createElement(UnitCode as any, { unit: held, named: () => 'Ada' }),
    ),
  );
  const said = text();
  assert.ok(said.includes('merv/work/u4'), said);
  assert.ok(said.includes('a merge of 2 accepted commits'), said);
  // The mirror clause is about the commit the mirror holds, never the head beside it.
  assert.ok(said.includes('the mirror is at w3commit0000'), said);
  assert.ok(!/the mirror is at w4/.test(said), said);
  assert.ok(!/\d+ behind/.test(said), said);
  // Absence renders nothing: this unit has no acceptance, so it has no Accepted line.
  assert.ok(!said.includes('Accepted'), said);
  assert.ok(!said.includes('blocker'), 'no blocker is printed in this wave');
  assert.equal(document.querySelector('a.btn-text')?.getAttribute('href'), '/code');
});

test('a pin on the trunk says what it is, and never a branch name this page invented', async (t) => {
  t.after(unmount);
  serve('/tools/ui.home', { body: { result: {} } });
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/tasks/u1'] },
      createElement(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        UnitCode as any,
        { unit: unit('u1', { base: pin('main', 'c0') }), named: () => undefined },
      ),
    ),
  );
  assert.ok(text().includes('the base branch'), text());
  assert.ok(
    !text().includes('main'),
    `the repository's own name for it is not known here: ${text()}`,
  );
});

test('a quarantined unit wears the refusal and says what cannot be reused', async (t) => {
  t.after(unmount);
  serve('/tools/ui.home', { body: { result: {} } });
  const held = unit('u8', {
    quarantine: { operationId: 'op_1' },
    acceptance: { ...accepted('c8'), storage: 'none' },
    baseStatus: null,
  });
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/experiments/u8'] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createElement(UnitCode as any, { unit: held, named: () => undefined }),
    ),
  );
  assert.ok(document.querySelector('.code-refused'), text());
  assert.ok(text().includes('cannot be reused'), text());
  assert.ok(text().includes('succeeded without code'), text());
});
