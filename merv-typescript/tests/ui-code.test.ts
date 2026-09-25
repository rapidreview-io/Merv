/**
 * The Code page, rendered. With no repository and nothing made it says one thing
 * and offers one control; with a repository and nothing made, each section is its
 * name and a zero, and never a sentence about what is not there. With work in it,
 * the model is the one truth the drawing and the phone's list are both built from.
 */
import type { CodeCommandRecord, CodeProjectStatus } from '@merv/contracts/code';
import type {
  CodeBasePin,
  CodeBaseRecord,
  CodeUnit,
  CodeUnitAcceptance,
} from '@merv/contracts/code-units';
import type { CodePublication, GitHubStatus } from '@merv/contracts/types';
import assert from 'node:assert/strict';
import test from 'node:test';
import { click, mount, requests, serve, settle, text, unmount } from './ui-render.js';

// The credential is read as api.ts is evaluated, so it is stored before anything loads.
sessionStorage.setItem('merv:token', 'fixture-token');

const { createElement, useEffect, useState } = await import('react');
const { act } = await import('react-dom/test-utils');
const { MemoryRouter, useLocation } = await import('react-router-dom');
const { CodePage, managesCode, signedInAdmin } = await import('../packages/ui/web/views/code.js');
const { PageLede } = await import('../packages/ui/web/shell.js');
const { chipsOf, gitModel, relationsOf, waitersOf } =
  await import('../packages/ui/web/views/code-model.js');
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
const { firstPersonMove, personMove, publicationBlocker } =
  await import('../packages/ui/web/views/code-blockers.js');

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
/** Where the page thinks it is, which is the one thing that says a node is selected. */
let where = '';
const Probe = () => {
  const { pathname } = useLocation();
  useEffect(() => {
    where = pathname;
  }, [pathname]);
  return null;
};
/**
 * The page inside the frame that titles it, because the counts it makes stand on the
 * shell's own line and nowhere else. `manages` is the principal: false is what a leased
 * session sees.
 */
const page = (rows = [row], { at = '/code', manages = true, signedIn = manages } = {}) =>
  createElement(
    MemoryRouter,
    { initialEntries: [at] },
    createElement(Probe),
    createElement(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      PageLede as any,
      { rows },
      createElement(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        CodePage as any,
        {
          row,
          shell: { rows, plugins: [] },
          manages,
          signedIn,
          named: () => undefined,
        },
      ),
    ),
  );
