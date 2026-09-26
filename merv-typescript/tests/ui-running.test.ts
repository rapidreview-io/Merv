/**
 * The Running page, rendered from what the owners will send. Each test states one thing it
 * must never do: cover the board with its sidebar, lose the thing in hand on a poll, colour
 * anything red that no person has to act on, act on a control before naming what it ends,
 * print an identifier, or leave a reader looking at a heading over nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mount, requests, resize, serve, settle, text, unmount } from './ui-render.js';
import { board, emptyBoard, sandboxPanel, sessionPanel, taskPanel } from './ui-running-fixtures.js';

sessionStorage.setItem('merv:token', 'fixture-token');
const { createElement, useEffect } = await import('react');
const { MemoryRouter, useLocation, useNavigationType } = await import('react-router-dom');
const { act } = await import('react-dom/test-utils');
// components.tsx first: it and list-filters.tsx import each other through a view, and
// only this order has every module evaluated before another one calls into it.
await import('../packages/ui/web/components.js');
const { RunningPage, RunningView, cadenceOf, nodeName } =
  await import('../packages/ui/web/views/running.js');
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
/** The board's column narrowed or widened, as the sidebar opening beside it does. */
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
const page = (at = '/running', nameOf: (id: string) => string | undefined = () => undefined) =>
  createElement(
    MemoryRouter,
    { initialEntries: [at] },
    createElement(Probe),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createElement(RunningPage as any, { nameOf }),
  );

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
/** The page's own stylesheet, which jsdom cascades by specificity; taken away after the test. */
const styled = () => {
  const sheet = document.createElement('style');
  sheet.textContent = readFileSync(
    new URL('../packages/ui/web/styles.css', import.meta.url),
    'utf8',
  );
  document.head.appendChild(sheet);
  return () => sheet.remove();
};

