/**
 * The Sessions page, rendered. Each test states one thing the page must never do:
 * blank a list that is still correct, call a lease lapsed on a clock its data
 * never saw, hide its own subject, or report a halt it cannot vouch for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { click, jump, mount, serve, settle, text, unmount } from './ui-render.js';

const { createElement } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
const { act } = await import('react-dom/test-utils');
const { AgentsPage } = await import('../packages/ui/web/views/sessions.js');

const row = {
  id: 'sessions',
  label: 'Sessions',
  group: 'work',
  order: 24,
  path: '/sessions',
  view: { kind: 'sessions' },
  status: {},
  readable: true,
};
const shell = { rows: [row], plugins: [] };
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
  return {
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
        agentId: 'agent_1',
        instanceId: 'wf_1',
        expectedRevision: 3,
        label: 'Sweep weight decay',
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
    agents: [
      {
        id: 'agent_1',
        sessionId: 'agent_session_1',
        actorId: 'actor_worker',
        name: 'Weight-decay researcher',
        status: 'active',
        contextEpoch: 1,
        persistent: false,
        currentExecutionId: 'sess_1',
        currentAssignment: { label: 'Sweep weight decay', role: 'producer' },
        createdAt: at(-3_600_000),
        runnerId: 'local-demo',
      },
    ],
    queue: [],
    queueTotal: 0,
    ...over,
  };
}
const read = (over: Record<string, unknown> = {}) => ({ body: { result: status(over) } });

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
    'Weight-decay researcher',
    // The runner says why its last lease request got nothing.
    'declined',
    'capacity full',
    'Ready to assign 0',
  ])
    assert.ok(shown.includes(fact), `${fact} is not on the page: ${shown.slice(0, 800)}`);
  // The queue names whose eligibility it reports, not a fleet backlog, where a pointer asks.
  assert.ok(document.querySelector('h2[title="Eligible for this identity"]'));
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
      sessions: [{ ...status().sessions[0], label: 'Work: Sweep weight decay' }],
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
  assert.ok(shown.includes('Ready to assign 1'), shown.slice(0, 600));
  // The purpose a lease is labelled with for its agent is dropped: the role says it.
  assert.ok(shown.includes('Check training configuration'), shown);
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
  const ended = (id: string, label: string, closed: number) => ({
    ...status().sessions[0],
    id,
    label,
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
  const lapsed = status();
  // The payload was measured after this lease's expiry: the server saw it close.
  (lapsed.sessions[0] as Record<string, unknown>).expiresAt = new Date(
    Date.now() - 5_000,
  ).toISOString();
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
  assert.ok(text().includes('Weight-decay researcher'));
  await settle(4_600);
  const shown = text();
  assert.ok(shown.includes('Could not refresh'), `the failure must be stated: ${shown}`);
  assert.ok(
    shown.includes('Weight-decay researcher'),
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

test('work ready to assign is named by a link as tall as a target', async (t) => {
  t.after(unmount);
  const tasks = { ...row, id: 'tasks', path: '/tasks', view: { kind: 'tasks' } };
  serve('/tools/task.list', { body: { result: [{ id: 'wf_2' }] } });
  serve('/tools/ui.read', () =>
    read({
      queue: [
        {
          instanceId: 'wf_2',
          expectedRevision: 0,
          label: 'Work: Check training configuration',
          role: 'producer',
          state: 'in_progress',
        },
      ],
      queueTotal: 1,
    }),
  );
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/sessions'] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createElement(AgentsPage as any, {
        row,
        shell: { rows: [row, tasks], plugins: [] },
        me: 'me',
      }),
    ),
  );
  await settle(20);
  // It stands alone in its cell, so it is a control: the shared class grows its target.
  const link = document.querySelector<HTMLAnchorElement>('[aria-label="Ready to assign"] a')!;
  assert.equal(link.getAttribute('href'), '/tasks/wf_2');
  assert.equal(link.textContent, 'Check training configuration');
  assert.ok(link.classList.contains('hit'));
});

test('choosing an agent brings its panel to the top of the view, and again once it has loaded', async (t) => {
  t.after(unmount);
  const seen: [string, unknown][] = [];
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.scrollIntoView = function (this: HTMLElement, options: unknown) {
    seen.push([this.id, options]);
  };
  t.after(() => delete proto.scrollIntoView);
  serve('/tools/ui.read', () => read());
  serve('/sessions/agents/agent_1/observation', {
    body: {
      agent: status().agents[0],
      assignments: [],
      toolCalls: [],
      toolCallTotal: 0,
      tokenStats: { inputTokens: 0, outputTokens: 0, completedCalls: 0, totalCalls: 0 },
      tokenAccounting: { kind: 'estimate', method: 'test' },
    },
  });
  await mount(page());
  // The lease over the list names the same agent, so the row is found by what it is.
  const opener = document.querySelector<HTMLButtonElement>('.agent-select')!;
  await act(async () => opener.click());
  await settle(20);
  // A page cannot scroll past its own foot, and the panel is one line tall until it is read.
  assert.deepEqual(seen, [
    ['agent-detail', { block: 'start' }],
    ['agent-detail', { block: 'start' }],
  ]);
  assert.equal(document.activeElement?.id, 'agent-detail-title');
  assert.equal(opener.getAttribute('aria-controls'), 'agent-detail');
  assert.equal(opener.getAttribute('aria-expanded'), 'true');
});