/** Press a node of the drawing by the name it carries, which is what a reader presses. */
const pickNode = async (name: string) => {
  const label = [
    ...document.querySelectorAll('svg .bg-name title, svg .bg-ring title, .bg-ref'),
  ].find((node) => node.textContent === name);
  const node = label?.closest('g.bg-node');
  if (!node) throw new Error(`No node reading “${name}”. Page: ${text().slice(0, 600)}`);
  await press(node);
};
/** A merge is a mark and not a word, so it is pressed by where it stands in the plan. */
const pickBase = async (at: number) => {
  const mark = [...document.querySelectorAll('svg .bg-merge')][at]?.closest('g.bg-node');
  if (!mark) throw new Error(`No merge at ${at}. Page: ${text().slice(0, 600)}`);
  await press(mark);
};
const press = async (node: Element) => {
  await act(async () => {
    node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  await settle(0);
};
/** Answer a field by its label, the way a person does: type, and let the page follow. */
const write = async (label: string, value: string) => {
  const field = [...document.querySelectorAll('label')]
    .find((item) => item.textContent?.startsWith(label))
    ?.querySelector<HTMLTextAreaElement | HTMLInputElement>('textarea, input');
  if (!field) throw new Error(`No field called “${label}”. Page: ${text().slice(0, 600)}`);
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!;
  await act(async () => {
    set.call(field, value);
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await settle(0);
};
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
  publication: null,
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
  checkState: 'none',
  check: null,
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
const status = (
  units: CodeUnit[],
  bases: CodeBaseRecord[],
  over: Partial<CodeProjectStatus> = {},
): CodeProjectStatus => ({
  project: null,
  store: null,
  operations: [],
  mirror: null,
  warnings: [],
  blockers: [],
  units,
  bases,
  ...over,
});
/** One opinion Code published about why a unit cannot proceed. */
const blocker = (
  instanceId: string,
  code: string,
  related: { kind: string; id: string; label: string }[] = [],
): CodeProjectStatus['blockers'][number] => ({
  instanceId,
  provider: 'code',
  key: 'merge',
  code,
  status: 409,
  message: 'Code says so.',
  next: 'An operator looks at the base.',
  related,
  since: '2026-09-04T00:00:00.000Z',
  updatedAt: '2026-09-04T00:00:00.000Z',
});

/**
 * One project holding every shape the canvas can draw: a lane cut from the trunk
 * with receipts and one without, a lane cut from another lane, a clean merge and
 * the lane pinned on it, a conflicted merge with its resolution task and a lane
 * waiting behind it, a quarantined lane, a lane tainted by a quarantined base,
 * and a publication that reached main.
 */
const units = (): CodeUnit[] => [
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
const bases = (): CodeBaseRecord[] => [
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
  ['u7', { name: 'Wave one', to: '/tasks/u7' }],
  ['u9', { name: 'Re-run the ablation grid', to: '/experiments/u9' }],
]);
const commands = () => [receipt('u1', 'a1', 1), receipt('u1', 'a2', 2), receipt('u1', 'c1', 3)];
const project = () => gitModel(status(units(), bases()), commands(), [published()], names);

/** That same project as the page reads it, with the lists that name its lanes. */
const servedProject = (over: Partial<CodeProjectStatus> = {}, records = bases()) => {
  serve('/tools/ui.read', {
    body: { result: { commands: commands(), status: status(units(), records, over) } },
  });
  serve('/tools/ui.home', {
    body: {
      result: {
        tasks: [
          { id: 'u1', title: 'Pin the tokenizer' },
          { id: 'u4', title: 'Fold both sweeps' },
          { id: 'u5', title: 'Resolve loader' },
          { id: 'u7', title: 'Wave one' },
        ],
        experiments: [
          { id: 'u2', name: 'Baseline p97' },
          { id: 'u3', name: 'Sweep depth' },
          { id: 'u6', name: 'Long-run grokking' },
          { id: 'u9', name: 'Re-run the ablation grid' },
        ],
      },
    },
  });
  serve('/code/publications', { body: { publications: [published()] } });
  serve('/code/github', connected());
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
  assert.equal(model.nodes.find((node) => node.id === 'u7')?.colour, 'tasks');

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
  assert.equal(canvas(model, 799), null, 'under its own minimum there is no room to place it');
  // The room a 1440 screen leaves beside the card, with the rail open: the drawing is
  // placed there rather than falling back to the list beside an orphaned card.
  assert.ok(canvas(model, 820), 'the drawing is placed in the room the card leaves at 1440');
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
    const column = (width - 300 - 48) / Math.max(...model.ranks.values());
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
      createElement(BranchList as any, { model, selected: null, onSelect: () => {} }),
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

test('with no drawing to select on, the card opens under the row it was opened from', async (t) => {
  t.after(unmount);
  const model = project();
  let asked: { head: boolean } | null = null;
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/code/unit/u6'] },
      createElement(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        BranchList as any,
        {
          model,
          selected: 'u6',
          onSelect: () => {},
          card: (of: { head: boolean }) => {
            asked = of;
            return createElement('div', { id: 'code-props' }, 'what u6 is');
          },
        },
      ),
    ),
  );
  const held = [...document.querySelectorAll('.map-node')].find((item) =>
    item.textContent?.includes('Long-run grokking'),
  );
  assert.ok(held?.className.includes('on'), 'the row says it is the one in hand');
  assert.equal(held?.nextElementSibling?.id, 'code-props', 'and the card is the next thing read');
  // The row that was pressed is the head already, so what opens under it starts at the
  // first fact rather than saying the kind, the name and the state a second time.
  assert.deepEqual(asked, { head: false });
});

test('the fold under a row says the row’s own head once, and the card beside says it', async (t) => {
  t.after(unmount);
  servedProject();
  await mount(page([row], { at: '/code/unit/u6' }));
  const beside = document.querySelector('#code-props');
  assert.ok(beside?.querySelector('.code-card-name'), 'beside the drawing the card names itself');
  await unmount();
  // Stacked, the same card opens inside the row, which has already said all of that.
  servedProject();
  const model = project();
  const { CodeCard } = await import('../packages/ui/web/views/code-card.js');
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/code/unit/u6'] },
      createElement(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        BranchList as any,
        {
          model,
          selected: 'u6',
          onSelect: () => {},
          card: (of: { head: boolean }) =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            createElement(CodeCard as any, {
              ...of,
              id: 'u6',
              model,
              status: status(units(), bases()),
              publications: [],
              names,
              manages: false,
              signedIn: false,
              named: () => undefined,
              onSelect: () => {},
              onDone: () => {},
            }),
        },
      ),
    ),
  );
  const fold = document.querySelector('.code-card');
  assert.ok(fold, text().slice(0, 300));
  assert.equal(fold.querySelector('.code-card-name'), null, 'the fold repeats no head');
  assert.equal(fold.getAttribute('aria-label'), 'Long-run grokking', 'and still names itself');
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
      createElement(BranchCanvas as any, { model, selected: null, onSelect: () => {} }),
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
    body: {
      result: {
        tasks: [
          { id: 'u1', title: 'Pin the tokenizer' },
          { id: 'u7', title: 'Wave one' },
        ],
      },
    },
  });
  serve('/code/publications', { body: { publications: [published()] } });
  serve('/code/github', connected({ baseBranch: 'trunk' }));
  await mount(page([row]));
  // The shell titles the row and the page's own counts stand on that one line beside
  // its name, so the page draws no heading and no band of its own under it.
  const lede = document.querySelector('.page-lede');
  assert.ok(lede?.textContent?.includes('Code'), text().slice(0, 200));
  assert.ok(lede?.textContent?.includes('Branches 3'), lede?.textContent);
  assert.ok(lede?.textContent?.includes('Merges 1'), lede?.textContent);
  assert.equal(document.querySelectorAll('h1').length, 1, text().slice(0, 200));
  assert.ok(!document.querySelector('.page-stage h1'), 'the page itself titles nothing');
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

/* What a chip groups, and who waits on a merge ------------------------------ */

test('a chip is a group of blockers, its lights are what they name, and a zero is not drawn', () => {
  const model = project();
  const chips = chipsOf(
    [
      blocker('u6', 'code_merge_conflict', [{ kind: 'task', id: 'u5', label: 'Resolve loader' }]),
      // Two opinions about one unit are one thing to look at, not two.
      blocker('u6', 'code_merge_conflict'),
      blocker('u9', 'code_quarantined'),
      blocker('u4', 'code_base_wait'),
      // A code the table does not name is still work waiting on the server.
      blocker('u8', 'code_writer_busy'),
    ],
    model,
  );
  assert.deepEqual(
    chips.map((chip) => [chip.label, chip.count]),
    [
      ['Conflicted', 1],
      ['Waiting', 2],
      ['Quarantined', 1],
    ],
    'the groups keep their order, and “To publish” has nothing behind it',
  );
  const lit = chips[0]!.lights;
  assert.ok(lit.has('u6') && lit.has('u5'), 'the unit and the record the blocker names');
  // The base it is waiting behind is what the reader is being sent to look at.
  assert.ok(lit.has('b2'), [...lit].join(' · '));
  assert.ok(!lit.has('u1'), 'and nothing the blocker did not name');
});

test('a recoverable writer waits; only quarantine is called quarantine', () => {
  const model = project();
  const chips = chipsOf(
    [
      blocker('u8', 'code_recovery_required'),
      blocker('u9', 'code_quarantined'),
      // Blockers are every one the project holds; the drawing keeps a window of units,
      // so a chip never counts work pressing it could not light.
      blocker('u404', 'code_merge_conflict'),
    ],
    model,
  );
  assert.deepEqual(
    chips.map((chip) => [chip.label, chip.count]),
    [
      ['Waiting', 1],
      ['Quarantined', 1],
    ],
    'a writer stuck mid-generation is recoverable and is not called quarantined',
  );
  assert.ok(
    chips.every((chip) => chip.lights.size > 0),
    'a chip that lights nothing is not drawn at all',
  );
});

test('the two principals are the server’s two rules, and each verb hangs off one', () => {
  const account = (kind: 'user' | 'key' | 'actor') => ({ kind, projects: [] }) as never;
  const actor = (role: string) => ({ id: 'a', projectId: 'p', name: 'Ada', role, active: true });
  for (const kind of ['user', 'key', 'actor'] as const) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(managesCode(actor('operator') as any), true, `an operator by ${kind}`);
    assert.equal(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signedInAdmin(actor('operator') as any, account(kind)),
      kind === 'user',
      'only a person fences a writer or merges a publication',
    );
  }
  for (const role of ['producer', 'reviewer', 'reader']) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(managesCode(actor(role) as any), false, `${role} controls no server work`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(signedInAdmin(actor(role) as any, account('user')), false, role);
  }
});

test('the units waiting on a base are joined by the member set alone', () => {
  const all = units();
  const [clean, conflicted] = bases();
  assert.deepEqual(waitersOf(conflicted!, all), ['u6'], 'the same commits, in any order');
  assert.deepEqual(waitersOf(clean!, all), [], 'a unit already pinned on it waits no longer');
  assert.deepEqual(
    waitersOf(base('b3', { members: [] }), all),
    [],
    'a base made of nothing answers nobody',
  );
});

/* The address, the card, and the operator's verbs --------------------------- */

