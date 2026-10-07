/**
 * The map of work and what is live on it, rendered from what the owners send. Each test
 * states one thing the page must never do: cover the map with its sidebar, lose the thing in
 * hand on a poll, colour anything red that no person has to act on, act on a control before
 * naming what it ends, print an identifier, or say a prerequisite waits that is settled.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mount, requests, resize, serve, settle, styled, text, unmount } from './ui-render.js';
import { board, emptyBoard, sandboxPanel, sessionPanel, taskPanel } from './ui-running-fixtures.js';

sessionStorage.setItem('merv:token', 'fixture-token');
const { createElement, useEffect } = await import('react');
const { MemoryRouter, useLocation, useNavigationType } = await import('react-router-dom');
const { act } = await import('react-dom/test-utils');
// components.tsx first: it and list-filters.tsx import each other through a view, and
// only this order has every module evaluated before another one calls into it.
await import('../packages/ui/web/components.js');
const {
  LiveLines,
  LiveUnder,
  WorkMap,
  WorkPlane,
  absorberOf,
  cadenceOf,
  liveLookup,
  liveOf,
  mapOf,
  staleLane,
} = await import('../packages/ui/web/views/work-map.js');
const { useActorNames } = await import('../packages/ui/web/views/people.js');
const { streamRows } = await import('../packages/ui/web/views/running-panel.js');
const { monoText } = await import('../packages/ui/web/views/running-phrase.js');
const { SessionProvider } = await import('../packages/ui/web/session.js');
const { runnerLiveness } = await import('../packages/ui/web/liveness.js');

/** jsdom measures nothing: the one width the drawing is laid out from is handed to it. */
let measured = 1200;
type Ran = (entries: { target?: Element; contentRect: { width: number } }[]) => void;
const watching = new Set<Ran>();
class Measure {
  constructor(private ran: Ran) {
    watching.add(ran);
  }
  observe(target: Element) {
    this.ran([{ target, contentRect: { width: measured } }]);
  }
  disconnect() {
    watching.delete(this.ran);
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any;
const drawn = (width = 1200) => {
  measured = width;
  global.ResizeObserver = Measure;
};
const listed = () => {
  delete global.ResizeObserver;
};
/** The map's column narrowed or widened, as the sidebar opening beside it does. */
const measure = async (width: number) => {
  measured = width;
  await act(async () => {
    for (const ran of watching) ran([{ contentRect: { width } }]);
  });
};

/** Where the page thinks it is, and how it got there. */
let where = '';
let how = '';
const Probe = () => {
  const location = useLocation();
  const type = useNavigationType();
  useEffect(() => {
    where = decodeURIComponent(location.pathname + location.search);
    how = type;
  }, [location, type]);
  return null;
};
/** Whether the map said it is drawn: the list under it then leaves its lines to the map. */
let drawnNow: boolean | undefined;
/** The wave's own records: none, unless a test is about what they add to the board. */
let wave: unknown = { items: [], edges: [] };
let shapes: unknown;
/**
 * The page as the Work view stands it: the map, what is live under it, and — in place of
 * the list, which is the wave's — the lines of who is on two of its units.
 */
const under = (nameOf: (id: string) => string | undefined) =>
  createElement(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    WorkPlane as any,
    { nameOf },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createElement(WorkMap as any, { shapes, wave, onDrawn: (now: boolean) => (drawnNow = now) }),
    createElement(LiveUnder, { agents: '/sessions' }),
    createElement(LiveLines, { id: 'wf_index' }),
    createElement(LiveLines, { id: 'wf_ablate' }),
  );
const page = (at = '/work', nameOf: (id: string) => string | undefined = () => undefined) =>
  createElement(MemoryRouter, { initialEntries: [at] }, createElement(Probe), under(nameOf));

/** What the board and each sidebar answer; every sidebar key asked is kept, in order. */
const asked: string[] = [];
function answers(given = board(), panels: Record<string, unknown> = {}) {
  asked.length = 0;
  const now = Date.parse(given.observedAt);
  const sidebars: Record<string, unknown> = {
    'work:wf_index': taskPanel(now),
    'session:session_ablate': sessionPanel(now),
    'sandbox:sbx_h100': sandboxPanel(now),
    'work:wf_table': {
      key: 'work:wf_table',
      observedAt: given.observedAt,
      header: { kind: 'Task', title: 'Sensitivity table', says: [{ state: 'done' }] },
      sections: [],
      actions: [],
      live: false,
    },
    'work:wf_review': {
      key: 'work:wf_review',
      observedAt: given.observedAt,
      header: { kind: 'Task', title: 'Review citation index', says: ['Waiting'] },
      sections: [],
      actions: [],
      live: false,
    },
    ...panels,
  };
  serve('/tools/ui.running', () => ({ body: { result: given } }));
  serve('/tools/ui.running_panel', (_, sent) => {
    const key = String(sent.key);
    asked.push(key);
    return key in sidebars
      ? { body: { result: sidebars[key] } }
      : {
          status: 404,
          body: { error: { code: 'running_not_found', message: 'Nothing answers for this' } },
        };
  });
}
const $ = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T & HTMLElement>(selector);
const all = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
const card = (key: string) => $(`[data-key="${key}"]`)!;
const press = async (element: Element) => {
  await act(async () => {
    (element as HTMLElement).click();
  });
  await settle(0);
};
const key = async (element: Element, name: string) => {
  await act(async () => {
    element.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true }));
  });
  await settle(0);
};
const button = (label: string, within: ParentNode = document) =>
  [...within.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label,
  );
const reads = (tool: string) => requests.filter((line) => line === `POST /tools/${tool}`).length;

test('under the map: how many are working, what needs a person in red, and each lane’s line with its control', async (t) => {
  t.after(unmount);
  drawn();
  const given = board();
  given.lanes.sessions.needsYou = 0;
  given.lanes.sessions.nodes[0]!.attention = {
    says: ['Launch failed 2 times, retrying'],
    quiet: true,
  };
  answers(given);
  await mount(page());
  // Two leases are live; one still starting and a machine being rented are not at work yet.
  assert.match($('.live-head-line')!.textContent!, /^2 working/);
  // Red beside the count only above zero; a quiet line is ink, and needs nobody.
  assert.deepEqual(
    all('.running-needs').map((item) => item.textContent),
    ['2 need you'],
  );
  assert.ok(!card('work:wf_ablate').classList.contains('wmap-node--attn'));
  assert.ok(card('work:wf_ablate').textContent!.includes('Launch failed 2 times, retrying'));
  // The line ends in the way to every agent and machine there has been: the page the rail
  // no longer lists.
  const more = $('.live-head-line a.live-more')!;
  assert.deepEqual(
    [more.textContent, more.getAttribute('href')],
    ['Agents and machines', '/sessions'],
  );
  // The Sessions line carries dispatch and its one control, which never wears the accent.
  const pause = button('Pause dispatch')!;
  assert.ok(pause && !pause.classList.contains('btn--primary'));
  assert.ok(text().includes('Dispatch running · Machines 2 · Free slots 1'));
  // What is live and on no unit of work has a line of its own there, the way to its sidebar.
  assert.deepEqual(
    all('.live-head .live-line').map((item) => item.dataset.key),
    ['sandbox:sbx_h100', 'sandbox:sbx_a10'],
  );
});

test('what a lane needs of a person has its own line, never cut, with who ends the wait and the way there', async (t) => {
  t.after(unmount);
  t.after(styled());
  drawn();
  // An operator's read: only it counts the work that waits, and says the one reason why.
  const given = board();
  given.lanes.sessions.needsYou = 1;
  given.lanes.sessions.summaries[0]!.attention = {
    says: ['No machine online · ', { count: 3 }, ' waiting'],
    who: 'Someone with a write key of this project starts a runner',
    to: { route: '/sessions', text: 'Open sessions' },
  };
  answers(given);
  await mount(page());
  const line = $('.live-head .running-lane-attn')!;
  assert.ok(line, 'the red clause stands under the lanes’ line');
  assert.equal(line.closest('.running-summary'), null, 'not squeezed into the lane’s own line');
  const red = line.querySelector<HTMLElement>('.running-attn')!;
  assert.equal(red.textContent, 'No machine online · 3 waiting');
  for (const item of [line, red]) {
    assert.notEqual(getComputedStyle(item).whiteSpace, 'nowrap');
    assert.notEqual(getComputedStyle(item).textOverflow, 'ellipsis');
  }
  assert.ok(line.textContent!.includes('Someone with a write key of this project starts a runner'));
  assert.equal(line.querySelector('a.running-target')!.getAttribute('href'), '/sessions');
});

