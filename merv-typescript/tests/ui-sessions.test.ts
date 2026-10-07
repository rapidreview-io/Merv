/**
 * The Sessions page, rendered. Each test states one thing the page must never do:
 * blank a list that is still correct, call a lease lapsed on a clock its data
 * never saw, hide its own subject, or report a halt it cannot vouch for.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { click, jump, mount, requests, serve, settle, text, unmount } from './ui-render.js';
import { leaseLiveness, type LeaseFacts } from '@merv/sessions/liveness';

const { createElement, useState } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
const { act } = await import('react-dom/test-utils');
const { AgentsPage } = await import('../packages/ui/web/views/sessions.js');
const { setProject, setToken } = await import('../packages/ui/web/api.js');
const { leaseLiveness: drawn } = await import('../packages/ui/web/views/threads.js');
const { clock, clockOf } = await import('../packages/ui/web/liveness.js');

// Every test opens a fresh account scope, including the shared tool-result cache.
beforeEach(() => setToken('ui-sessions-fixture'));

const row = {
  id: 'sessions',
  label: 'Agents and machines',
  group: 'work',
  order: 24,
  path: '/sessions',
  view: { kind: 'sessions' },
  status: {},
  readable: true,
};
/** The lead row the page leads back to: without one, the way back is Home. */
const work = {
  ...row,
  id: 'work',
  label: 'Work',
  group: 'lead',
  path: '/work',
  view: { kind: 'work' },
};
const shell = { rows: [work, row], plugins: [] };
const page = () =>
  createElement(
    MemoryRouter,
    { initialEntries: ['/sessions'] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createElement(AgentsPage as any, { row, shell, me: 'actor_me' }),
  );

/** One project's status, timed from whatever the clock reads when it is asked. */
function status(over: Record<string, unknown> = {}) {
  const now = Date.now();
  const at = (ms: number) => new Date(now + ms).toISOString();
  return worded({
    observedAt: at(0),
    canManage: true,
    liveSessionCount: 1,
    sessionTotal: 1,
    runnerTotal: 3,
    dispatch: { enabled: true, updatedAt: at(-60_000), updatedBy: 'actor_other' },
    runners: [
      {
        id: 'runner_1',
        lastSeenAt: at(-5_000),
        live: true,
        capacity: 2,
        machine: { hostname: 'lab-01', system: 'Darwin', architecture: 'arm64' },
        platforms: [{ name: 'codex', harness: 'codex', enabled: true, parallelism: 2 }],
        desiredVersion: 1,
        appliedVersion: 1,
        lastDecision: 'capacity_full',
        lastDecisionAt: at(-120_000),
      },
    ],
    sessions: [
      {
        id: 'sess_1',
        threadId: 'agent_1',
        instanceId: 'wf_1',
        expectedRevision: 3,
        label: 'Work: Sweep weight decay',
        name: 'Sweep weight decay',
        role: 'producer',
        status: 'active',
        runnerRef: 'runner_1',
        hostRef: null,
        platform: null,
        createdAt: at(-600_000),
        activatedAt: at(-540_000),
        expiresAt: at(60_000),
        closedAt: null,
        closeReason: null,
        workspaceMode: 'none',
      },
    ],
    queue: [],
    queueTotal: 0,
    ...over,
  });
}
/** Each lease worded as Sessions words it, at the moment the read was observed. */
const worded = <T extends { observedAt: string; sessions: unknown }>(read: T): T => ({
  ...read,
  sessions: (read.sessions as LeaseFacts[]).map((lease) => ({
    ...lease,
    liveness: leaseLiveness(lease, Date.parse(read.observedAt)),
  })),
});
const read = (over: Record<string, unknown> = {}) => ({ body: { result: status(over) } });
/** A thread of the project as Sessions lists it: the work it is on, its stage and its visits. */
const thread = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  instanceId: `wf_${id}`,
  state: 'running',
  role: 'producer',
  status: 'dormant',
  name,
  workflow: 'task',
  visits: [
    {
      sessionId: `ses_${id}`,
      status: 'released',
      offeredAt: new Date(Date.now() - 600_000).toISOString(),
      startedAt: new Date(Date.now() - 590_000).toISOString(),
      endedAt: new Date(Date.now() - 60_000).toISOString(),
      outcome: 'submitted',
      launched: true,
      resumed: false,
      runnerId: 'lab-01',
      hasConversation: true,
    },
  ],
  ...over,
});
const live = thread('agent_1', 'Sweep weight decay', {
  status: 'live',
  visits: [
    {
      sessionId: 'sess_1',
      status: 'active',
      offeredAt: new Date(Date.now() - 600_000).toISOString(),
      startedAt: new Date(Date.now() - 540_000).toISOString(),
      launched: true,
      resumed: false,
      runnerId: 'lab-01',
      hasConversation: true,
      liveness: { verdict: 'active', tone: 'ok', rest: [] },
    },
  ],
});
// Every page reads the project's threads; a test that opens no row only needs them there.
beforeEach(() => serve('/sessions/threads', { body: { threads: [live], next: null } }));

