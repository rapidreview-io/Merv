/**
 * The Sessions page, rendered. Each test states one thing the page must never do:
 * blank a list that is still correct, call a lease lapsed on a clock its data
 * never saw, hide its own subject, or report a halt it cannot vouch for.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSummary } from '@merv/contracts/types';
import { click, jump, mount, requests, serve, settle, text, unmount } from './ui-render.js';

const { createElement, useState } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
const { act } = await import('react-dom/test-utils');
const { AgentsPage } = await import('../packages/ui/web/views/sessions.js');
const { setProject, setToken } = await import('../packages/ui/web/api.js');
const { AgentDetail } = await import('../packages/ui/web/views/agent-sessions-panel.js');

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
        currentAssignment: {
          label: 'Work: Sweep weight decay',
          name: 'Sweep weight decay',
          role: 'producer',
        },
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

test('a failed lease shows both the outcome and the runner exit reason', async (t) => {
  t.after(unmount);
  const ended = {
    ...status().sessions[0],
    status: 'released',
    closedAt: new Date().toISOString(),
    outcome: 'crash_loop',
    closeReason: 'local_process_exit_code_7',
    workflow: { name: 'task', state: 'in_progress' },
    tools: [],
  };
  serve('/tools/ui.read', () => read({ sessions: [ended] }));
  serve('/tools/ui.read', (_count, input) => {
    if (!input.params) return read({ sessions: [ended] });
    assert.deepEqual(input, { rowId: 'sessions', params: { agentId: 'agent_1' } });
    return {
      body: {
        result: {
          agent: status().agents[0],
          assignments: [ended],
          toolCalls: [],
          toolCallTotal: 0,
          tokenStats: { inputTokens: 0, outputTokens: 0, completedCalls: 0, totalCalls: 0 },
          tokenAccounting: { kind: 'estimate', method: 'test' },
        },
      },
    };
  });
  await mount(page());
  const opener = document.querySelector<HTMLButtonElement>('.agent-select')!;
  await act(async () => opener.click());
  await settle(20);
  const shown = text();
  assert.ok(shown.includes('Outcome') && shown.includes('crash loop'), shown);
  assert.ok(shown.includes('Reason') && shown.includes('local process exit code 7'), shown);
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

test('choosing an agent brings its panel to the top of the view, and again once it has loaded', async (t) => {
  t.after(unmount);
  const seen: [string, unknown][] = [];
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.scrollIntoView = function (this: HTMLElement, options: unknown) {
    seen.push([this.id, options]);
  };
  t.after(() => delete proto.scrollIntoView);
  serve('/tools/ui.read', () => read());
  serve('/tools/ui.read', (_count, input) => {
    if (!input.params) return read();
    assert.deepEqual(input, { rowId: 'sessions', params: { agentId: 'agent_1' } });
    return {
      body: {
        result: {
          agent: status().agents[0],
          assignments: [],
          toolCalls: [],
          toolCallTotal: 0,
          tokenStats: { inputTokens: 0, outputTokens: 0, completedCalls: 0, totalCalls: 0 },
          tokenAccounting: { kind: 'estimate', method: 'test' },
        },
      },
    };
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

test('an agent a runner started is named for that runner, as the Runners table names it', async (t) => {
  t.after(unmount);
  const runner = '0c27f0b2-fefb-447a-83d1-ce2c68d2ae7c';
  const gone = '5d1e9a40-3b7c-4d11-9f0e-7a2b8c4d6e1f';
  const base = status();
  const agent = (id: string, runnerId: string, name = `Agent ${runnerId}`) => ({
    ...base.agents[0],
    id,
    name,
    runnerId,
    currentExecutionId: null,
    currentAssignment: null,
  });
  serve('/tools/ui.read', () =>
    read({
      runners: [
        {
          ...base.runners[0],
          runnerId: runner,
          machine: { ...base.runners[0].machine, hostname: 'Gurals-MacBook-Pro.local' },
        },
      ],
      sessions: [{ ...base.sessions[0], agentId: 'agent_mac' }],
      agents: [
        { ...agent('agent_mac', runner), currentExecutionId: 'sess_1' },
        agent('agent_qa', 'qa-launcher'),
        agent('agent_gone', gone),
        agent('agent_named', runner, 'Weight-decay researcher'),
      ],
    }),
  );
  await mount(page());
  const lease = document.querySelector('.lease-row > span')!;
  assert.equal(lease.textContent, 'Gurals-MacBook-Pro.local');
  const listed = [...document.querySelectorAll('.agent-select')].map((node) => node.textContent);
  assert.deepEqual(listed.sort(), [
    '5d1e9a40…4d6e1f',
    'Gurals-MacBook-Pro.local',
    'Weight-decay researcher',
    'qa-launcher',
  ]);
  assert.ok(!text().includes(runner) && !text().includes(gone), 'a raw runner id names nobody');
});

const agent = (id: string) =>
  ({
    id,
    name: `Agent ${id}`,
    status: 'active',
    createdAt: new Date().toISOString(),
  }) as AgentSummary;
const observation = (id: string, tool: string) => ({
  agent: agent(id),
  assignments: [],
  toolCalls: [
    {
      id: 'call',
      tool,
      status: 'succeeded',
      startedAt: new Date().toISOString(),
      durationMs: 20,
      inputTokens: 1,
      outputTokens: 2,
    },
  ],
  toolCallTotal: 1,
  tokenStats: { inputTokens: 1, outputTokens: 2, completedCalls: 1, totalCalls: 1 },
});

test('agent observation keeps its last good read on failure, pauses while hidden, and refreshes on return', async (t) => {
  t.after(unmount);
  let hidden = false;
  const original = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  });
  t.after(() =>
    original
      ? Object.defineProperty(document, 'visibilityState', original)
      : Reflect.deleteProperty(document, 'visibilityState'),
  );
  let reads = 0;
  serve('/tools/ui.read', (_count, input) => {
    assert.deepEqual(input, { rowId: 'sessions', params: { agentId: 'first' } });
    reads++;
    return reads === 2
      ? { network: true }
      : {
          body: { result: observation('first', reads === 1 ? 'retained.call' : 'refreshed.call') },
        };
  });
  await mount(createElement(AgentDetail, { agent: agent('first'), rowId: 'sessions', close() {} }));
  assert.match(text(), /retained.call/);
  hidden = true;
  await settle(4200);
  assert.equal(reads, 2);
  assert.match(text(), /Could not refresh/);
  assert.match(text(), /retained.call/, 'a failed poll does not blank the last observation');
  await settle(4200);
  assert.equal(reads, 2, 'hidden tabs stop polling');
  hidden = false;
  await act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
  await settle();
  assert.equal(reads, 3);
  assert.match(text(), /refreshed.call/);
  assert.doesNotMatch(text(), /Could not refresh/);
  assert.ok(requests.every((request) => !request.includes('/sessions/agents/')));
});

test('late observations cannot replace the selected agent or survive a project change', async (t) => {
  t.after(unmount);
  const fixtureFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = fixtureFetch;
  });
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = async (...args) => {
    const response = await fixtureFetch(...args);
    if (JSON.parse(String(args[1]?.body ?? '{}')).params?.agentId === 'first') await delayed;
    return response;
  };
  serve('/tools/ui.read', (_count, input) => ({
    body: {
      result: observation(
        String((input.params as { agentId: string }).agentId),
        `${(input.params as { agentId: string }).agentId}.call`,
      ),
    },
  }));
  function Selected() {
    const [selected, select] = useState('first');
    return createElement(
      'div',
      {},
      createElement('button', { onClick: () => select('second') }, 'Choose second'),
      createElement(AgentDetail, { agent: agent(selected), rowId: 'sessions', close() {} }),
    );
  }
  await mount(createElement(Selected));
  await click('Choose second');
  assert.match(text(), /second.call/);
  release();
  await settle();
  assert.match(text(), /second.call/);
  assert.doesNotMatch(text(), /first.call/);
  serve('/tools/ui.read', {
    status: 404,
    body: { error: { code: 'agent_not_found', message: 'Agent not found in this project' } },
  });
  await act(async () => setProject('another-project'));
  await settle();
  assert.doesNotMatch(text(), /second.call/, 'old project activity is discarded');
  assert.match(
    document.querySelector('[role="alert"]')?.textContent ?? '',
    /Agent not found in this project/,
  );
});