test('a change of cadence waits from the last answer, and never reads the board again at once', async (t) => {
  t.after(unmount);
  drawn();
  const given = board();
  given.lanes.hardware.pending = true;
  answers(given);
  await mount(page());
  await settle(50);
  assert.equal(reads('ui.running'), 1, 'the first answer set the cadence; it asked nothing more');
  // The same for a sidebar whose owner says it is live where the board drew no dot.
  await press(card('sandbox:sbx_h100'));
  await settle(50);
  assert.deepEqual(asked, ['sandbox:sbx_h100']);
  // The pending lane's cadence of 2 s, set after the first answer, still reads it again.
  await settle(2100);
  assert.ok(reads('ui.running') >= 2, `the board was read ${reads('ui.running')} times`);
});

test('a lane whose source has never answered reads a dash, never a zero, and the board asks again soon', async (t) => {
  t.after(unmount);
  drawn();
  const given = board();
  given.lanes.sessions = { nodes: [], summaries: [], needsYou: 0, failed: [], pending: true };
  answers(given);
  await mount(page());
  assert.match($('.live-head-line')!.textContent!, /^— working/);
  // How often the board is read: soon while a source is unknown, often while anything moves.
  assert.equal(cadenceOf(given), 2000);
  assert.equal(cadenceOf(board()), 5000);
  const still = board();
  for (const lane of ['work', 'sessions', 'hardware'] as const)
    still.lanes[lane] = {
      ...still.lanes[lane],
      nodes: still.lanes[lane].nodes.map(({ dot: _, ...node }) => node),
      summaries: [],
    };
  assert.equal(cadenceOf(still), 15000);
  assert.equal(cadenceOf(undefined), 15000);
});

test('without the room to draw there is no map, and what is live is still said under it', async (t) => {
  t.after(unmount);
  listed();
  answers();
  await mount(page());
  assert.equal(all('.wmap-node').length, 0);
  assert.equal($('svg.wmap-wires'), null);
  assert.equal(drawnNow, false, 'the list under it is told, and says each relation in words');
  assert.equal($('.wmap')!.tabIndex, -1, 'a frame with nothing drawn takes no key');
  assert.match($('.live-head-line')!.textContent!, /^2 working/);
  assert.equal(all('.live-line').length, 5);
});

test('what a card waits on is part of its name, said once, and a prerequisite already settled is not waited on', async (t) => {
  t.after(unmount);
  drawn();
  const given = board();
  given.edges.push({
    from: 'work:wf_draft',
    to: 'work:wf_index',
    verb: 'waits on',
    waiting: false,
  });
  // A card whose own line says something else still names what it waits on.
  given.lanes.work.nodes[2]!.lines = [['Ready once it settles']];
  answers(given);
  await mount(page());
  const named = (key: string) => card(key).getAttribute('aria-label')!;
  assert.equal(
    named('work:wf_review'),
    'Task, Review citation index, Ready once it settles, Waits on Rebuild citation index',
  );
  assert.equal(named('work:wf_draft').match(/Waits on Ablate retrieval depth/g)!.length, 1);
  assert.ok(!named('work:wf_draft').includes('Rebuild citation index'));
  // The settled prerequisite still has its line, drawn whole; the open ones are dashed.
  assert.equal(all('.wmap-wire').length, 3);
  assert.equal(all('.wmap-wire--waiting').length, 2);
});

test('measured, the cards stand on the drawing, each prerequisite over what waits on it, and pointing lights a card’s lines', async (t) => {
  t.after(unmount);
  drawn(1200);
  answers();
  await mount(page());
  const cards = all('.wmap-node');
  assert.equal(cards.length, 5);
  assert.equal(drawnNow, true, 'the list under it is told, and does not say the lines again');
  for (const item of cards)
    assert.match(item.getAttribute('style') ?? '', /left: \d+px; top: \d+px/);
  const svg = $('svg.wmap-wires')!;
  assert.equal(svg.getAttribute('aria-hidden'), 'true');
  assert.equal(svg.getAttribute('width'), '1200');
  const at = (key: string) => [parseFloat(card(key).style.left), parseFloat(card(key).style.top)];
  for (const [first, then] of [
    ['work:wf_index', 'work:wf_review'],
    ['work:wf_ablate', 'work:wf_draft'],
  ]) {
    assert.equal(at(first!)[0], at(then!)[0], `${then} stands under ${first}`);
    assert.ok(at(then!)[1]! > at(first!)[1]!);
  }
  assert.ok(card('work:wf_review').classList.contains('wmap-node--waiting'));
  // A pulse runs only down a line whose upper end is being worked now.
  assert.equal(all('.wmap-wire').length, 2);
  assert.equal(all('.wmap-pulse').length, 2);
  assert.equal(all('.wmap-wire.on').length, 0);
  // Pointing at a card lights its lines while nothing is in hand.
  await act(async () => {
    card('work:wf_draft').dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  });
  assert.equal(all('.wmap-wire.on').length, 1);
  assert.equal(all('.wmap-wire.dim').length, 1);
});

test('a card says where its unit stands, and who is on it and where', async (t) => {
  t.after(unmount);
  t.after(() => {
    wave = { items: [], edges: [] };
    shapes = undefined;
  });
  drawn(1200);
  const flow = (state: string) => ({
    state,
    updatedAt: '2026-09-25T12:00:00Z',
    workflow: 'task',
    version: 6,
  });
  wave = {
    items: [
      {
        id: 'wf_index',
        kind: 'tasks',
        name: 'Rebuild citation index',
        flow: flow('in_progress'),
        at: '2026-09-25T12:00:00Z',
        held: true,
      },
      {
        id: 'wf_review',
        kind: 'tasks',
        name: 'Review citation index',
        flow: flow('in_progress'),
        at: '2026-09-25T11:00:00Z',
        held: true,
      },
      // Finished, and on the map only for what waits on it.
      {
        id: 'wf_pin',
        kind: 'tasks',
        name: 'Pin the tokenizer',
        flow: flow('done'),
        at: '2026-09-25T10:00:00Z',
        held: false,
      },
      // Finished, with nothing waiting on it: not on the map.
      {
        id: 'wf_old',
        kind: 'tasks',
        name: 'Count the tokens',
        flow: flow('done'),
        at: '2026-09-25T09:00:00Z',
        held: false,
      },
    ],
    edges: [
      { from: 'wf_pin', to: 'wf_index' },
      { from: 'wf_index', to: 'wf_review', waiting: true },
    ],
  };
  shapes = [
    {
      name: 'task',
      version: 6,
      initial: 'in_progress',
      states: ['in_progress', 'in_review', 'done', 'abandoned'],
      terminal: ['done', 'abandoned'],
      edges: [
        { from: 'in_progress', action: 'deliver', to: 'in_review' },
        { from: 'in_review', action: 'return', to: 'in_progress' },
        { from: 'in_review', action: 'pass', to: 'done' },
        { from: 'in_progress', action: 'abandon', to: 'abandoned' },
        { from: 'in_review', action: 'abandon', to: 'abandoned' },
      ],
    },
  ];
  answers();
  await mount(page());
  assert.equal(all('.wmap-node').length, 6);
  assert.equal($('[data-key="work:wf_old"]'), null);
  // The stage: its mark and its word, the one way everywhere.
  const index = card('work:wf_index');
  const stage = index.querySelector('.stage-mark')!;
  assert.equal(stage.textContent, 'in progress');
  assert.ok(stage.querySelector('svg.stage-glyph--work'));
  // Who is on it and where takes the place of the board's own line, which said less.
  assert.deepEqual(
    [...index.querySelectorAll('.wmap-line')].map((line) => line.textContent),
    ['Rebuild citation index on mac-studio'],
  );
  assert.ok(!index.textContent!.includes('Producer on it'));
  // With nobody on it, the board's line says why.
  assert.ok(card('work:wf_review').textContent!.includes('Waits on Rebuild citation index'));
  // A finished prerequisite is quiet, checked, and gives the line its upper end.
  const pin = card('work:wf_pin');
  assert.ok(pin.classList.contains('wmap-node--done'));
  assert.equal(pin.querySelector('.stage-mark')!.textContent, 'done');
  assert.ok(pin.querySelector('svg.stage-glyph--done .stage-sign'));
  assert.equal(all('.wmap-wire').length, 3);
  // One line for each relation, however many owners say it.
  assert.equal(all('.wmap-wire--waiting').length, 2);
  assert.equal(
    card('work:wf_index').getAttribute('aria-label'),
    'Task, Rebuild citation index, in progress, Rebuild citation index',
  );
});