test('selecting a node is an address, and the drawing it was made on never remounts', async (t) => {
  t.after(unmount);
  servedProject();
  await mount(page());
  const drawing = document.querySelector('svg.branch-graph');
  assert.ok(drawing, text().slice(0, 300));
  await pickNode('Long-run grokking');
  assert.equal(where, '/code/unit/u6', 'a lane is its record');
  assert.ok(document.querySelector('#code-props')?.textContent?.includes('Long-run grokking'));
  assert.ok(
    document.querySelector('svg.branch-graph') === drawing,
    'the canvas is the same element it was before the address changed',
  );
  await pickBase(1);
  assert.equal(where, '/code/merge/b2', 'a base is its key, and only in the address');
  assert.ok(
    document.querySelector('svg.branch-graph') === drawing,
    'and again when the selection moves from a lane to a merge',
  );
  // Pressing the held node again lets it go, and the address goes back with it.
  await pickBase(1);
  assert.equal(where, '/code');
  assert.equal(document.querySelector('#code-props'), null);
});

test('the base card names what was merged, what conflicted and who waits — never the key', async (t) => {
  t.after(unmount);
  servedProject();
  await mount(page([row], { at: '/code/merge/b2' }));
  const card = document.querySelector('#code-props');
  const said = card?.textContent ?? '';
  assert.ok(said.includes('A merge of 2'), said);
  assert.ok(/AWAITING RESOLUTION/i.test(said), said);
  // A commit that went in is named by the record accepted with it, and shown as a short.
  assert.ok(said.includes('Pin the tokenizer'), said);
  assert.ok(card?.querySelectorAll('.mono').length, 'the commits are machine text');
  assert.ok(said.includes('train/loop.py'), said);
  assert.ok(said.includes('Resolve loader'), said);
  assert.ok(
    /IN PROGRESS|READY|WORKING|PINNED/i.test(said),
    `the resolution task's own state: ${said}`,
  );
  // The units waiting on it come from the member set, not from a field the server sends.
  assert.ok(said.includes('Long-run grokking'), said);
  assert.ok(!text().includes('b2'), 'the digest is in the address and nowhere on the page');
  // On the ordinary pairwise merge the parents are the members, so the card does not
  // print the same two commits again with the record names taken off them.
  assert.ok(!said.includes('Joined'), `the one fact is said once: ${said}`);
  // Every record the card names is named the one way, as a link to the record itself.
  const waiting = [...(card?.querySelectorAll('.kv-row') ?? [])].find((line) =>
    line.textContent?.startsWith('Waiting on it'),
  );
  assert.ok(waiting?.querySelector('a'), `a waiter is a link, as its resolver is: ${said}`);
  assert.equal(waiting?.querySelector('button'), null, 'and never a control dressed as a value');
});

test('a base whose check failed shows the verdict beside what the machine could not isolate', async (t) => {
  t.after(unmount);
  const failed = base('b2', {
    members: ['c1', 'm1'],
    parents: ['c1', 'm1'],
    state: 'awaiting_resolution',
    conflict: { paths: [], messages: 'the project check `make test` exited 7.' },
    checkState: 'failed',
    check: {
      state: 'failed',
      spec: {
        command: 'make test',
        timeoutSeconds: 600,
        image: { provider: 'thunder_compute', offerId: 'a6000_x1:thunder', snapshotId: null },
      },
      receipt: {
        sandboxId: 'sbx_1',
        jobId: 'job_1',
        objectId: 'obj_1',
        exitCode: 7,
        timedOut: false,
        startedAt: '2026-09-22T00:00:00.000Z',
        finishedAt: '2026-09-22T00:02:00.000Z',
        output: { head: 'FAIL loader', tail: 'one failure', bytes: 4000 },
        environment: {
          provider: 'thunder_compute',
          offerId: 'a6000_x1:thunder',
          snapshotId: null,
        },
        usage: { amount: '0.012', currency: 'USD' },
        isolation: {
          network: 'on',
          sourceReadOnly: false,
          imagePinned: 'offer',
          facts: ['The check had outbound network access.'],
        },
      },
      reason: null,
      at: '2026-09-22T00:02:00.000Z',
    },
  });
  servedProject({}, [bases()[0], failed]);
  await mount(page([row], { at: '/code/merge/b2' }));
  const said = document.querySelector('#code-props')?.textContent ?? '';
  assert.ok(said.includes('make test'), said);
  assert.ok(said.includes('exit 7'), said);
  assert.ok(said.includes('120s'), `how long it ran: ${said}`);
  assert.ok(said.includes('a6000_x1:thunder'), `what it ran in: ${said}`);
  assert.ok(said.includes('0.012 USD'), `what it cost: ${said}`);
  assert.ok(said.includes('FAIL loader') && said.includes('one failure'), said);
  assert.ok(said.includes('bytes omitted'), `the gap in the output is named: ${said}`);
  assert.ok(
    said.includes('outbound network access'),
    `what the machine could not isolate is on the same card: ${said}`,
  );
  assert.ok(!said.includes('Conflicting paths'), `a check failure conflicts over no path: ${said}`);
});

test('a merge made from an earlier merge says what it joined, by name', async (t) => {
  t.after(unmount);
  const model = gitModel(status(units(), bases()), commands(), [], names);
  const { CodeCard } = await import('../packages/ui/web/views/code-card.js');
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/code/merge/b2'] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createElement(CodeCard as any, {
        id: 'b2',
        model,
        // b2 joins one accepted commit with the result of b1, so its parents are not
        // its members and the small tree is worth saying.
        status: status(units(), [
          bases()[0]!,
          { ...bases()[1]!, members: ['c1', 'c7', 'm1'], parents: ['c1', 'm1'] },
        ]),
        publications: [],
        names,
        manages: false,
        signedIn: false,
        named: () => undefined,
        onSelect: () => {},
        onDone: () => {},
      }),
    ),
  );
  const joined = [...document.querySelectorAll('.kv-row')].find((line) =>
    line.textContent?.startsWith('Joined'),
  );
  assert.ok(joined, `a merge of merges says what it joined: ${text().slice(0, 300)}`);
  assert.ok(
    joined.textContent?.includes('Pin the tokenizer'),
    `and names each parent as its record: ${joined.textContent}`,
  );
});

test('the unit card is the record’s own Code section, and the trunk says what it holds', async (t) => {
  t.after(unmount);
  servedProject({
    project: {
      mode: 'local',
      repositoryId: 'repo',
      boundBy: 'actor_1',
      boundAt: '2026-09-01T00:00:00.000Z',
      main: {
        oid: 'c0',
        admittedBy: 'actor_1',
        admittedAt: '2026-09-01T00:00:00.000Z',
        stored: true,
      },
      durability: 'code',
    },
  });
  await mount(page([row], { at: '/code/unit/u8' }));
  const said = document.querySelector('#code-props')?.textContent ?? '';
  // A lane no list names is its branch, and the section states the branch either way.
  assert.ok(said.includes('merv/work/u8'), said);
  assert.ok(/RECOVERY REQUIRED/i.test(said), said);
  assert.ok(said.includes('cannot be reused'), said);
  assert.ok(document.querySelector('#code-props')?.className.includes('code-refused'), said);
  await pickNode('main');
  const trunk = document.querySelector('#code-props')?.textContent ?? '';
  assert.ok(trunk.includes('in the repository this server keeps'), trunk);
});