const fixed = Date.parse('2026-09-16T12:00:00.000Z');
const before = (seconds: number) => new Date(fixed - seconds * 1000).toISOString();
/** A lease as Sessions words it at `read`, drawn by the page on its clock `on`. */
const drawnAt = (
  lease: Partial<LeaseFacts>,
  on: number | ReturnType<typeof clock>,
  read = clockOf(on).at,
) =>
  drawn(
    {
      liveness: leaseLiveness(
        {
          createdAt: before(3600),
          activatedAt: null,
          expiresAt: before(-3600),
          ...lease,
        } as LeaseFacts,
        read,
      ),
    },
    clockOf(on),
  );

test('a lease states its behaviour, worded by Sessions and only drawn by the page', () => {
  const table: [Partial<LeaseFacts>, string][] = [
    [{ status: 'offered', createdAt: before(120) }, 'offered · not taken up · 2m'],
    [{ status: 'active', activatedAt: before(540), expiresAt: before(-3600) }, 'active · 9m'],
    // Past its expiry and not yet swept: behaviour, not the lifecycle word.
    [
      { status: 'active', activatedAt: before(9000), expiresAt: before(240) },
      'lapsed · lease ran out · 4m',
    ],
    // Its hard deadline ends it as surely as its expiry.
    [
      {
        status: 'active',
        activatedAt: before(9000),
        expiresAt: before(-60),
        hardDeadline: before(10),
      },
      'lapsed · lease ran out · 0s',
    ],
    [
      { status: 'released', closedAt: before(720), outcome: 'halted' },
      'released · halted · 12m ago',
    ],
    // An ending that says no more than the state word is not a second clause.
    [{ status: 'released', closedAt: before(720), outcome: 'released' }, 'released · 12m ago'],
    // The clock clause is dropped, not zeroed, when its stamp is missing.
    [{ status: 'expired', expiresAt: before(10_800) }, 'expired'],
  ];
  for (const [lease, phrase] of table)
    assert.equal(drawnAt(lease, fixed).phrase, phrase, JSON.stringify(lease));
  const tone = (lease: Partial<LeaseFacts>) => drawnAt(lease, fixed).tone;
  assert.equal(tone({ status: 'active', activatedAt: before(540), expiresAt: before(-60) }), 'ok');
  assert.equal(tone({ status: 'active', expiresAt: before(60) }), 'bad');
  assert.equal(tone({ status: 'released', closedAt: before(60) }), 'dim');
  assert.equal(tone({ status: 'offered', createdAt: before(60) }), 'warn');
});

test('a verdict is the read’s, and its clock cannot outrun the payload it was drawn from', () => {
  const observedAt = new Date(fixed - 240_000).toISOString();
  // The page has been open four minutes on a payload that is four minutes old.
  const stale = clock(observedAt, observedAt, fixed, 8_000);
  assert.equal(stale.stale, true);
  assert.equal(stale.since, 240_000);
  // Anchored to the server's own clock, so a browser 10 minutes fast changes nothing.
  assert.equal(clock(observedAt, observedAt, fixed + 600_000, 8_000).at - fixed, 600_000);
  // A lease that had 60s left when the payload was read is still active: no
  // heartbeat since then has been seen, and absence of news is not an expiry. Its
  // clock stops at the moment of that read.
  const lease: Partial<LeaseFacts> = {
    status: 'active',
    activatedAt: new Date(fixed - 900_000).toISOString(),
    expiresAt: new Date(fixed - 180_000).toISOString(),
  };
  assert.equal(drawnAt(lease, stale, fixed - 240_000).phrase, 'active · 11m');
  // The same lease read by a payload young enough to have seen the window close.
  const fresh = clock(new Date(fixed).toISOString(), new Date(fixed).toISOString(), fixed, 8_000);
  assert.equal(drawnAt(lease, fresh).phrase, 'lapsed · lease ran out · 3m');
});