test('the map joins the wave’s records to the board by key, and says who is on a unit and where', () => {
  const given = board();
  const { units, edges } = mapOf(given, {
    items: [
      {
        id: 'wf_index',
        kind: 'tasks',
        name: 'Rebuild the index',
        flow: { state: 'in_progress', updatedAt: '' },
        at: '2',
        held: true,
      },
      {
        id: 'wf_pin',
        kind: 'tasks',
        name: 'Pin',
        flow: { state: 'done', updatedAt: '' },
        at: '1',
        held: false,
      },
      {
        id: 'wf_new',
        kind: 'experiments',
        name: 'Planned',
        flow: { state: 'planned', updatedAt: '' },
        at: '3',
        held: true,
      },
    ],
    edges: [{ from: 'wf_pin', to: 'wf_index' }],
  });
  // The board's cards lead in the board's order; then what the wave holds open; then what
  // any of those waits on.
  assert.deepEqual(
    units.map((unit) => unit.key),
    [
      'work:wf_table',
      'work:wf_index',
      'work:wf_review',
      'work:wf_ablate',
      'work:wf_draft',
      'work:wf_new',
      'work:wf_pin',
    ],
  );
  const index = units[1]!;
  assert.equal(index.name, 'Rebuild the index', 'the record’s own name');
  assert.equal(index.flow!.state, 'in_progress');
  assert.equal(index.node!.dot, 'moving');
  assert.equal(units[5]!.kind, 'Experiment');
  assert.equal(units[5]!.node, undefined);
  // The board says a prerequisite from the side of what waits; the map draws it from above.
  assert.deepEqual(
    edges.map((edge) => `${edge.from} > ${edge.to}`),
    [
      'work:wf_pin > work:wf_index',
      'work:wf_index > work:wf_review',
      'work:wf_ablate > work:wf_draft',
    ],
  );
  assert.deepEqual(mapOf(undefined, undefined), { units: [], edges: [] });
  // A prerequisite reached through another one is still a card, and has no line of its own
  // to what waits on both: the line through the nearer one says it.
  const record = (id: string, held = false) => ({
    id,
    kind: 'tasks',
    name: id,
    flow: { state: held ? 'planned' : 'done', updatedAt: '' },
    at: id,
    held,
  });
  const drawn = (wave: { from: string; to: string }[], ids: string[], open = ['c']) =>
    mapOf(undefined, { items: ids.map((id) => record(id, open.includes(id))), edges: wave });
  const lines = (...given: Parameters<typeof drawn>) =>
    drawn(...given)
      .edges.map((edge) => `${edge.from.slice(5)}>${edge.to.slice(5)}`)
      .sort();
  const chain = [
    { from: 'a', to: 'c' },
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
  ];
  assert.deepEqual(lines(chain, ['a', 'b', 'c']), ['a>b', 'b>c']);
  assert.deepEqual(
    drawn(chain, ['a', 'b', 'c'])
      .units.map((unit) => unit.key)
      .sort(),
    ['work:a', 'work:b', 'work:c'],
  );
  // With the one between them not on the map, the far one's line is all there is.
  assert.deepEqual(lines(chain, ['a', 'c']), ['a>c']);
  // Two ways down that meet again are both drawn; only the line that skips a way is not.
  const diamond = [
    { from: 'a', to: 'b' },
    { from: 'a', to: 'd' },
    { from: 'b', to: 'c' },
    { from: 'd', to: 'c' },
  ];
  const all = ['a', 'b', 'c', 'd'];
  assert.deepEqual(lines(diamond, all, all), ['a>b', 'a>d', 'b>c', 'd>c']);
  assert.deepEqual(lines([...diamond, { from: 'a', to: 'c' }], all, all), [
    'a>b',
    'a>d',
    'b>c',
    'd>c',
  ]);
  // Narrowed by the page, the map is the kept records alone: no prerequisite beside them and
  // nothing the board holds in flight, and a kept record still wears the board's card.
  const narrowed = mapOf(given, {
    only: true,
    items: [record('c', true), record('a'), { ...record('wf_ablate', true), name: 'Ablate' }],
    edges: chain,
  });
  assert.deepEqual(narrowed.units.map((unit) => unit.key).sort(), ['work:c', 'work:wf_ablate']);
  assert.ok(narrowed.units.find((unit) => unit.key === 'work:wf_ablate')!.node);
  assert.deepEqual(narrowed.edges, []);
  // Who is on a unit: its sessions, the machines that serve it, never what it waits on.
  const on = (key: string) => liveOf(given, key).map((node) => node.key);
  assert.deepEqual(on('work:wf_ablate'), ['session:session_ablate', 'compute:c0ffee']);
  assert.deepEqual(on('work:wf_draft'), ['session:session_draft', 'fleet:flt_spare']);
  assert.deepEqual(on('work:wf_review'), []);
  assert.deepEqual(liveOf(undefined, 'work:wf_index'), []);
  assert.equal(absorberOf(given, 'fleet:flt_bound')!.key, 'session:session_ablate');
  assert.equal(absorberOf(given, 'work:wf_gone'), undefined);
});

test('pressing a card puts it in the address, docks its sidebar beside the map, and lights what it relates to', async (t) => {
  t.after(unmount);
  drawn(1200);
  answers();
  await mount(page());
  await press(card('work:wf_index'));
  assert.equal(where, '/work?key=work:wf_index');
  assert.equal(how, 'PUSH', 'opening a sidebar is a step Back can undo');
  assert.deepEqual(asked, ['work:wf_index']);
  assert.equal($('.running-plane')!.hasAttribute('data-open'), true);
  assert.equal($('#running-panel')!.hidden, false);
  assert.equal($('.work-main')!.hidden, false, 'the map is never covered or hidden here');
  assert.equal(document.activeElement, $('#running-panel-title'));
  assert.equal(card('work:wf_index').getAttribute('aria-pressed'), 'true');
  // Its stages are one card with one name, whichever plugin sent them and whatever it called them.
  assert.equal($('.stage-card-title')!.textContent, 'Time in status');
  assert.deepEqual(
    all('.stage-card .stage-word').map((item) => item.textContent),
    ['in progress', 'in review', 'done'],
  );
  assert.ok(!$('#running-panel')!.textContent!.includes('Progress'));
  // What it relates to stays; what it does not steps back, unless it needs a person.
  assert.ok(!card('work:wf_review').classList.contains('dim'));
  assert.ok(card('work:wf_draft').classList.contains('dim'));
  for (const key of ['work:wf_table', 'work:wf_ablate'])
    assert.ok(!card(key).classList.contains('dim'), 'a card that needs a person never dims');
  assert.equal(all('.wmap-wire.on').length, 1);
  assert.equal(all('.wmap-wire.dim').length, 1);
  // The sidebar narrows the map's column, and the drawing lays itself out again for it.
  await measure(760);
  assert.equal($('svg.wmap-wires')!.getAttribute('width'), '760');
  const right = Math.max(
    ...all('.wmap-node').map((item) => parseFloat(item.style.left) + parseFloat(item.style.width)),
  );
  assert.ok(right <= 760, 'no card stands under the sidebar');
  // A poll keeps the thing in hand.
  await act(async () => {
    const { refreshTools } = await import('../packages/ui/web/api.js');
    refreshTools('ui.running');
  });
  await settle(0);
  assert.equal(where, '/work?key=work:wf_index');
  assert.equal(card('work:wf_index').getAttribute('aria-pressed'), 'true');
  // The card of the unit an agent in hand is on stays lit, and the agent's own line is pressed.
  await press(card('session:session_ablate'));
  assert.equal(where, '/work?key=session:session_ablate');
  assert.equal(card('work:wf_ablate').getAttribute('aria-pressed'), 'true');
  assert.equal(card('session:session_ablate').getAttribute('aria-pressed'), 'true');
});

