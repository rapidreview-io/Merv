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
    'Automatic dispatch',
    '1 live now',
    'Sweep weight decay',
    'lab-01',
    'Weight-decay researcher',
    // The runner says why its last lease request got nothing.
    'declined',
    'capacity full',
    // The queue names whose eligibility it reports, not a fleet backlog.
    'Eligible for this identity',
  ])
    assert.ok(shown.includes(fact), `${fact} is not on the page: ${shown.slice(0, 800)}`);
  assert.ok(!shown.includes('Operations'), 'the subject must not sit behind a fold');
  assert.ok(!shown.includes('Extend'), 'no control the system cannot honour');
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