test('the page states its subject without a click, in one liveness vocabulary', async (t) => {
  t.after(unmount);
  serve('/tools/ui.read', () => read());
  await mount(page());
  const shown = text();
  for (const fact of [
    'Dispatch',
    // How much a section holds stands beside its name: one runner of three, one lease, live.
    'Runners 1 of 3',
    'Leases 1 · 1 live',
    'Sweep weight decay',
    'lab-01',
    // The project's agents: Sessions' threads, the live one with the work it is on.
    'Agents 1 · 1 live',
    // The runner says why its last lease request got nothing.
    'declined',
    'capacity full',
  ])
    assert.ok(shown.includes(fact), `${fact} is not on the page: ${shown.slice(0, 800)}`);
  // What waits for an agent is on the Work page's map, and is not listed here a second time.
  assert.ok(!shown.includes('Ready to assign'));
  // The rail does not list this page: it is a step under Work, and says the way back.
  const links = () =>
    [...document.querySelectorAll('.sessions-ops > p a')].map((link) => [
      link.textContent,
      link.getAttribute('href'),
    ]);
  assert.deepEqual(links(), [['← Work', '/work']]);
  // Where Fleet serves, every machine it was asked for is one step further.
  await unmount();
  const fleet = { ...row, id: 'fleet', label: 'Fleet requests', path: '/fleet' };
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/sessions'] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createElement(AgentsPage as any, {
        row,
        shell: { ...shell, rows: [work, row, fleet] },
        me: 'x',
      }),
    ),
  );
  assert.deepEqual(links(), [
    ['← Work', '/work'],
    ['Fleet requests', '/fleet'],
  ]);
  assert.ok(!shown.includes('Operations'), 'the subject must not sit behind a fold');
  assert.ok(!shown.includes('Extend'), 'no control the system cannot honour');
});

test('state is carried by elements: a pill, one control, counts, and never a sentence', async (t) => {
  t.after(unmount);
  serve('/tools/ui.read', () =>
    read({
      dispatch: { enabled: false, updatedAt: null, updatedBy: null },
      runners: [],
      runnerTotal: 0,
      sessions: status().sessions,
      queue: [
        {
          instanceId: 'wf_2',
          expectedRevision: 0,
          label: 'Review: Check training configuration',
          role: 'reviewer',
          state: 'in_review',
        },
      ],
      queueTotal: 1,
    }),
  );
  await mount(page());
  const shown = text();
  // Paused is a pill, and the one control beside it says the state it will set.
  assert.ok(shown.includes('paused'), shown.slice(0, 400));
  const toggles = [...document.querySelectorAll('button')].filter((button) =>
    /dispatch/i.test(button.textContent ?? ''),
  );
  assert.deepEqual(
    toggles.map((button) => [button.textContent, button.classList.contains('btn--primary')]),
    [['Start dispatch', true]],
  );
  // Halting every lease is the secondary, guarded control, in the refusal's colour.
  assert.ok(document.querySelector('.act-danger > button')?.textContent === 'Halt all leases');
  // An empty section is its name and a zero.
  assert.ok(shown.includes('Runners 0'), shown.slice(0, 400));
  // A lease reads as its record's name; the purpose its agent is told is the role's to say.
  assert.ok(shown.includes('Sweep weight decay'), shown);
  for (const gone of [
    'Work: ',
    'Review: ',
    'Agent’s move',
    'Your move',
    'No runner',
    'eligible for this identity',
    'this project has offered',
    'Revision',
  ])
    assert.ok(!shown.includes(gone), `“${gone}” is still on the page: ${shown.slice(0, 900)}`);
});

test('running dispatch offers a pause that is not dressed as the primary', async (t) => {
  t.after(unmount);
  serve('/tools/ui.read', () => read());
  await mount(page());
  assert.ok(text().includes('running'), text().slice(0, 300));
  const pause = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Pause dispatch',
  );
  assert.ok(pause && !pause.classList.contains('btn--primary'));
  assert.ok(!text().includes('Start dispatch'));
});