test('an address naming a card another absorbed opens that card, in place of the address', async (t) => {
  t.after(unmount);
  drawn();
  answers();
  await mount(page('/work?key=fleet:flt_bound'));
  await settle(0);
  assert.equal(where, '/work?key=session:session_ablate');
  assert.equal(how, 'REPLACE');
  assert.deepEqual(asked, ['session:session_ablate'], 'the absorbed key is never read');
  assert.ok(text().includes('Fleet machine'));
});

test('a key that is not on the board still opens its sidebar; one nobody answers for says so', async (t) => {
  t.after(unmount);
  drawn();
  answers(board(), {
    'session:session_closed': {
      key: 'session:session_closed',
      observedAt: new Date().toISOString(),
      header: { kind: 'Agent', title: 'Clean held-out set', says: ['Released · completed'] },
      sections: [],
      actions: [],
      live: false,
    },
  });
  await mount(page('/work?key=session:session_closed'));
  assert.ok(text().includes('Released · completed'));
  await unmount();
  answers();
  await mount(page('/work?key=session:session_gone'));
  assert.ok(text().includes('Not found'), text().slice(0, 400));
  assert.ok($('.running-close'), 'the sidebar can still be closed');
});

test('a sidebar whose owner cannot answer yet says it could not load, never Not found, and keeps asking', async (t) => {
  t.after(unmount);
  drawn();
  const now = Date.now();
  const given = board(now);
  // A machine the board draws live, so its sidebar is read again every 4 s.
  given.lanes.hardware.nodes[3]!.dot = 'live';
  answers(given);
  // Sandboxes before the machines were first read: 503, which is not a thing that is gone.
  serve('/tools/ui.running_panel', (call, sent) => {
    asked.push(String(sent.key));
    return call === 1
      ? {
          status: 503,
          body: {
            error: {
              code: 'sandbox_machines_pending',
              message: 'The machines have not been read yet',
            },
          },
        }
      : {
          body: {
            result: {
              key: 'sandbox:sbx_a10',
              observedAt: given.observedAt,
              header: { kind: 'Sandbox', title: 'embed-refs', says: ['Idle'] },
              sections: [],
              actions: [],
              live: true,
            },
          },
        };
  });
  await mount(page());
  await press(card('sandbox:sbx_a10'));
  assert.ok(text().includes('Could not load'), text().slice(0, 400));
  assert.ok(!text().includes('Not found'));
  assert.equal(where, '/work?key=sandbox:sbx_a10', 'the sidebar stays open');
  assert.ok($('.running-close'), 'and can be closed');
  await settle(4200);
  assert.deepEqual(asked, ['sandbox:sbx_a10', 'sandbox:sbx_a10']);
  assert.ok(!text().includes('Could not load'));
  assert.equal($('#running-panel-title')!.textContent, 'embed-refs');
});

test('a link whose key nobody answers for goes to the page it carries, in place of a dead end', async (t) => {
  t.after(unmount);
  drawn();
  const now = Date.now();
  const task = taskPanel(now);
  const unblocks = task.sections.find((section) => section.title === 'Unblocks')!;
  if (unblocks.kind === 'links')
    unblocks.rows.push({
      to: { key: 'work:wf_cycle', route: '/research/wf_cycle' },
      kind: 'Research',
      name: 'Citation coverage study',
      says: [{ state: 'running' }],
    });
  answers(board(now), { 'work:wf_index': task });
  await mount(page());
  await press(card('work:wf_index'));
  const jump = all('.running-jump').find((item) =>
    item.textContent?.includes('Citation coverage study'),
  )!;
  await press(jump);
  await settle(0);
  assert.deepEqual(asked, ['work:wf_index', 'work:wf_cycle'], 'its owner is asked first');
  assert.equal(where, '/research/wf_cycle');
  assert.equal(how, 'REPLACE', 'the key nobody answers for is not left in history');
  assert.ok(!text().includes('Not found'), text().slice(0, 400));
});

test('Escape inside a guard only cancels it; outside, it closes the sidebar and hands the cursor back', async (t) => {
  t.after(unmount);
  drawn();
  answers();
  await mount(page());
  await press(card('session:session_ablate'));
  await press(button('Halt lease')!);
  const guard = $('.guard')!;
  assert.ok(guard);
  await key(button('Cancel', guard)!, 'Escape');
  assert.equal($('.guard'), null, 'the guard closed');
  assert.equal(where, '/work?key=session:session_ablate', 'and the sidebar did not');
  await key($('#running-panel-title')!, 'Escape');
  assert.equal(where, '/work');
  assert.equal($('#running-panel')!.hidden, true);
  assert.equal(document.activeElement, card('session:session_ablate'));
});

test('Maximize gives the sidebar the page’s place; Restore or Escape gives it back, and closing forgets it', async (t) => {
  t.after(unmount);
  drawn(1200);
  answers();
  await mount(page());
  await press(card('work:wf_index'));
  await press($('button[aria-label="Maximize"]')!);
  assert.equal($('.running-plane')!.hasAttribute('data-full'), true);
  assert.equal($('.work-main')!.hidden, true, 'the page steps aside');
  assert.equal(where, '/work?key=work:wf_index');
  // Escape takes one step back: the sidebar beside the page again, still open.
  await key($('#running-panel-title')!, 'Escape');
  assert.equal($('.running-plane')!.hasAttribute('data-full'), false);
  assert.equal($('.work-main')!.hidden, false);
  assert.equal(where, '/work?key=work:wf_index');
  await press($('button[aria-label="Maximize"]')!);
  await press($('button[aria-label="Restore"]')!);
  assert.equal($('.work-main')!.hidden, false);
  // Shut while maximized, the next sidebar opens beside the page.
  await press($('button[aria-label="Maximize"]')!);
  await press($('button[aria-label="Close"]')!);
  assert.equal(where, '/work');
  await press(card('work:wf_index'));
  assert.equal($('.running-plane')!.hasAttribute('data-full'), false);
});

test('an Escape a menu or a dialog takes as its own shuts that, and leaves the sidebar open', async (t) => {
  t.after(unmount);
  drawn();
  answers();
  await mount(page());
  await press(card('session:session_ablate'));
  // The rail's account menu, open over the page, with the cursor on its first item.
  const menu = document.createElement('div');
  menu.setAttribute('role', 'menu');
  const item = document.createElement('button');
  item.setAttribute('role', 'menuitem');
  menu.appendChild(item);
  document.body.appendChild(menu);
  t.after(() => menu.remove());
  item.focus();
  await key(item, 'Escape');
  assert.equal(where, '/work?key=session:session_ablate');
  assert.equal($('#running-panel')!.hidden, false);
  menu.setAttribute('role', 'dialog');
  await key(item, 'Escape');
  assert.equal(where, '/work?key=session:session_ablate');
  // Nor does one pressed inside the Agent's window, which stands beside the page.
  menu.removeAttribute('role');
  menu.className = 'pi-dock';
  await key(item, 'Escape');
  assert.equal(where, '/work?key=session:session_ablate');
  menu.className = '';
  // Nor does one another control already took, wherever it was pressed.
  await act(async () => {
    const taken = new window.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    taken.preventDefault();
    $('#running-panel-title')!.dispatchEvent(taken);
  });
  assert.equal(where, '/work?key=session:session_ablate');
  await key($('#running-panel-title')!, 'Escape');
  assert.equal(where, '/work');
});