test('three bands say what each holds, and what needs a person is counted beside it in red', async (t) => {
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
  const headings = all('.running-band-title').map((item) => item.textContent);
  assert.deepEqual(headings, ['Work 5 · 1 needs you', 'Sessions 4', 'Hardware 4 · 1 needs you']);
  // Red beside a heading only above zero; a quiet line is ink, and needs nobody.
  assert.equal(all('.running-needs').length, 2);
  assert.ok(!card('session:session_ablate').classList.contains('running-attn'));
  assert.ok(text().includes('Launch failed 2 times, retrying'));
  // The Sessions line carries dispatch and its one control, which never wears the accent.
  const pause = button('Pause dispatch')!;
  assert.ok(pause && !pause.classList.contains('btn--primary'));
  assert.ok(text().includes('Dispatch running · Machines 2 · Free slots 1'));
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
  const line = $('[data-lane="sessions"] .running-lane-attn')!;
  assert.ok(line, 'the red clause stands under the heading');
  assert.equal(line.closest('.running-summary'), null, 'not squeezed into the heading’s line');
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

test('a lane whose source has never answered reads a dash and grey cells, and the board asks again soon', async (t) => {
  t.after(unmount);
  drawn();
  const given = board();
  given.lanes.hardware = { nodes: [], summaries: [], needsYou: 0, failed: [], pending: true };
  answers(given);
  await mount(page());
  assert.equal(all('.running-band-title').at(-1)!.textContent, 'Hardware —');
  assert.equal(all('.running-ghost').length, 3);
  assert.ok(!text().includes('Nothing is running'));
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

test('without the room to draw, each band is a list and every relation is said in words', async (t) => {
  t.after(unmount);
  listed();
  answers();
  await mount(page());
  assert.equal(all('.running-node').length, 0);
  assert.equal($('svg.running-links'), null);
  assert.equal(all('.running-row').length, 13);
  for (const said of [
    'waits on Rebuild citation index',
    'works on Rebuild citation index',
    'runs for Ablate retrieval depth',
    'checks Sensitivity table',
    'rented for Draft section 3.2',
  ])
    assert.ok(text().includes(said), `${said} is not on the page: ${text().slice(0, 600)}`);
});

test('a row’s relations are part of its name, and a prerequisite already settled is not waited on', async (t) => {
  t.after(unmount);
  listed();
  const given = board();
  given.edges.push({
    from: 'work:wf_draft',
    to: 'work:wf_index',
    verb: 'waits on',
    waiting: false,
  });
  answers(given);
  await mount(page());
  const named = (key: string) => card(key).getAttribute('aria-label')!;
  assert.match(named('session:session_index'), /, works on Rebuild citation index$/);
  assert.match(named('check:base_7a1e'), /, checks Sensitivity table$/);
  // Every word said under a row is in the name it is heard by.
  for (const row of all('.running-row'))
    for (const said of row.querySelectorAll('.running-relations > span'))
      assert.ok(row.getAttribute('aria-label')!.includes(said.textContent!), said.textContent!);
  const draft = card('work:wf_draft');
  assert.ok(draft.textContent!.includes('waits on Ablate retrieval depth'));
  assert.ok(!draft.textContent!.includes('waits on Rebuild citation index'));
  assert.ok(!named('work:wf_draft').includes('waits on Rebuild citation index'));
});

test('measured, the cards stand on the drawing, and the lines between bands wait for a card in hand', async (t) => {
  t.after(unmount);
  drawn(1200);
  answers();
  await mount(page());
  const cards = all('.running-node');
  assert.equal(cards.length, 13);
  for (const item of cards)
    assert.match(item.getAttribute('style') ?? '', /left: \d+px; top: \d+px/);
  const svg = $('svg.running-links')!;
  assert.equal(svg.getAttribute('aria-hidden'), 'true');
  assert.equal(svg.getAttribute('width'), '1200');
  // The prerequisites are always drawn; the relations between bands are not, until one is lit.
  assert.equal(all('.running-wait').length, 2);
  assert.equal(all('.running-link').length, 0);
  assert.ok(all('.running-port').length > 0);
  // Pointing at a card lights its relations while nothing is in hand.
  await act(async () => {
    card('compute:c0ffee').dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  });
  assert.ok(all('.running-link.on').length > 0);
});

test('pressing a card puts it in the address, docks its sidebar beside the board, and lights what it relates to', async (t) => {
  t.after(unmount);
  drawn(1200);
  answers();
  await mount(page());
  await press(card('work:wf_index'));
  assert.equal(where, '/running?key=work:wf_index');
  assert.equal(how, 'PUSH', 'opening a sidebar is a step Back can undo');
  assert.deepEqual(asked, ['work:wf_index']);
  assert.equal($('.running-plane')!.hasAttribute('data-open'), true);
  assert.equal($('#running-panel')!.hidden, false);
  assert.equal($('.running-board')!.hidden, false, 'the board is never covered or hidden here');
  assert.equal(document.activeElement, $('#running-panel-title'));
  assert.equal(card('work:wf_index').getAttribute('aria-pressed'), 'true');
  // What it relates to stays; what it does not steps back, unless it needs a person.
  assert.ok(!card('session:session_index').classList.contains('dim'));
  assert.ok(!card('work:wf_review').classList.contains('dim'));
  assert.ok(card('work:wf_ablate').classList.contains('dim'));
  assert.ok(card('sandbox:sbx_a10').classList.contains('dim'));
  assert.ok(
    !card('work:wf_table').classList.contains('dim'),
    'a card that needs a person never dims',
  );
  assert.equal(all('.running-link').length, 1);
  // The sidebar narrows the board's column, and the drawing lays itself out again for it.
  await measure(760);
  assert.equal($('svg.running-links')!.getAttribute('width'), '760');
  const right = Math.max(
    ...all('.running-node').map(
      (item) => item.offsetLeft + parseFloat(item.style.left) + parseFloat(item.style.width),
    ),
  );
  assert.ok(right <= 760, 'no card stands under the sidebar');
  // A poll keeps the thing in hand.
  await act(async () => {
    const { refreshTools } = await import('../packages/ui/web/api.js');
    refreshTools('ui.running');
  });
  await settle(0);
  assert.equal(where, '/running?key=work:wf_index');
  assert.equal(card('work:wf_index').getAttribute('aria-pressed'), 'true');
});

test('an address naming a card another absorbed opens that card, in place of the address', async (t) => {
  t.after(unmount);
  drawn();
  answers();
  await mount(page('/running?key=fleet:flt_bound'));
  await settle(0);
  assert.equal(where, '/running?key=session:session_ablate');
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
  await mount(page('/running?key=session:session_closed'));
  assert.ok(text().includes('Released · completed'));
  await unmount();
  answers();
  await mount(page('/running?key=session:session_gone'));
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
  assert.equal(where, '/running?key=sandbox:sbx_a10', 'the sidebar stays open');
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
  assert.equal(where, '/running?key=session:session_ablate', 'and the sidebar did not');
  await key($('#running-panel-title')!, 'Escape');
  assert.equal(where, '/running');
  assert.equal($('#running-panel')!.hidden, true);
  assert.equal(document.activeElement, card('session:session_ablate'));
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
  assert.equal(where, '/running?key=work:wf_review');
  assert.equal(how, 'REPLACE', 'swapping inside an open sidebar adds nothing to history');
  assert.equal(card('work:wf_review').getAttribute('aria-pressed'), 'true');
  await press($('.running-close')!);
  assert.equal(where, '/running');
  assert.equal(how, 'POP', 'Close takes back the one step the opening added');
  assert.equal(document.activeElement, card('work:wf_review'));
});

test('red is only what a person has to do: a card, a row, a line — and never a clock of itself', async (t) => {
  t.after(unmount);
  drawn();
  answers();
  await mount(page());
  const red = all('.running-node.running-attn').map((item) => item.dataset.key);
  assert.deepEqual(red.sort(), ['sandbox:sbx_h100', 'session:session_ablate', 'work:wf_table']);
  assert.deepEqual(
    all('.running-dot--attn')
      .map((item) => item.closest<HTMLElement>('[data-key]')!.dataset.key)
      .sort(),
    red.sort(),
  );
  // The held task keeps the word Done under the line that says why a person is needed.
  assert.match(
    card('work:wf_table').textContent!,
    /Waiting on a person to merge the pull request.*Done/,
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

test('an ending card steps back in faint ink, except for the red line saying what a person must do', async (t) => {
  t.after(unmount);
  t.after(styled());
  for (const draw of [() => drawn(), listed]) {
    draw();
    answers();
    await mount(page());
    const held = card('work:wf_table');
    assert.ok(held.classList.contains('running-look--quiet'));
    const red = held.querySelector<HTMLElement>('.running-line.running-attn')!;
    assert.equal(getComputedStyle(red).color, 'var(--refutes)');
    const done = held.querySelector<HTMLElement>('.running-line--second')!;
    assert.equal(getComputedStyle(done).color, 'var(--faint)');
    await unmount();
  }
});

test('a quiet line is ink wherever it stands: on a card, on an ending card, in a sidebar’s head and under a band', async (t) => {
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
  assert.equal(all('.running-needs').length, 1, 'only the hardware band needs anyone');
  for (const key of ['session:session_ablate', 'work:wf_table']) {
    const held = card(key);
    assert.ok(!held.classList.contains('running-attn'), key);
    assert.equal(held.querySelector('.running-attn, .running-dot--attn'), null, key);
  }
  const line = (key: string) => card(key).querySelector<HTMLElement>('.running-line')!;
  assert.equal(line('session:session_ablate').textContent, quiet.says[0]);
  assert.equal(getComputedStyle(line('session:session_ablate')).color, 'var(--muted)');
  // An ending card steps back, and its quiet line with it.
  assert.equal(getComputedStyle(line('work:wf_table')).color, 'var(--faint)');
  const lane = $('[data-lane="sessions"] .running-lane-attn')!;
  assert.equal(lane.textContent, 'Dispatch waiting');
  assert.equal(lane.querySelector('.running-attn'), null);
  await press(card('session:session_ablate'));
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
  assert.equal(status().textContent, 'active for · on mac-studio');
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

test('an operator reads names; a reader reads the words left for them, and a row of nothing goes', async (t) => {
  t.after(unmount);
  drawn();
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
        { initialEntries: ['/running?key=work:wf_index'] },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createElement(SessionProvider, null, createElement(RunningView as any, {})),
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

test('no identifier is ever printed, on the board or in any sidebar', async (t) => {
  t.after(unmount);
  drawn();
  answers();
  await mount(page());
  const ids = /(wf|session|sbx|flt|art)_[A-Za-z0-9]/;
  assert.doesNotMatch(text(), ids);
  for (const item of all('.running-node'))
    assert.doesNotMatch(item.getAttribute('aria-label')!, ids);
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
  // Short machine text on a card is printed as it came, with nothing in its title.
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
  assert.match(
    named('session:session_ablate'),
    /^Ablate retrieval depth, Quiet 34m, on a Fleet VM$/,
  );
  assert.match(named('sandbox:sbx_h100'), /^8× H100, aurora-sweep, Lease 6m 0s left, \$32\.40\/h$/);
  assert.equal(
    named('work:wf_review'),
    'Task, Review citation index, Waits on Rebuild citation index',
  );
  assert.equal(card('sandbox:sbx_h100').title, 'aurora-sweep');
  const reading = { now: { at: Date.now(), since: 0, stale: false }, nameOf: () => undefined };
  assert.ok(nodeName(board().lanes.work.nodes[0]!, reading).includes('merge the pull request'));
});

test('the keyboard walks the cards in reading order and down through the bands', async (t) => {
  t.after(unmount);
  drawn(1600);
  answers();
  await mount(page());
  const graph = $('.running-graph')!;
  assert.equal(graph.getAttribute('role'), 'group');
  assert.equal(graph.tabIndex, 0);
  await key(graph, 'ArrowRight');
  const first = document.activeElement as HTMLElement;
  assert.equal(first.dataset.key, 'work:wf_table');
  await key(first, 'j');
  assert.equal((document.activeElement as HTMLElement).dataset.key, 'work:wf_index');
  await key(document.activeElement!, 'ArrowDown');
  assert.equal((document.activeElement as HTMLElement).dataset.key, 'session:session_index');
  await key(document.activeElement!, 'ArrowUp');
  assert.equal((document.activeElement as HTMLElement).dataset.key, 'work:wf_index');
});

test('on a phone the sidebar takes the list’s place, and closing it brings the list back on its row', async (t) => {
  t.after(unmount);
  listed();
  await resize(false);
  answers();
  await mount(page());
  const row = card('sandbox:sbx_h100');
  await press(row);
  assert.equal($('.running-board')!.hidden, true);
  assert.equal($('#running-panel')!.hidden, false);
  assert.ok(text().includes('aurora-sweep'));
  await key($('#running-panel-title')!, 'Escape');
  assert.equal($('.running-board')!.hidden, false);
  assert.equal($('#running-panel')!.hidden, true);
  assert.equal(document.activeElement, card('sandbox:sbx_h100'));
});

test('an empty board says nothing is running; a lane that did not load or went stale says so, naming no plugin', async (t) => {
  t.after(unmount);
  drawn();
  answers(emptyBoard());
  await mount(page());
  assert.ok(text().includes('Nothing is running'), text().slice(0, 300));
  assert.equal(all('.running-band-title').length, 0);
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
  assert.ok(!text().includes('Nothing is running'));
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