test('dispatch switched on with no live runner reads as waiting, never as running', async (t) => {
  t.after(unmount);
  const queue = [
    {
      instanceId: 'wf_2',
      expectedRevision: 0,
      label: 'Work: Check training configuration',
      role: 'producer',
      state: 'in_progress',
    },
  ];
  serve('/tools/ui.read', () =>
    read({ runners: [{ ...status().runners[0], live: false }], queue, queueTotal: 1 }),
  );
  await mount(page());
  const pill = document.querySelector('.dispatch .status')!;
  assert.equal(pill.textContent, 'waiting');
  assert.ok(pill.classList.contains('status--warn'));
});

test('leases open on what is live or recent; the older history is one control away', async (t) => {
  t.after(unmount);
  const now = Date.now();
  const at = (ms: number) => new Date(now + ms).toISOString();
  const ended = (id: string, name: string, closed: number) => ({
    ...status().sessions[0],
    id,
    name,
    status: 'released',
    closeReason: 'host_failed',
    createdAt: at(closed - 600_000),
    activatedAt: at(closed - 540_000),
    expiresAt: at(closed),
    closedAt: at(closed),
  });
  const sessions = [
    status().sessions[0],
    ended('sess_2', 'Recent run', -3_600_000),
    ended('sess_3', 'Week-old run', -7 * 24 * 3_600_000),
    ended('sess_4', 'Older run', -8 * 24 * 3_600_000),
  ];
  serve('/tools/ui.read', () => read({ sessions, sessionTotal: 4 }));
  await mount(page());
  const leases = () => document.querySelector('.lease-list')?.textContent ?? '';
  assert.ok(leases().includes('Sweep weight decay'), leases());
  assert.ok(leases().includes('Recent run'), leases());
  assert.ok(!leases().includes('Week-old run'), `history is not the page: ${leases()}`);
  assert.ok(!leases().includes('Older run'), leases());
  // The heading still counts every lease the read holds.
  assert.ok(text().includes('Leases 4 · 1 live'), text().slice(0, 600));
  await click('Show all 4');
  assert.ok(leases().includes('Week-old run'), leases());
  assert.ok(leases().includes('Older run'), leases());
  assert.ok(!text().includes('Show all'), 'nothing is left to show');
});

test('a lease opens on the row that lists its workflow, without reading any owner list', async (t) => {
  t.after(unmount);
  const lease = status().sessions[0];
  const sessions = [
    { ...lease, id: 'sess_t', name: 'A task', instanceId: 'wf_t', workflow: 'task' },
    { ...lease, id: 'sess_r', name: 'A wave', instanceId: 'wf_r', workflow: 'reflection' },
    { ...lease, id: 'sess_l', name: 'A lens', instanceId: 'wf_l', workflow: 'reflection.lens' },
    { ...lease, id: 'sess_x', name: 'Unlisted', instanceId: 'wf_x', workflow: 'research' },
    { ...lease, id: 'sess_o', name: 'Older lease', instanceId: 'wf_o' },
  ];
  const listing = (id: string, workflow: string, kind: string, holds?: string[]) => ({
    ...row,
    id,
    path: `/${id}`,
    group: 'hidden',
    workflow,
    ...(holds && { holds }),
    view: { kind },
  });
  const rows = [
    work,
    row,
    listing('tasks', 'task', 'tasks'),
    listing('reflections', 'reflection', 'reflections', ['reflection.lens']),
  ];
  serve('/tools/ui.read', () => read({ sessions, sessionTotal: 5, liveSessionCount: 5 }));
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/sessions'] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createElement(AgentsPage as any, { row, shell: { ...shell, rows }, me: 'actor_me' }),
    ),
  );
  const linkOf = async (name: string) => {
    const toggle = [...document.querySelectorAll<HTMLButtonElement>('.lease-row')].find((button) =>
      button.textContent?.includes(name),
    )!;
    await act(async () => toggle.click());
    const link = document.querySelector('.lease-panel a');
    const href = link?.getAttribute('href') ?? null;
    await act(async () => toggle.click());
    return href;
  };
  assert.equal(await linkOf('A task'), '/tasks/wf_t');
  assert.equal(await linkOf('A wave'), '/reflections/wf_r');
  // A lens has no row of its own: it opens on the row that declares it holds lenses.
  assert.equal(await linkOf('A lens'), '/reflections/wf_l');
  // A workflow no row lists, and a lease that names none, open nothing.
  assert.equal(await linkOf('Unlisted'), null);
  assert.equal(await linkOf('Older lease'), null);
  assert.ok(
    !requests.some((path) => /task\.list|experiment\.list/.test(path)),
    requests.join(', '),
  );
});