test('the map’s keys leave a modified key to the browser, and a control under the map to itself', async (t) => {
  t.after(unmount);
  drawn(1600);
  answers();
  await mount(page());
  const graph = $('.wmap')!;
  await key(graph, 'ArrowRight');
  const first = document.activeElement as HTMLElement;
  assert.equal(first.dataset.key, 'work:wf_table');
  const pressed = async (on: Element, name: string, more: KeyboardEventInit = {}) => {
    let kept = true;
    await act(async () => {
      kept = on.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: name,
          bubbles: true,
          cancelable: true,
          ...more,
        }),
      );
    });
    await settle(0);
    return kept;
  };
  // Alt+Left is Back, and Cmd or Ctrl with an arrow is the browser's too.
  for (const more of [{ altKey: true }, { metaKey: true }, { ctrlKey: true }]) {
    assert.equal(await pressed(first, 'ArrowLeft', more), true, JSON.stringify(more));
    assert.equal(document.activeElement, first, JSON.stringify(more));
  }
  assert.equal(await pressed(first, 'j', { ctrlKey: true }), true);
  assert.equal(document.activeElement, first);
  // An arrow on Pause dispatch stays with it rather than jumping to the first card.
  const pause = button('Pause dispatch')!;
  pause.focus();
  assert.equal(await pressed(pause, 'ArrowDown'), true);
  assert.equal(document.activeElement, pause);
  // Unmodified, from a card, the keys still walk.
  await key(first, 'j');
  assert.equal((document.activeElement as HTMLElement).dataset.key, 'work:wf_index');
});

test('a lane is stale by the age of its source when the board was read, not by the page’s clock since', () => {
  const read = Date.parse('2026-09-25T12:00:00.000Z');
  const lane = (old: number) => ({
    nodes: [],
    summaries: [],
    needsYou: 0,
    failed: [],
    asOf: new Date(read - old).toISOString(),
    freshForMs: 10_000,
  });
  const after = (ms: number) => ({ at: read + ms, since: ms, stale: false });
  // Read 8 s old against a 10 s window: current, however long the next board takes.
  assert.equal(staleLane(lane(8_000), after(0)), false);
  assert.equal(staleLane(lane(8_000), after(5_000)), false);
  assert.equal(staleLane(lane(8_000), after(60_000)), false);
  // Already past its window when the board was read: stale from the start.
  assert.equal(staleLane(lane(12_000), after(0)), true);
  assert.equal(staleLane({ ...lane(12_000), asOf: undefined }, after(0)), false);
});

test('a key link in a sidebar swaps what it shows in place, and Close leaves the way it came', async (t) => {
  t.after(unmount);
  drawn();
  answers();
  await mount(page());
  await press(card('work:wf_index'));
  const jump = all('.running-jump').find((item) =>
    item.textContent?.includes('Review citation index'),
  )!;
  await press(jump);
  assert.equal(where, '/work?key=work:wf_review');
  assert.equal(how, 'REPLACE', 'swapping inside an open sidebar adds nothing to history');
  assert.equal(card('work:wf_review').getAttribute('aria-pressed'), 'true');
  await press($('.running-close')!);
  assert.equal(where, '/work');
  assert.equal(how, 'POP', 'Close takes back the one step the opening added');
  assert.equal(document.activeElement, card('work:wf_review'));
});

test('red is only what a person has to do: a card, a line — and never a clock of itself', async (t) => {
  t.after(unmount);
  drawn();
  answers();
  await mount(page());
  // The held task, and the experiment whose agent has gone quiet: the card wears what any
  // of who is on it needs.
  const red = all('.wmap-node--attn').map((item) => item.dataset.key);
  assert.deepEqual(red.sort(), ['work:wf_ablate', 'work:wf_table']);
  assert.deepEqual(
    all('.wmap-node .live-dot--attn')
      .map((item) => item.closest<HTMLElement>('[data-key]')!.dataset.key)
      .sort(),
    red.sort(),
  );
  assert.deepEqual(
    all('.live-line')
      .filter((item) => item.querySelector('.live-dot--attn'))
      .map((item) => item.dataset.key)
      .sort(),
    ['sandbox:sbx_h100', 'session:session_ablate'],
  );
  // What a person has to do stands where the unit's own line would.
  assert.equal(
    card('work:wf_table').querySelector('.wmap-line.running-attn')!.textContent,
    'Waiting on a person to merge the pull request',
  );
  assert.equal(
    card('work:wf_ablate').querySelector('.wmap-line.running-attn')!.textContent,
    'Ablate retrieval depth · Quiet 34m',
  );
  await press(card('sandbox:sbx_h100'));
  const rows = all('.running-facts .kv-row');
  const row = (label: string) =>
    rows.find((item) => item.querySelector('dt')?.textContent === label)!;
  assert.ok(row('Lease').classList.contains('running-attn'));
  assert.ok(!row('Cost').classList.contains('running-attn'));
  // A countdown one minute from its end is neither amber nor red when its row needs nobody.
  const soon = row('Next job');
  assert.ok(soon.textContent!.includes('left'), soon.textContent!);
  assert.ok(!soon.classList.contains('running-attn'));
  assert.equal(all('.countdown--now, .countdown--soon').length, 0);
  assert.ok(text().includes('$16.74 · $32.40/h'));
});

test('a finished unit steps back in quiet ink, except for the red line saying what a person must do', async (t) => {
  t.after(unmount);
  t.after(styled());
  drawn();
  answers();
  await mount(page());
  const held = card('work:wf_table');
  assert.ok(held.classList.contains('wmap-node--done'));
  assert.ok(held.classList.contains('wmap-node--attn'), 'and keeps its red frame');
  assert.equal(getComputedStyle(held.querySelector('.wmap-name')!).color, 'var(--muted)');
  const red = held.querySelector<HTMLElement>('.wmap-line.running-attn')!;
  assert.equal(getComputedStyle(red).color, 'var(--refutes)');
});

test('a quiet line is ink wherever it stands: on a card, on an agent’s line, in a sidebar’s head and under the map', async (t) => {
  t.after(unmount);
  t.after(styled());
  drawn();
  const now = Date.now();
  const given = board(now);
  // What Fleet cannot see about a working machine, folded into the lease that took it in.
  const quiet = {
    says: ['The sandbox service is not answering about this machine'],
    quiet: true as const,
  };
  given.lanes.sessions.nodes[0]!.attention = quiet;
  given.lanes.sessions.needsYou = 0;
  given.lanes.work.nodes[0]!.attention = {
    says: ['Ready · launch failed 2 times, retrying'],
    quiet: true,
  };
  given.lanes.work.needsYou = 0;
  given.lanes.sessions.summaries[0]!.attention = { says: ['Dispatch waiting'], quiet: true };
  const panel = sessionPanel(now);
  panel.header.attention = quiet;
  answers(given, { 'session:session_ablate': panel });
  await mount(page());
  assert.deepEqual(
    all('.running-needs').map((item) => item.textContent),
    ['1 needs you'],
    'only a machine needs anyone',
  );
  for (const key of ['work:wf_ablate', 'work:wf_table']) {
    const held = card(key);
    assert.ok(!held.classList.contains('wmap-node--attn'), key);
    assert.equal(held.querySelector('.running-attn, .live-dot--attn'), null, key);
  }
  const lines = (key: string) => [...card(key).querySelectorAll<HTMLElement>('.wmap-line')];
  const said = lines('work:wf_ablate').find((line) => line.textContent!.includes(quiet.says[0]));
  assert.equal(getComputedStyle(said!).color, 'var(--muted)');
  assert.equal(lines('work:wf_table')[0]!.textContent, 'Ready · launch failed 2 times, retrying');
  assert.equal(getComputedStyle(lines('work:wf_table')[0]!).color, 'var(--muted)');
  // The agent's own line says it too, in ink, with a green dot and not a red one.
  const agent = card('session:session_ablate');
  assert.ok(agent.textContent!.includes(quiet.says[0]));
  assert.equal(agent.querySelector('.running-attn, .live-dot--attn'), null);
  const lane = $('.live-head .running-lane-attn')!;
  assert.equal(lane.textContent, 'Dispatch waiting');
  assert.equal(lane.querySelector('.running-attn'), null);
  await press(agent);
  const says = $('.running-says')!;
  assert.equal(says.textContent, quiet.says[0]);
  assert.ok(!says.classList.contains('running-attn'));
  assert.equal(getComputedStyle(says).color, 'var(--muted)');
});