test('an operator verb names its consequence and keeps the reason; a session is offered none', async (t) => {
  t.after(unmount);
  servedProject();
  let sent: Record<string, unknown> = {};
  serve('/tools/code.base.quarantine', (_call, body) => {
    sent = body;
    return { body: { result: { key: 'b2', quarantined: true } } };
  });
  await mount(page([row], { at: '/code/merge/b2' }));
  const named = (label: string) =>
    [...document.querySelectorAll('button')].find((item) => item.textContent === label);
  for (const label of ['Suspend merge', 'Cancel merge', 'Quarantine base'])
    assert.ok(named(label), `${label} stands on the base it acts on: ${text().slice(0, 300)}`);
  assert.ok(!named('Retry merge'), 'only infrastructure work is retried, and this is a conflict');
  assert.ok(!named('Resume merge'), 'and only a suspended base resumes');
  // What cannot be undone wears the refusal's colour and never the page's accent.
  for (const label of ['Cancel merge', 'Quarantine base']) {
    const control = named(label)!;
    assert.ok(control.closest('.act-danger'), `${label} is drawn in the refusal's colour`);
    assert.ok(!control.className.includes('btn--primary'), `${label} does not wear the accent`);
  }
  await click('Quarantine base');
  const guard = document.querySelector('[role="alertdialog"]');
  assert.ok(guard?.textContent?.includes('cannot be reused'), guard?.textContent);
  // While a guard is open it is the only verb drawn, so no other sentence's control
  // stands a press away from this one's confirmation.
  for (const label of ['Suspend merge', 'Cancel merge'])
    assert.ok(!named(label), `${label} stands aside while another guard is open`);
  // The reason the tool keeps is asked for here, and nothing is sent without it.
  await click('Quarantine base');
  assert.equal(requests.filter((line) => line.includes('code.base.quarantine')).length, 0);
  assert.ok(document.querySelector('.error-message'), text().slice(0, 400));
  await write('Reason', 'The retained result is poisoned.');
  // The refusal is read from the field, so it goes the moment the field has an answer.
  assert.equal(document.querySelector('.error-message'), null, text().slice(0, 400));
  await click('Quarantine base');
  assert.equal(sent.key, 'b2', JSON.stringify(sent));
  assert.equal(sent.reason, 'The retained result is poisoned.');
  assert.equal(typeof sent.requestId, 'string', 'the same request can be retried as itself');
  assert.equal(document.querySelector('[role="alertdialog"]'), null, 'the guard closes on a yes');
});

test('the refusal colour marks what cannot be undone, opener and confirm alike', async (t) => {
  t.after(unmount);
  servedProject();
  await mount(page([row], { at: '/code/merge/b2' }));
  // A reversible verb's confirmation is the page's ordinary forward control; only the
  // two acts that cannot be taken back are drawn in the colour that says so.
  await click('Suspend merge');
  const confirm = [...document.querySelectorAll('[role="alertdialog"] button')][0]!;
  assert.ok(confirm.textContent?.includes('Suspend merge'), confirm.textContent);
  assert.ok(!confirm.className.includes('btn--danger'), confirm.className);
  await click('Cancel');
  await click('Quarantine base');
  const refusal = [...document.querySelectorAll('[role="alertdialog"] button')][0]!;
  assert.ok(refusal.className.includes('btn--danger'), refusal.className);
});

test('fencing a writer is offered to a person and to nobody else', async (t) => {
  t.after(unmount);
  // An operator holding a key manages the bases; the server answers this one tool only
  // to a signed-in person, so the page does not offer what would come back refused.
  servedProject();
  await mount(page([row], { at: '/code/unit/u8', manages: true, signedIn: false }));
  assert.ok(!text().includes('Fence the writer'), text().slice(0, 300));
  await unmount();
  servedProject();
  let sent: Record<string, unknown> = {};
  serve('/tools/code.unit.fence', (_call, body) => {
    sent = body;
    return { body: { result: { unitId: 'u8', state: 'closed' } } };
  });
  await mount(page([row], { at: '/code/unit/u8', manages: true, signedIn: true }));
  await click('Fence the writer');
  await click('Fence the writer');
  assert.deepEqual(Object.keys(sent).sort(), ['requestId', 'unitId'], JSON.stringify(sent));
  assert.equal(sent.unitId, 'u8');
});

test('a session principal reads the page and is offered none of its verbs', async (t) => {
  t.after(unmount);
  servedProject({
    mirror: {
      state: 'blocked',
      repository: 'lab/grokking',
      blockedBy: null,
      pending: 1,
      oldestPendingAt: '2026-09-05T00:00:00.000Z',
      lastError: null,
      blockedRefs: [
        {
          operationId: 'op_9',
          unitId: 'u1',
          ref: 'refs/heads/merv/work/u1',
          code: 'code_mirror_failed',
          message: 'GitHub refused the push.',
          at: '2026-09-05T00:00:00.000Z',
        },
      ],
    },
  });
  await mount(page([row], { at: '/code/merge/b2', manages: false }));
  const said = text();
  // Everything the page reads is still there: only the verbs are not.
  assert.ok(said.includes('A merge of 2'), said.slice(0, 300));
  assert.ok(said.includes('refs/heads/merv/work/u1'), 'the blocked ref is still stated');
  for (const label of ['Suspend merge', 'Cancel merge', 'Quarantine base', 'Retry mirror'])
    assert.ok(!said.includes(label), `${label} is not offered to a session: ${said.slice(0, 300)}`);
});