test('the Agents page lists threads, live first, and older ones a press further', async (t) => {
  t.after(unmount);
  serve('/tools/ui.read', () => read());
  serve('/sessions/threads', {
    body: { threads: [live, thread('agent_2', 'Check the config')], next: '7' },
  });
  serve('/sessions/threads?before=7', {
    body: { threads: [thread('agent_3', 'An older task')], next: null },
  });
  await mount(page());
  const names = () =>
    [...document.querySelectorAll('.unit-row--thread .unit-row-name')].map((n) => n.textContent);
  assert.deepEqual(names(), ['Sweep weight decay', 'Check the config']);
  assert.ok(text().includes('Agents 2+ · 1 live'), text());
  await click('Show older');
  assert.deepEqual(names(), ['Sweep weight decay', 'Check the config', 'An older task']);
  assert.equal(
    [...document.querySelectorAll('button')].find((item) => item.textContent === 'Show older'),
    undefined,
  );
  // One read of the threads, none of a whole agent history.
  assert.ok(!requests.some((request) => request.includes('/sessions/agents/')));
});

test('a thread row opens the thread view: a failed visit shows its outcome and exit reason', async (t) => {
  t.after(unmount);
  // jsdom has the element but not its modal methods.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Dialog = (window as any).HTMLDialogElement.prototype;
  Dialog.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  serve('/tools/ui.read', () => read());
  const crashed = thread('agent_2', 'Check the config', {
    status: 'retired',
    visits: [
      {
        ...thread('x', 'x').visits[0],
        outcome: 'crash_loop',
        why: 'local_process_exit_code_7',
      },
    ],
  });
  serve('/sessions/threads', { body: { threads: [crashed], next: null } });
  serve('/sessions/threads/agent_2/calls', {
    body: {
      threadId: 'agent_2',
      calls: [],
      totals: { calls: 0, completed: 0, inputTokens: 0, outputTokens: 0 },
    },
  });
  await mount(page());
  await act(async () => document.querySelector<HTMLButtonElement>('.unit-row--thread')!.click());
  await settle(20);
  const dialog = document.querySelector('dialog')!;
  assert.equal(dialog.querySelector('h2')!.textContent, 'Producer · running · retired');
  assert.ok(dialog.textContent!.includes('Check the config'));
  assert.match(dialog.querySelector('.ruled-row')!.textContent!, /crash loop · exit 7/);
  // Its calls are the view's other tab.
  const calls = [...dialog.querySelectorAll('button')].find(
    (item) => item.textContent === 'Calls',
  )!;
  await act(async () => calls.click());
  await settle(20);
  assert.ok(requests.includes('GET /sessions/threads/agent_2/calls'));
  assert.match(dialog.textContent!, /0 calls/);
});

test('a clock that jumps cannot lapse a lease the read never saw', async (t) => {
  t.after(unmount);
  serve('/tools/ui.read', (call) => (call === 1 ? read() : { network: true }));
  await mount(page());
  assert.ok(text().includes('active'), text().slice(0, 400));
  // Two minutes pass with no new payload: the lease's own window closes on the
  // browser's clock, and the server has not been asked whether it was renewed.
  await jump(120_000);
  const shown = text();
  assert.ok(!shown.includes('lapsed'), `a stale payload must not lapse a lease: ${shown}`);
  assert.ok(!shown.includes('ran out'), shown);
  assert.ok(shown.includes('as of'), `the countdown must state its age: ${shown}`);
});

test('a read that itself saw the window close says lapsed, and offers no halt', async (t) => {
  t.after(unmount);
  // The payload was measured after this lease's expiry: the server saw it close.
  const expiresAt = new Date(Date.now() - 5_000).toISOString();
  const lapsed = status({ sessions: [{ ...status().sessions[0], expiresAt }] });
  serve('/tools/ui.read', () => ({ body: { result: lapsed } }));
  await mount(page());
  assert.ok(text().includes('lapsed'), text().slice(0, 400));
  assert.ok(text().includes('lease ran out'), text().slice(0, 400));
  await click('Sweep weight decay');
  assert.ok(text().includes('Lease ran to'), text().slice(0, 800));
  assert.ok(!text().includes('Halt lease'), 'a lease the page calls lapsed offers no halt');
});