test('a held card’s sidebar borrows the board’s mark: the sentence, who ends the wait, and the way to the move', async (t) => {
  t.after(unmount);
  drawn();
  answers();
  await mount(page());
  await press(card('work:wf_table'));
  const says = $('.running-says')!;
  assert.ok(says.classList.contains('running-attn'));
  assert.equal(says.textContent, 'Waiting on a person to merge the pull request');
  assert.ok(text().includes('A signed-in operator'));
  const move = $<HTMLAnchorElement>('a.running-move')!;
  assert.equal(move.getAttribute('href'), '/code');
  assert.equal(move.textContent, 'Merge reviewed proposal');
  assert.ok(move.querySelector('svg'), 'the shell ends the link with its own arrow');
});

test('a held card’s mark carries its owner’s release: it asks why, sends a fresh request, says a refusal and reads again', async (t) => {
  t.after(unmount);
  drawn();
  const given = board();
  const held = given.lanes.work.nodes.find(({ key }) => key === 'work:wf_table')!;
  held.attention = {
    says: ['Held after ', { count: 5 }, ' failed launches'],
    who: 'A project admin can release the hold',
    action: {
      label: 'Release hold',
      verb: 'start',
      tool: 'session.release_hold',
      input: { instanceId: 'wf_table', expectedRevision: 3 },
      allowed: true,
      guard: {
        title: 'Release this hold?',
        consequence:
          'Dispatch offers this work again. If its launches keep failing, it is held again.',
      },
      ask: { field: 'reason', label: 'Reason', value: 'Cause fixed; retry' },
      requestId: true,
    },
  };
  answers(given);
  const sent: Record<string, unknown>[] = [];
  serve('/tools/session.release_hold', (call, input) => {
    sent.push(input);
    return call === 1
      ? {
          status: 409,
          body: {
            error: {
              code: 'hold_not_held',
              message: 'This target is still being retried; it is not held',
            },
          },
        }
      : { body: { result: { instanceId: 'wf_table', revision: 3, attempts: 0, heldAt: null } } };
  });
  await mount(page());
  await press(card('work:wf_table'));
  assert.ok(text().includes('A project admin can release the hold'));
  await press(button('Release hold', $('.running-panel-head')!)!);
  const guard = $('.guard')!;
  assert.equal(guard.getAttribute('aria-label'), 'Release this hold?');
  const reason = guard.querySelector<HTMLInputElement>('input')!;
  assert.equal(reason.value, 'Cause fixed; retry');
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    set.call(reason, 'Image rebuilt');
    reason.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const boards = reads('ui.running');
  await press(button('Release hold', $('.guard')!)!);
  assert.equal(sent.length, 1);
  const [first] = sent;
  assert.deepEqual(
    { ...first, requestId: undefined },
    { instanceId: 'wf_table', expectedRevision: 3, reason: 'Image rebuilt', requestId: undefined },
  );
  assert.equal(typeof first!.requestId, 'string');
  // A refusal is said in the guard, which stays, and nothing is read again as though it worked.
  assert.equal(
    $('.guard [role="alert"]')!.textContent,
    'This target is still being retried; it is not held',
  );
  assert.equal(reads('ui.running'), boards);
  await press(button('Release hold', $('.guard')!)!);
  assert.equal(sent.length, 2);
  assert.notEqual(sent[1]!.requestId, first!.requestId, 'a new press is a new request');
  assert.equal(sent[1]!.reason, 'Image rebuilt');
  assert.equal($('.guard'), null);
  assert.ok(reads('ui.running') > boards, 'a release reads the board again');
});

test('a hold’s release stays in the sidebar under its owner’s own red line, and asks for a reason before it sends', async (t) => {
  t.after(unmount);
  drawn();
  const given = board();
  const held = given.lanes.work.nodes.find(({ key }) => key === 'work:wf_table')!;
  held.attention = {
    says: ['No independent reviewer can take it'],
    who: 'An operator adds a reviewer',
    action: {
      label: 'Release hold',
      verb: 'start',
      tool: 'session.release_hold',
      input: { instanceId: 'wf_table', expectedRevision: 3 },
      allowed: true,
      guard: { title: 'Release this hold?', consequence: 'Dispatch offers this work again.' },
      ask: { field: 'reason', label: 'Reason' },
      requestId: true,
    },
  };
  answers(given, {
    'work:wf_table': {
      key: 'work:wf_table',
      observedAt: given.observedAt,
      header: {
        kind: 'Task',
        title: 'Sensitivity table',
        says: ['Ready'],
        attention: { says: ['No independent reviewer can take it'], who: 'An operator' },
      },
      sections: [],
      actions: [],
      live: false,
    },
  });
  const sent: Record<string, unknown>[] = [];
  serve('/tools/session.release_hold', (_, input) => {
    sent.push(input);
    return { body: { result: { instanceId: 'wf_table', revision: 3, attempts: 0, heldAt: null } } };
  });
  await mount(page());
  await press(card('work:wf_table'));
  assert.equal($('.running-says')!.textContent, 'No independent reviewer can take it');
  await press(button('Release hold', $('.running-panel-head')!)!);
  const reason = $('.guard')!.querySelector<HTMLInputElement>('input')!;
  assert.equal(reason.value, '');
  const confirm = () => button('Release hold', $('.guard')!)!;
  assert.equal(confirm().disabled, true, 'no reason, no release');
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  const type = async (text: string) =>
    await act(async () => {
      set.call(reason, text);
      reason.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  await type('   ');
  assert.equal(confirm().disabled, true, 'spaces are no reason');
  await press(confirm());
  assert.equal(sent.length, 0);
  await type('Reviewer added');
  assert.equal(confirm().disabled, false);
  await press(confirm());
  assert.equal(sent[0]!.reason, 'Reviewer added');
});

test('a link that is a fact’s whole value is a target of its own; one inside a sentence stays text', async (t) => {
  t.after(unmount);
  drawn();
  const now = Date.now();
  const task = taskPanel(now);
  const code = task.sections.find((section) => section.title === 'Code')!;
  if (code.kind === 'facts')
    code.rows.unshift({
      label: 'Needs',
      value: [
        'Merge the reviewed proposal · a signed-in operator · ',
        { link: { route: '/code' }, text: 'Merge reviewed proposal' },
      ],
      attention: true,
    });
  answers(board(now), { 'work:wf_index': task });
  await mount(page());
  await press(card('work:wf_index'));
  const value = (label: string) =>
    all('.running-facts .kv-row')
      .find((row) => row.querySelector('dt')?.textContent === label)!
      .querySelector('dd')!;
  // Reviews' last row is only the way to the verdict page, so it is as tall as a control.
  const verdict = value('Verdict page').querySelector<HTMLAnchorElement>('a.running-target')!;
  assert.ok(verdict.classList.contains('hit'));
  assert.equal(verdict.getAttribute('href'), '/reviews/review_1');
  assert.equal(verdict.textContent, 'Open the review');
  assert.ok(value('Pull request').querySelector('a.running-target')!.classList.contains('hit'));
  // Inside a sentence the link is words that go somewhere, at the sentence's own height.
  const inline = value('Needs').querySelector<HTMLAnchorElement>('a.running-target')!;
  assert.equal(inline.getAttribute('href'), '/code');
  assert.ok(!inline.classList.contains('hit'));
});

test('the live region holds every word of the standing and none of its clocks', async (t) => {
  t.after(unmount);
  drawn();
  const now = Date.now();
  answers(board(now), {
    'session:session_index': {
      ...sessionPanel(now),
      key: 'session:session_index',
      header: {
        kind: 'Agent',
        title: 'Rebuild citation index',
        says: [
          { state: 'active' },
          ' for ',
          { since: new Date(now - 90_000).toISOString() },
          ' · on mac-studio',
        ],
      },
    },
  });
  await mount(page());
  await press(card('session:session_ablate'));
  const says = $('.running-says')!;
  assert.match(says.textContent!, /^Quiet 34m$/);
  const status = () => $('.running-panel-head [role="status"]')!;
  assert.equal(status().textContent, 'Quiet');
  assert.equal(status().querySelector('time'), null);
  assert.ok(text().includes('An operator halts the lease.'));
  // Words after a clock are the standing too: a new machine is told, the ticking is not.
  await press(card('session:session_index'));
  assert.match($('.running-says')!.textContent!, /^active for 1m · on mac-studio$/);
  // What joined a clock to the line goes with it, so the region is told a whole sentence.
  assert.equal(status().textContent, 'active · on mac-studio');
  // A countdown is said as something ending, which holds still until it has ended.
  await press(card('sandbox:sbx_h100'));
  assert.match($('.running-says')!.textContent!, /^Lease 6m 0s left$/);
  assert.equal(status().textContent, 'Lease ending');
});

test('Halt lease names its consequence first, sends its input as written, and a halt of nothing keeps the guard open', async (t) => {
  t.after(unmount);
  drawn();
  answers();
  const sent: Record<string, unknown>[] = [];
  serve('/tools/session.halt', (call, input) => {
    sent.push(input);
    return { body: { result: { halted: call === 1 ? 0 : 1 } } };
  });
  await mount(page());
  await press(card('session:session_ablate'));
  const opener = $('.act-danger > button')!;
  assert.equal(opener.textContent, 'Halt lease');
  await press(opener);
  const guard = $('.guard')!;
  assert.equal(guard.getAttribute('aria-label'), 'Halt this lease?');
  assert.ok(guard.textContent!.includes('Halting closes it now.'));
  const boards = reads('ui.running');
  await press(button('Halt lease', guard)!);
  assert.deepEqual(sent, [{ sessionId: 'session_ablate', reason: 'halted_by_operator' }]);
  assert.ok($('.guard'), 'nothing was halted, so the guard stays');
  assert.ok($('.guard')!.textContent!.includes('Nothing was halted.'));
  assert.equal(reads('ui.running'), boards, 'and nothing is refreshed as though it had happened');
  await press(button('Halt lease', $('.guard')!)!);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], sent[0], 'the same input, verbatim, with no request id');
  assert.equal($('.guard'), null);
  assert.ok(reads('ui.running') > boards, 'a confirmed halt reads the board again');
});