test('the Operations fold holds the machinery, and a blocked ref its one verb', async (t) => {
  t.after(unmount);
  servedProject({
    store: {
      hosted: true,
      objectFormat: 'sha1',
      rootOid: null,
      source: 'github',
      tips: [],
      diskBytes: 1_048_576,
      quotaBytes: 10_485_760,
      limits: { format: 1, denyGlobs: [], secretExemptGlobs: [], check: null },
    },
    operations: [
      {
        id: 'op_1',
        kind: 'upload',
        status: 'prepared',
        phase: 'receiving',
        unitId: 'u1',
        generation: 1,
        received: 512,
        bytes: 2048,
        partBytes: 512,
        head: null,
        error: null,
        findings: [],
        waiting: {
          code: 'code_store_busy',
          message: 'Another transfer holds the repository.',
          next: 'It goes on by itself.',
          at: '2026-09-05T00:00:00.000Z',
        },
        createdAt: '2026-09-05T00:00:00.000Z',
        updatedAt: '2026-09-05T00:00:00.000Z',
        completedAt: null,
      },
      {
        id: 'op_2',
        kind: 'import',
        status: 'failed',
        phase: null,
        unitId: null,
        generation: null,
        received: 0,
        bytes: null,
        partBytes: 512,
        head: null,
        error: 'code_admission_refused',
        findings: [{ rule: 'secret', path: 'configs/key.pem', oid: null }],
        waiting: null,
        createdAt: '2026-09-05T00:00:00.000Z',
        updatedAt: '2026-09-05T00:00:00.000Z',
        completedAt: '2026-09-05T00:01:00.000Z',
      },
    ],
    warnings: [
      {
        code: 'code_ref_skipped',
        ref: 'refs/heads/spike',
        message: 'A branch nobody claims was left alone.',
        at: '2026-09-05T00:00:00.000Z',
      },
    ],
    mirror: {
      state: 'blocked',
      repository: 'lab/grokking',
      blockedBy: null,
      pending: 1,
      oldestPendingAt: '2026-09-05T00:00:00.000Z',
      lastError: 'code_mirror_failed',
      blockedRefs: [
        {
          operationId: 'op_9',
          unitId: 'u1',
          ref: 'refs/heads/merv/work/u1',
          code: 'code_mirror_diverged',
          message: 'The published branch holds a commit Merv did not write.',
          at: '2026-09-05T00:00:00.000Z',
        },
      ],
    },
  });
  await mount(page());
  const fold = document.querySelector('.code-ops');
  const said = fold?.textContent ?? '';
  assert.ok(said.startsWith('Operations'), said.slice(0, 120));
  // Mirror lag is a state and a time, never a count of how far behind it is.
  assert.ok(/BLOCKED/i.test(said) && said.includes('lab/grokking'), said);
  assert.ok(!/\d+ (refs?|commits?) behind/.test(said), said);
  assert.ok(said.includes('refs/heads/merv/work/u1'), said);
  assert.ok(said.includes('configs/key.pem'), 'a refusal names the place and not the text');
  assert.ok(said.includes('A branch nobody claims was left alone.'), said);
  // The refusal the mirror kept is a code, and is read as the refused transfers are.
  assert.ok(said.includes('code mirror failed'), said);
  assert.ok(!said.includes('code_mirror_failed'), said);
  // Both halves of one sentence are written for a person, in the one unit.
  assert.ok(said.includes('1.0 MB of 10.0 MB'), `disk against quota: ${said}`);
  // A ref that holds somebody's work goes back in the queue only against the commit
  // the operator says they kept, which is what the server requires and nothing sends
  // without.
  await click('Retry mirror');
  assert.ok(
    [...document.querySelectorAll('label')].some((item) =>
      item.textContent?.includes('The commit you kept'),
    ),
    document.querySelector('[role="alertdialog"]')?.textContent,
  );
  await click('Retry mirror');
  assert.equal(
    requests.filter((line) => line.includes('code.mirror.retry')).length,
    0,
    'nothing is sent to be refused',
  );
  assert.ok(document.querySelector('.error-message'), text().slice(0, 400));
  await write('The commit you kept', 'deadbeefdeadbeef');
  await click('Retry mirror');
  assert.equal(requests.filter((line) => line.includes('code.mirror.retry')).length, 1);
});

test('publishing that is off says why, and a fold with no machinery does not open', async (t) => {
  t.after(unmount);
  servedProject({
    // The one configuration this fold exists to make repairable: nothing is published,
    // and the reason is the fact that is present.
    mirror: {
      state: 'off',
      repository: null,
      blockedBy: 'code_automation_off',
      pending: 0,
      oldestPendingAt: null,
      lastError: null,
      blockedRefs: [],
    },
  });
  await mount(page());
  const said = document.querySelector('.code-ops')?.textContent ?? '';
  assert.ok(/OFF/i.test(said), said);
  assert.ok(said.includes('code automation off'), said);
  await unmount();
  // A project kept on its runner, with nothing linked and nothing in flight, has no
  // machinery to fold: the summary is not drawn over an empty list. (Letting the page
  // go takes the fixtures with it, so the next reading is served again.)
  servedProject({
    store: {
      hosted: false,
      objectFormat: 'sha1',
      rootOid: null,
      source: 'github',
      tips: [],
      diskBytes: 0,
      quotaBytes: 0,
      limits: { format: 1, denyGlobs: [], secretExemptGlobs: [], check: null },
    },
    mirror: null,
  });
  await mount(page());
  assert.equal(document.querySelector('.code-ops'), null, text().slice(0, 400));
});

test('the release canary is recorded by the signed-in operator where publication is, and by nobody else', async (t) => {
  t.after(unmount);
  const controls = { blockers: ['code_publication_canary_required'] };
  const sent: Record<string, unknown>[] = [];
  serve('/tools/code.publication.control', (_call, body) => {
    sent.push(body);
    return { body: { result: { canary: { staleMerged: false } } } };
  });
  // A reader who is not a signed-in operator is shown neither the state nor a control.
  servedProject({ publication: { records: [], controls } });
  await mount(page([row], { manages: true, signedIn: false }));
  assert.ok(!text().includes('Canary'), text().slice(0, 600));
  await unmount();

  servedProject({ publication: { records: [], controls } });
  serve('/tools/code.publication.control', (_call, body) => {
    sent.push(body);
    return { body: { result: { canary: { staleMerged: false } } } };
  });
  await mount(page());
  const section = () => document.querySelector('[aria-label="Pull requests"]')!.textContent!;
  assert.ok(/Canary\s*missing/i.test(section()), section());
  await click('Record canary');
  // Nothing can be recorded without the evidence it rests on.
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    '[aria-label="Record canary"] button',
  ))
    if (button.textContent !== 'Cancel') assert.ok(button.disabled, button.textContent!);
  await write('Evidence', 'PR #3 refused: strict checks required, App has no bypass');
  await click('Stale merge refused');
  assert.equal(sent.length, 1);
  assert.deepEqual(
    { ...sent[0], requestId: typeof sent[0]!.requestId },
    {
      action: 'record_canary',
      staleMerged: false,
      reason: 'PR #3 refused: strict checks required, App has no bypass',
      requestId: 'string',
    },
  );
  assert.equal(document.querySelector('[aria-label="Record canary"]'), null, 'the form closes');
});

test('a failed canary is cleared only once a passing one stands, and never before', async (t) => {
  t.after(unmount);
  const failed = { actorId: 'a', reason: 'r', at: '', bindingHash: 'h', staleMerged: true };
  servedProject({
    publication: { records: [], controls: { disabled: true, canary: failed, blockers: [] } },
  });
  await mount(page());
  assert.ok(/Canary\s*failed/i.test(text()), text().slice(0, 600));
  await click('Record canary');
  assert.ok(!text().includes('Clear'), 'a clear the server refuses is not offered');
  await unmount();
  servedProject({
    publication: {
      records: [],
      controls: { disabled: true, canary: { ...failed, staleMerged: false }, blockers: [] },
    },
  });
  await mount(page());
  await click('Record canary');
  assert.ok(text().includes('Clear disablement'), text().slice(0, 600));
});