test('a failed poll degrades to one line and never blanks rows that are correct', async (t) => {
  t.after(unmount);
  serve('/tools/ui.read', (call) =>
    call === 1
      ? read()
      : { status: 500, body: { error: { code: 'server_error', message: 'Upstream failed' } } },
  );
  await mount(page());
  assert.ok(text().includes('Agents 1 · 1 live'));
  await settle(4_600);
  const shown = text();
  assert.ok(shown.includes('Could not refresh'), `the failure must be stated: ${shown}`);
  assert.ok(
    shown.includes('Agents 1 · 1 live'),
    `the rows that are still correct must stay: ${shown}`,
  );
  assert.ok(shown.includes('Sweep weight decay'), shown);
});

test('a halt whose answer never arrived says the result is unknown, in the guard', async (t) => {
  t.after(unmount);
  serve('/tools/ui.read', () => read());
  serve('/sessions/sess_1/halt', { network: true });
  await mount(page());
  await click('Sweep weight decay');
  await click('Halt lease');
  await click('Halt lease');
  const shown = text();
  assert.ok(
    shown.includes('The original result is still unknown'),
    `an unconfirmed halt must not read as a refusal: ${shown}`,
  );
  assert.ok(shown.includes('Retry halt'), shown);
  assert.ok(shown.includes('Halt this lease?'), 'the guard stays open for the retry');
});

test('a halt that closed nothing says so, and the guard stays open', async (t) => {
  t.after(unmount);
  serve('/tools/ui.read', () => read());
  serve('/sessions/sess_1/halt', { body: { halted: 0 } });
  await mount(page());
  await click('Sweep weight decay');
  await click('Halt lease');
  await click('Halt lease');
  const shown = text();
  assert.ok(shown.includes('Nothing was halted'), `a no-op halt must never read as one: ${shown}`);
  assert.ok(shown.includes('Halt this lease?'), 'the guard stays open to show the answer');
});

test('a dispatch toggle that changed nothing says so instead of flipping its label', async (t) => {
  t.after(unmount);
  serve('/tools/ui.read', () =>
    read({ dispatch: { enabled: false, updatedAt: null, updatedBy: null } }),
  );
  // Someone else enabled dispatch between this page's read and this click, so the
  // absolute state the button sent was already the state, and the server no-ops.
  serve('/sessions/dispatch', {
    body: {
      dispatch: {
        enabled: true,
        updatedAt: new Date(Date.now() - 30_000).toISOString(),
        updatedBy: 'actor_other',
      },
    },
  });
  await mount(page());
  await click('Start dispatch');
  assert.ok(text().includes('Dispatch was already on.'), text().slice(0, 600));
});

test('Fleet or own machines is chosen only where Fleet serves, by an admin, and sends only itself', async (t) => {
  t.after(unmount);
  const dispatch = { ...status().dispatch, ownMachines: false, fleet: true };
  const machines = () => document.querySelector('[aria-label="Machines"]');
  for (const over of [
    { dispatch: { ...dispatch, fleet: false } },
    { canManage: false, dispatch },
  ]) {
    serve('/tools/ui.read', () => read(over));
    await mount(page());
    assert.equal(machines(), null, JSON.stringify(over));
    await unmount();
  }
  let sent: unknown;
  serve('/tools/ui.read', () => read({ dispatch }));
  serve('/sessions/dispatch', (_call, body) => {
    sent = body;
    return { body: { dispatch: { ...dispatch, ownMachines: true, updatedBy: 'actor_other' } } };
  });
  await mount(page());
  assert.equal(machines()?.querySelector('[aria-pressed="true"]')?.textContent, 'Fleet');
  await click('Own machines');
  assert.deepEqual(sent, { ownMachines: true });
  assert.ok(!text().includes('already'), text().slice(0, 600));
});

test('halt-all names every live lease under the click, past this read’s window', async (t) => {
  t.after(unmount);
  serve('/tools/ui.read', () => read({ liveSessionCount: 240, sessionTotal: 400 }));
  await mount(page());
  await click('Halt all leases');
  const shown = text();
  assert.ok(shown.includes('Halt 240 live leases'), `the guard under-counted: ${shown}`);
  assert.ok(shown.includes('239 more'), shown);
  assert.ok(shown.includes('released back to the queue'), 'the guard promises no synchrony');
});