test('a control the owner did not send is not drawn, and one it sent is its own words', async (t) => {
  t.after(unmount);
  drawn();
  answers(board(), { 'sandbox:sbx_h100': sandboxPanel(Date.now(), false) });
  const sent: unknown[] = [];
  serve('/tools/sandbox.extend', (_, input) => {
    sent.push(input);
    return { body: { result: { id: 'sbx_h100' } } };
  });
  await mount(page());
  await press(card('sandbox:sbx_h100'));
  assert.equal(button('Release machine'), undefined);
  const extend = button('Extend lease')!;
  assert.ok(!extend.classList.contains('btn--primary'), 'only a start wears the accent');
  await press(extend);
  assert.deepEqual(sent, [{ id: 'sbx_h100', seconds: 3600 }]);
  // The table is the ruled list, so it stacks by the sidebar's own width.
  assert.ok($('#running-panel [role="table"][aria-label="Jobs"]'));
  assert.equal($('#running-panel table'), null);
});

test('an extension whose answer was lost is never offered as a retry: a second one adds again', async (t) => {
  t.after(unmount);
  drawn();
  answers(board(), { 'sandbox:sbx_h100': sandboxPanel(Date.now(), false) });
  const sent: unknown[] = [];
  serve('/tools/sandbox.extend', (_, input) => {
    sent.push(input);
    return { status: 502, body: { error: { code: 'upstream', message: 'Bad gateway' } } };
  });
  await mount(page());
  await press(card('sandbox:sbx_h100'));
  const panels = reads('ui.running_panel');
  await press(button('Extend lease')!);
  assert.equal(sent.length, 1);
  assert.ok(!button('Retry same request'), 'a lost extension is not sent again as the same one');
  assert.ok(button('Extend lease'));
  assert.match($('#running-panel [role="alert"]')!.textContent!, /may already be extended/);
  assert.ok(reads('ui.running_panel') > panels, 'the lease is read again to say where it stands');
});

test('an operator reads names; a reader reads the words left for them, and a row of nothing goes', async (t) => {
  t.after(unmount);
  drawn();
  // The Work view's own wiring: the names are the session's, read by an operator only.
  const Named = () => under(useActorNames());
  const project = { id: 'project_1', name: 'Grokking', createdAt: '2026-09-01T00:00:00Z' };
  const open = async (role: string) => {
    const actor = { id: 'actor_me', projectId: project.id, name: 'Me', role };
    serve('/auth/config', { body: { enabled: false } });
    serve('/account', {
      body: { kind: 'actor', actor: { ...actor, active: true }, projects: [project] },
    });
    serve('/tools/ui.shell', { body: { result: { actor, project, rows: [], plugins: [] } } });
    serve('/tools/actor.list', {
      body: {
        result: [
          { id: 'actor_ana', projectId: project.id, name: 'Ana', role: 'reviewer', active: true },
        ],
      },
    });
    answers();
    await mount(
      createElement(
        MemoryRouter,
        { initialEntries: ['/work?key=work:wf_index'] },
        createElement(SessionProvider, null, createElement(Named)),
      ),
    );
    await settle(20);
  };
  await open('operator');
  assert.ok(text().includes('With Ana'), text().slice(0, 800));
  assert.ok(all('.running-section-title').some((item) => item.textContent === 'Details'));
  await unmount();
  await open('reader');
  assert.ok(!requests.includes('POST /tools/actor.list'), 'a reader never asks for names');
  assert.ok(text().includes('Claimed'));
  assert.ok(!text().includes('Ana'));
  assert.ok(!all('.running-facts dt').some((item) => item.textContent === 'Owner'));
  assert.ok(!all('.running-section-title').some((item) => item.textContent === 'Details'));
});

test('the stream pins what is running, says a run of one tool once, and marks a silence', async (t) => {
  t.after(unmount);
  const [calls] = sessionPanel(Date.parse('2026-09-25T12:00:00Z')).sections;
  assert.equal(calls!.kind, 'stream');
  const rows = streamRows(calls!.kind === 'stream' ? calls!.items : []);
  assert.deepEqual(
    rows.map((row) =>
      row.kind === 'call'
        ? `${row.call} ${row.state} ×${row.times}`
        : row.kind === 'gap'
          ? `gap ${Math.round(row.ms / 60_000)}m`
          : 'mark',
    ),
    [
      'sandbox.exec running ×1',
      'artifact.read succeeded ×3',
      'gap 10m',
      'code.commit failed ×1',
      'mark',
    ],
  );
  drawn();
  answers();
  await mount(page());
  await press(card('session:session_ablate'));
  const stream = $('.running-stream')!;
  assert.ok(stream.textContent!.includes('×3'));
  assert.ok(stream.textContent!.includes('No call for 9m'));
  assert.ok(stream.textContent!.includes('failed'));
  assert.equal(
    stream.querySelector('.running-attn'),
    null,
    'a failed call is the agent’s, not red',
  );
  // Every row has its time; a duration under a second is not drawn.
  assert.equal(stream.querySelectorAll('li').length, stream.querySelectorAll('time').length + 1);
  assert.ok(!stream.textContent!.includes('0s'));
  assert.ok(text().includes('6 of 19'));
});

test('no identifier is ever printed, on the map or in any sidebar', async (t) => {
  t.after(unmount);
  drawn();
  answers();
  await mount(page());
  const ids = /(wf|session|sbx|flt|art)_[A-Za-z0-9]/;
  assert.doesNotMatch(text(), ids);
  for (const item of all('.wmap-node')) assert.doesNotMatch(item.getAttribute('aria-label')!, ids);
  for (const key of ['work:wf_index', 'session:session_ablate', 'sandbox:sbx_h100']) {
    await press(card(key));
    assert.doesNotMatch(text(), ids, `the ${key} sidebar prints an id`);
  }
});