test('a canary whose answer never came is retried as it was sent, and no other report can take its place', async (t) => {
  t.after(unmount);
  const passed = { actorId: 'a', reason: 'r', at: '', bindingHash: 'h', staleMerged: false };
  servedProject({
    publication: { records: [], controls: { disabled: true, canary: passed, blockers: [] } },
  });
  const sent: Record<string, unknown>[] = [];
  serve('/tools/code.publication.control', (_call, body) => {
    sent.push(body);
    return sent.length === 1
      ? { network: true }
      : { body: { result: { canary: { staleMerged: false } } } };
  });
  await mount(page());
  await click('Record canary');
  await write('Evidence', 'PR #3 was refused');
  await click('Stale merge refused');
  assert.equal(sent.length, 1);
  // The one press left is the one that was sent; its evidence stays as it was sent, and the
  // form does not close on a report whose fate is unknown.
  const form = () => document.querySelector('[aria-label="Record canary"]');
  const live = [...form()!.querySelectorAll('button')].filter((button) => !button.disabled);
  assert.deepEqual(
    live.map((button) => button.textContent),
    ['Retry same request'],
    form()!.textContent!,
  );
  assert.ok(form()!.querySelector('textarea')!.disabled, 'the evidence is kept as sent');
  await click('Retry same request');
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(sent[1]!.staleMerged, false);
  assert.equal(form(), null, 'the confirmed report closes the form');
});

test('a superseded publication names the wave that replaced it, and never its id', async (t) => {
  t.after(unmount);
  const later = published({ proposalId: 'p2', instanceId: 'u7', title: 'Wave two' });
  const stale = published({ stale: true, successor: 'p2', merge: null });
  serve('/code/publications', { body: { publications: [stale, later] } });
  serve('/tools/ui.read', {
    body: { result: { commands: commands(), status: status(units(), bases()) } },
  });
  serve('/tools/ui.home', { body: { result: {} } });
  serve('/code/github', connected());
  await mount(page([row], { at: '/code/unit/p1' }));
  const card = document.querySelector('#code-props');
  const said = card?.textContent ?? '';
  assert.ok(said.includes('Superseded'), text().slice(0, 400));
  assert.ok(said.includes('Wave two'), said);
  assert.ok(!said.includes('p2'), `the proposal id is not on screen: ${said}`);
  // It is the ring beside it, so it is a control that goes there.
  const control = [...(card?.querySelectorAll('button') ?? [])].find(
    (item) => item.textContent === 'Wave two',
  );
  assert.ok(control?.className.includes('btn-text'), control?.className);
  await press(control!);
  assert.ok(
    document.querySelector('#code-props')?.textContent?.includes('Wave two'),
    'pressing it opens that wave’s own card',
  );
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
  // Nothing this unit stands on waits on a person, so no sentence of the blocker
  // vocabulary is drawn and the server's own machine word never reaches the page.
  assert.ok(!said.includes('blocker'), said);
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

/* What a person is asked to do ---------------------------------------------- */

/** One blocker as the server serves it, with only what the vocabulary reads filled in. */
const held = (code: string, over: Record<string, unknown> = {}) => ({
  code,
  message: code,
  status: 409,
  ...over,
});

test('exactly the Code blockers whose next move is a person’s are printed, in her words', () => {
  const said = (code: string, over: Record<string, unknown> = {}) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    personMove(held(code, over) as any);

  // Between acceptance and the first sync no pull request exists, and the blocker says so
  // by carrying none: the wait is named, and neither a person nor a control is.
  assert.deepEqual(said('code_publication_pending'), {
    sentence: 'The publication for this work has not opened its pull request yet',
    who: 'The server',
    whose: 'nobody',
  });
  assert.deepEqual(
    said('code_publication_pending', {
      related: [{ kind: 'pull-request', id: 'https://x/7', label: '#7' }],
    }),
    {
      sentence: 'Waiting on a person to merge the pull request',
      who: 'A signed-in operator',
      whose: 'operator',
      // The reviewed merge is a control this app draws, and it stands on Code, in the
      // words the control there reads.
      control: { label: 'Merge reviewed proposal', to: '/code' },
    },
  );
  assert.deepEqual(said('code_publication_stale'), {
    sentence: 'Main has moved past this accepted code',
    who: 'A successor task',
    whose: 'nobody',
  });
  assert.deepEqual(said('code_publication_disabled'), {
    sentence: 'Publication is disabled for this project until an operator clears it',
    who: 'An operator',
    whose: 'operator',
  });
  assert.deepEqual(said('code_publication_incident'), {
    sentence: 'A publication incident is kept here until an operator clears it',
    who: 'An operator',
    whose: 'operator',
  });
  assert.deepEqual(said('code_publish_unverifiable'), {
    sentence: 'This work was to publish to main and no publication opened for it',
    who: 'An operator',
    whose: 'operator',
  });
  // The way out is the one both producers of this code agree on: not a release, which only
  // a false alarm gets, but the operator replanning whoever waits on the quarantined base.
  assert.deepEqual(said('code_quarantined'), {
    sentence:
      'Quarantined: the code kept here cannot be used, and an operator replans the work waiting on it',
    who: 'An operator',
    whose: 'operator',
  });
  // The cap or budget a person set is named by the server's own word for which one it is.
  assert.equal(
    said('code_base_admission', { message: 'Base 9f is queued: budget_exceeded.' })?.sentence,
    'The budget set for this project is spent',
  );
  assert.equal(
    said('code_base_admission', { message: 'Base 9f is queued: dispatch_disabled.' })?.sentence,
    'Dispatch is paused for this project',
  );
  assert.equal(
    said('code_base_admission', { message: 'Base 9f is queued: something new.' })?.sentence,
    'A limit somebody set is holding this merge',
  );
  // Only main waits on a person binding or importing; every other pending base is a record.
  assert.deepEqual(said('code_base_pending', { key: 'main' }), {
    sentence: 'Main is not in this project’s repository yet',
    who: 'An administrator',
    whose: 'administrator',
  });
  assert.equal(said('code_base_pending', { key: 'acceptance:wf_1' }), null);

  // A conflict is work in flight until its resolution's review budget suspends it.
  const conflict = (state: string) =>
    held('code_merge_conflict', {
      message: `Base resolution task “Merge A with B” (wf_1) is ${state}. Conflicting paths: a.py`,
      related: [{ kind: 'task', id: 'wf_1', label: 'Merge A with B' }],
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal(personMove(conflict('in_progress') as any), null);
  assert.deepEqual(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    personMove(conflict('suspended') as any),
    {
      sentence:
        'The resolution “Merge A with B” is suspended; an administrator extends its review limit',
      who: 'An administrator',
      whose: 'administrator',
    },
  );
  // The record is named the way this app names it wherever it knows the name itself.
  assert.match(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    personMove(conflict('suspended') as any, new Map([['wf_1', { name: 'Fold the sweeps' }]]))!
      .sentence,
    /“Fold the sweeps”/,
  );

  // Everything else is work waiting on the server, and the state word already says it.
  for (const quiet of [
    'code_base_wait',
    'code_base_blocked',
    'code_publication_closed',
    'code_dependencies_changed',
    'input_required',
  ])
    assert.equal(said(quiet), null, quiet);

  // No sentence is the server's instruction: none of them names a tool or an argument.
  for (const code of [
    'code_publication_pending',
    'code_publication_stale',
    'code_publication_disabled',
    'code_publication_incident',
    'code_publish_unverifiable',
    'code_quarantined',
  ])
    assert.ok(!/code\.|workflow\.|merv /.test(said(code)!.sentence), code);
});

test('a unit’s own publication is read as the blocker Code publishes about it', () => {
  assert.equal(publicationBlocker(null), null);
  assert.equal(publicationBlocker({ state: 'published', mergeCommit: 'm' }), null);
  assert.deepEqual(publicationBlocker({ state: 'pending' }), { code: 'code_publication_pending' });
  assert.deepEqual(
    publicationBlocker({ state: 'stale', pull: { number: 12, url: 'https://x/12' } }),
    {
      code: 'code_publication_stale',
      related: [{ kind: 'pull-request', id: 'https://x/12', label: '#12' }],
    },
  );
  assert.equal(publicationBlocker({ state: 'unsealed' })?.code, 'code_publish_unverifiable');
  // A pending publication carries a pull only once one exists, and the move follows the
  // fact: nothing to merge, so nothing offers a merge.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal(personMove(publicationBlocker({ state: 'pending' }) as any)?.control, undefined);
  // The first one whose move is a person's leads, and a list of quiet codes leads nothing.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const first = firstPersonMove([held('code_base_wait'), held('code_quarantined')] as any);
  assert.equal(first?.blocker.code, 'code_quarantined');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal(firstPersonMove([held('code_base_wait')] as any), null);
});

test('a record’s Code section leads with the move, and folds the agent’s instruction', async (t) => {
  t.after(unmount);
  serve('/tools/ui.home', { body: { result: {} } });
  const waiting = unit('u9', {
    baseStatus: {
      status: 'blocked',
      blockers: [
        {
          key: 'merge',
          code: 'code_base_admission',
          status: 409,
          message: 'Base 9f is queued: budget_exceeded.',
          next: 'Enable project dispatch or raise the budget with usage.set_budget.',
          related: [],
        },
      ],
    },
  });
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/tasks/u9'] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createElement(UnitCode as any, { unit: waiting, named: () => undefined }),
    ),
  );
  const said = text();
  assert.ok(said.includes('The budget set for this project is spent'), said);
  assert.ok(said.includes('An administrator'), said);
  // The server's words are kept for whoever holds the tool, and only in the fold.
  const fold = document.querySelector('details.ov-said');
  assert.ok(fold, said);
  assert.ok(fold.textContent?.includes('usage.set_budget'), fold.textContent ?? '');
  assert.ok(!document.querySelector('.ov-say')?.textContent?.includes('usage.set_budget'), said);
  // Nothing here makes this move, so nothing promises one: the only link is the canvas.
  assert.deepEqual(
    [...document.querySelectorAll('a.btn-text')].map((a) => a.getAttribute('href')),
    ['/code'],
  );
});

test('a unit waiting on its publication says so, and shows where that publication stands', async (t) => {
  t.after(unmount);
  serve('/tools/ui.home', { body: { result: {} } });
  const sealed = unit('u10', {
    acceptance: accepted('c10'),
    baseStatus: null,
    publication: { state: 'pending', pull: { number: 7, url: 'https://github.com/x/y/pull/7' } },
  });
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/tasks/u10'] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createElement(UnitCode as any, { unit: sealed, named: () => 'Ada', signedIn: true }),
    ),
  );
  const said = text();
  assert.ok(said.includes('Waiting on a person to merge the pull request'), said);
  assert.ok(said.includes('A signed-in operator'), said);
  // The move a page of this app makes is offered, level with the sentence.
  const control = [...document.querySelectorAll('a.btn-text')].find((link) =>
    link.textContent?.startsWith('Merge reviewed proposal'),
  );
  assert.equal(control?.getAttribute('href'), '/code');
  // The line itself: the state as a pill, the pull request as the link GitHub keeps it at.
  const line = [...document.querySelectorAll('.kv-row')].find(
    (node) => node.querySelector('dt')?.textContent === 'Publication',
  );
  assert.ok(line, said);
  assert.equal(line.querySelector('.status')?.textContent, 'pending');
  const pull = line.querySelector('a');
  assert.equal(pull?.getAttribute('href'), 'https://github.com/x/y/pull/7');
  assert.ok(pull?.textContent?.includes('#7'), pull?.textContent ?? '');
  assert.equal(line.querySelector('.code-refusal'), null, 'a wait is not a refusal');
  // The server's own instruction is not on this read, so no fold is drawn at all.
  assert.equal(document.querySelector('details.ov-said'), null, said);
});

test('the merge is offered to the signed-in operator alone, and said to everyone', async (t) => {
  t.after(unmount);
  serve('/tools/ui.home', { body: { result: {} } });
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/tasks/u10'] },
      createElement(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        UnitCode as any,
        {
          unit: unit('u10', {
            acceptance: accepted('c10'),
            baseStatus: null,
            publication: {
              state: 'pending',
              pull: { number: 7, url: 'https://github.com/x/y/pull/7' },
            },
          }),
          named: () => 'Ada',
        },
      ),
    ),
  );
  const said = text();
  // A reader, and an operator holding a key, read the wait and who ends it.
  assert.ok(said.includes('Waiting on a person to merge the pull request'), said);
  assert.ok(said.includes('A signed-in operator'), said);
  // The publication verbs refuse them, so nothing here promises them the act: the only
  // link left is the canvas, and the pull request GitHub keeps.
  assert.equal(
    [...document.querySelectorAll('a.btn-text')].find((link) =>
      link.textContent?.startsWith('Merge reviewed proposal'),
    ),
    undefined,
    said,
  );
});

test('a pending publication with no pull request yet promises no merge', async (t) => {
  t.after(unmount);
  serve('/tools/ui.home', { body: { result: {} } });
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/tasks/u13'] },
      createElement(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        UnitCode as any,
        {
          unit: unit('u13', {
            acceptance: accepted('c13'),
            baseStatus: null,
            publication: { state: 'pending' },
          }),
          named: () => undefined,
          signedIn: true,
        },
      ),
    ),
  );
  const said = text();
  assert.ok(said.includes('has not opened its pull request yet'), said);
  assert.ok(!said.includes('merge the pull request'), said);
  // Nobody is owed this one, so no control is drawn even for the operator who could merge.
  assert.deepEqual(
    [...document.querySelectorAll('a.btn-text')].map((a) => a.getAttribute('href')),
    ['/code'],
    said,
  );
});

test('a publication that stopped reads in the refusal’s colour', async (t) => {
  t.after(unmount);
  serve('/tools/ui.home', { body: { result: {} } });
  // Everything that is neither in flight nor arrived has stopped, and the colour says so —
  // the closed pull request and the acceptance that opened no publication included.
  for (const state of ['disabled', 'incident', 'stale', 'closed', 'unsealed']) {
    await mount(
      createElement(
        MemoryRouter,
        { initialEntries: ['/tasks/u11'] },
        createElement(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          UnitCode as any,
          {
            unit: unit('u11', { acceptance: accepted('c11'), publication: { state } }),
            named: () => undefined,
          },
        ),
      ),
    );
    assert.ok(document.querySelector('.kv-row .code-refusal'), state);
    await unmount();
  }
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/tasks/u11'] },
      createElement(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        UnitCode as any,
        {
          unit: unit('u11', { acceptance: accepted('c11'), publication: { state: 'disabled' } }),
          named: () => undefined,
        },
      ),
    ),
  );
  assert.ok(document.querySelector('.kv-row .code-refusal'), text());
  assert.ok(text().includes('Publication is disabled for this project'), text());
});