test('machine text prints an id inside it by its head and its tail, and titles and copies all of it', async (t) => {
  t.after(unmount);
  drawn();
  let copied = '';
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (value: string) => void (copied = value) },
  });
  t.after(() => Reflect.deleteProperty(navigator, 'clipboard'));
  const hex = '0123456789abcdef0123456789abcdef';
  const branch = `merv/work/wf_${hex}`;
  assert.equal(monoText(branch), 'merv/work/wf_01234567…abcdef');
  assert.equal(monoText(`HEAD ${'F'.repeat(40)}`), `HEAD FFFFFFFF…FFFFFF`);
  // Fewer than 24 hex digits, and words, are machine text as sent.
  for (const as of ['a'.repeat(23), 'python sweep.py --k 16', 'code.commit'])
    assert.equal(monoText(as), as);
  const now = Date.now();
  const task = taskPanel(now);
  const code = task.sections.find((section) => section.title === 'Code')!;
  if (code.kind === 'facts') code.rows[0] = { label: 'Branch', value: [{ mono: branch }] };
  answers(board(now), { 'work:wf_index': task });
  await mount(page());
  // Short machine text on an agent's line is printed as it came, with nothing in its title.
  const tool = card('session:session_index').querySelector<HTMLElement>('.mono')!;
  assert.equal(tool.textContent, 'code.commit');
  assert.equal(tool.getAttribute('title'), null);
  await press(card('work:wf_index'));
  const row = all('.running-facts .kv-row').find(
    (item) => item.querySelector('dt')?.textContent === 'Branch',
  )!;
  const shown = row.querySelector<HTMLElement>('.mono')!;
  assert.equal(shown.textContent, 'merv/work/wf_01234567…abcdef');
  assert.equal(shown.getAttribute('title'), branch);
  assert.ok(!text().includes(hex));
  await press(row.querySelector('button[aria-label="Copy"]')!);
  assert.equal(copied, branch, 'the copy is the branch an operator fetches, whole');
});

test('a card is named by what it draws, and one that needs a person says what in its name', async (t) => {
  t.after(unmount);
  drawn();
  answers();
  await mount(page());
  const named = (key: string) => card(key).getAttribute('aria-label')!;
  assert.equal(
    named('work:wf_table'),
    'Task, Sensitivity table, Waiting on a person to merge the pull request, Code check',
  );
  assert.equal(
    named('work:wf_index'),
    'Task, Rebuild citation index, Producer on it, Rebuild citation index',
  );
  assert.equal(
    named('work:wf_review'),
    'Task, Review citation index, Waits on Rebuild citation index',
  );
  // Its clocks are left out, so the name of a card in hand holds still while they tick.
  assert.equal(
    named('work:wf_ablate'),
    'Experiment, Ablate retrieval depth, running, Ablate retrieval depth, GPU run',
  );
  for (const item of all('.wmap-node'))
    assert.doesNotMatch(item.getAttribute('aria-label')!, /\d+[smhd]\b|\bago\b|\bleft\b/);
});

test('the keyboard walks the cards in reading order, and straight down a chain', async (t) => {
  t.after(unmount);
  drawn(1600);
  answers();
  await mount(page());
  const graph = $('.wmap')!;
  assert.equal(graph.getAttribute('role'), 'group');
  assert.equal(graph.tabIndex, 0);
  await key(graph, 'ArrowRight');
  const first = document.activeElement as HTMLElement;
  assert.equal(first.dataset.key, 'work:wf_table');
  await key(first, 'j');
  assert.equal((document.activeElement as HTMLElement).dataset.key, 'work:wf_index');
  await key(document.activeElement!, 'ArrowDown');
  assert.equal((document.activeElement as HTMLElement).dataset.key, 'work:wf_review');
  await key(document.activeElement!, 'ArrowUp');
  assert.equal((document.activeElement as HTMLElement).dataset.key, 'work:wf_index');
});

test('on a phone the sidebar takes the page’s place, and closing it brings the page back on its line', async (t) => {
  t.after(unmount);
  listed();
  await resize(false);
  answers();
  await mount(page());
  const row = card('sandbox:sbx_h100');
  await press(row);
  assert.equal($('.work-main')!.hidden, true);
  assert.equal($('#running-panel')!.hidden, false);
  assert.ok(text().includes('aurora-sweep'));
  await key($('#running-panel-title')!, 'Escape');
  assert.equal($('.work-main')!.hidden, false);
  assert.equal($('#running-panel')!.hidden, true);
  assert.equal(document.activeElement, card('sandbox:sbx_h100'));
});

test('with nothing on the board nothing is said; a lane that did not load or went stale says so, naming no plugin', async (t) => {
  t.after(unmount);
  drawn();
  answers(emptyBoard());
  await mount(page());
  assert.equal($('.live-head'), null);
  assert.equal(all('.wmap-node').length, 0);
  assert.equal(text(), '');
  await unmount();
  drawn();
  const given = board();
  given.lanes.hardware.failed = ['sandboxes'];
  given.lanes.hardware.asOf = new Date(Date.now() - 120_000).toISOString();
  answers(given);
  await mount(page());
  const notes = all('.running-note');
  assert.deepEqual(
    notes.map((note) => note.textContent),
    ['Could not load everything.', 'Could not refresh. Showing the state that loaded 2m ago.'],
  );
  assert.ok(notes.every((note) => note.getAttribute('role') === 'status'));
  assert.ok(notes[0]!.classList.contains('error-message'));
  assert.ok(!text().includes('sandboxes'));
});

test('every control reads from the verb table, and a machine without a heartbeat is offline, never quiet', () => {
  const table = readFileSync(new URL('../docs/UI_DESIGN.md', import.meta.url), 'utf8');
  const verbs = table.slice(table.indexOf('## Verbs'), table.indexOf('## Remote rows'));
  const objects = new Set(
    verbs
      .split('\n')
      .filter((line) => /^\| [A-Z][a-z]+ +\|/.test(line))
      .flatMap((line) =>
        line
          .split('|')[3]!
          .split('·')
          .map((object) => object.trim()),
      ),
  );
  const now = Date.now();
  const labels = [
    ...board(now).lanes.sessions.summaries.flatMap((summary) => summary.actions),
    ...[taskPanel(now), sessionPanel(now), sandboxPanel(now)].flatMap((panel) => panel.actions),
  ].map((action) => action.label);
  for (const label of labels) assert.ok(objects.has(label), `${label} is not in the verb table`);
  // Quiet is a lease that has made no call; a machine that stopped reporting is offline.
  assert.equal(runnerLiveness({ live: false }, now)?.verdict, 'offline');
  const machines = [...board(now).lanes.hardware.nodes, board(now).lanes.sessions.nodes[3]!];
  assert.doesNotMatch(JSON.stringify(machines), /[Qq]uiet/);
});

test('a wide wave is worked out in well under a frame: what each unit reaches is found once', () => {
  // 400 tasks, each waiting on up to three earlier ones, as a research wave grows.
  const ids = Array.from({ length: 400 }, (_, index) => `t${index}`);
  const items = ids.map((id, index) => ({
    id,
    kind: 'tasks',
    name: id,
    flow: { state: 'planned', updatedAt: '' },
    at: String(index).padStart(4, '0'),
    held: true,
  }));
  const edges = ids.flatMap((id, index) =>
    [1, 2, 5]
      .filter((back) => index - back >= 0)
      .map((back) => ({ from: ids[index - back]!, to: id, waiting: true })),
  );
  const started = performance.now();
  const map = mapOf(undefined, { items, edges });
  const took = performance.now() - started;
  // Each task's line from two back is said through the one before it; five back, likewise.
  assert.equal(map.edges.length, 399);
  assert.ok(took < 100, `the map took ${took.toFixed(0)} ms`);
});

test('who is on each card is looked up from one index of the board', () => {
  const given = board(Date.now());
  const keys = given.lanes.work.nodes.map((node) => node.key);
  const lookup = liveLookup(given);
  for (const key of keys)
    assert.deepEqual(
      lookup(key).map((node) => node.key),
      liveOf(given, key).map((node) => node.key),
    );
  assert.deepEqual(liveLookup(undefined)('work:wf_index'), []);
});