test('a published unit carries the commit that merged it, and waits on nobody', async (t) => {
  t.after(unmount);
  serve('/tools/ui.home', { body: { result: {} } });
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/tasks/u12'] },
      createElement(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        UnitCode as any,
        {
          unit: unit('u12', {
            acceptance: accepted('c12'),
            publication: {
              state: 'published',
              mergeCommit: 'abcdef0123456789abcdef0123456789abcdef01',
            },
          }),
          named: () => undefined,
        },
      ),
    ),
  );
  const line = [...document.querySelectorAll('.kv-row')].find(
    (node) => node.querySelector('dt')?.textContent === 'Publication',
  );
  assert.equal(line?.querySelector('.status')?.textContent, 'published');
  assert.equal(line?.querySelector('.code-refusal'), null);
  assert.ok(line?.textContent?.includes('abcdef01'), line?.textContent ?? '');
  // Nothing published is waiting on anybody, so no sentence stands over it.
  assert.equal(document.querySelector('.ov-say'), null, text());
});

test('the same move drawn inside the canvas offers no control back to the canvas', async (t) => {
  t.after(unmount);
  serve('/tools/ui.home', { body: { result: {} } });
  const sealed = unit('u10', {
    acceptance: accepted('c10'),
    baseStatus: null,
    publication: { state: 'pending', pull: { number: 7, url: 'https://github.com/x/y/pull/7' } },
  });
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/code/unit/u10'] },
      createElement(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        UnitCode as any,
        {
          unit: sealed,
          named: () => 'Ada',
          signedIn: true,
          open: createElement('span', null, 'Open record'),
        },
      ),
    ),
  );
  assert.ok(text().includes('Waiting on a person to merge the pull request'), text());
  assert.equal(
    [...document.querySelectorAll('a.btn-text')].find((link) =>
      link.textContent?.startsWith('Merge reviewed proposal'),
    ),
    undefined,
    text(),
  );
});

{
  const { GitHubConnection } = await import('../packages/ui/web/views/github.js');
  const { GitHubAutomation } = await import('../packages/ui/web/views/github-automation.js');
  const { GitHubPreparation } = await import('../packages/ui/web/views/github-prepare.js');

  const status: GitHubStatus = {
    configured: true,
    revision: 1,
    status: 'connected',
    user: { id: 1, login: 'researcher' },
    repository: {
      id: 42,
      installationId: 8,
      fullName: 'research/project',
      url: 'https://github.com/research/project',
      defaultBranch: 'main',
      private: true,
    },
    canManage: true,
    canBrowse: true,
    installUrl: 'https://github.com/apps/merv/installations/new',
    automationConfigured: true,
    automation: 'write',
    baseBranch: 'research-base',
  };

  test('repository settings name the selected research branch rather than the GitHub default', async (t) => {
    t.after(unmount);
    serve('/code/github', { body: status });
    await mount(createElement(GitHubConnection));
    assert.match(text(), /Research base: research-base/);
    assert.doesNotMatch(text(), /GitHub default: main/);
  });

  test('repository automation is a pill and its controls, never a sentence about them', async (t) => {
    t.after(unmount);
    // The one state each sentence was written for: no App key yet, and a mode chosen.
    await mount(
      createElement(GitHubAutomation, {
        status: { ...status, automationConfigured: false },
        onChanged: () => {},
      }),
    );
    const said = document.querySelector('[aria-label="Repository automation"]')!.textContent!;
    for (const gone of ['GitHub App key', 'main branch for new work', 'any branch name'])
      assert.ok(!said.includes(gone), `“${gone}” is still said: ${said}`);
    // What cannot be chosen without the key is a constraint: its options are not offered.
    const options = [...document.querySelectorAll('option')].filter((item) => item.disabled);
    assert.deepEqual(
      options.map((item) => item.textContent),
      ['Read only', 'Read and publish reviewable changes'],
    );
  });

  test('branch selection saves the chosen branch with the connection revision', async (t) => {
    t.after(unmount);
    serve('/code/github/branches', {
      body: { branches: [{ name: 'release/science', sha: 'a'.repeat(40), protected: true }] },
    });
    let sent: Record<string, unknown> | undefined;
    serve('/code/github/automation', (_call, body) => {
      sent = body;
      return { body: { ...status, revision: 2, baseBranch: 'release/science' } };
    });
    let changed = 0;
    await mount(createElement(GitHubAutomation, { status, onChanged: () => changed++ }));
    await click('Choose branch');
    const select = document.querySelectorAll('select')[1];
    await act(async () => {
      select.value = 'release/science';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await click('Save automation');
    assert.deepEqual(sent, { expectedRevision: 1, mode: 'write', baseBranch: 'release/science' });
    assert.equal(changed, 1);
  });

  test('uncertain preparation retries the selected commit and request even after its branch moves', async (t) => {
    t.after(unmount);
    serve('/tools/code.status', { body: { result: { project: null, store: { hosted: false } } } });
    serve('/code/github/branches', {
      body: { branches: [{ name: status.baseBranch, sha: 'a'.repeat(40) }] },
    });
    const sent: Record<string, unknown>[] = [];
    serve('/tools/code.repository.prepare', (_count, body) => {
      sent.push(body);
      return sent.length === 1
        ? { network: true }
        : {
            body: {
              result: {
                state: 'ready',
                baseBranch: status.baseBranch,
                headOid: 'a'.repeat(40),
                operation: { id: 'imported', status: 'completed' },
              },
            },
          };
    });
    await mount(createElement(MemoryRouter, null, createElement(GitHubPreparation, { status })));
    await click('Prepare repository');
    assert.match(text(), /Retry same preparation/);
    serve('/code/github/branches', {
      body: { branches: [{ name: status.baseBranch, sha: 'b'.repeat(40) }] },
    });
    await click('Retry same preparation');
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1], sent[0]);
    assert.equal(sent[0].headOid, 'a'.repeat(40));
    assert.match(text(), /Ready at/);
    assert.match(text(), /View changes/);
  });

  test('a branch response from an earlier repository connection cannot replace the new selection', async (t) => {
    t.after(unmount);
    let release!: (value: Response) => void;
    t.mock.method(
      globalThis,
      'fetch',
      async () =>
        await new Promise<Response>((done) => {
          release = done;
        }),
    );
    let change!: (value: GitHubStatus) => void;
    const Settings = () => {
      const [value, setValue] = useState(status);
      change = setValue;
      return createElement(GitHubAutomation, { status: value, onChanged: () => {} });
    };
    await mount(createElement(Settings));
    await click('Choose branch');
    await act(async () => change({ ...status, revision: 2, baseBranch: 'new-research-base' }));
    await act(async () => {
      release(
        new Response(JSON.stringify({ branches: [{ name: 'old-repository-branch' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    await settle();
    assert.match(text(), /new-research-base/);
    assert.doesNotMatch(text(), /old-repository-branch/);
    assert.equal(document.querySelectorAll('select').length, 1);
  });
}
