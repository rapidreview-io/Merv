/**
 * Home, the home of everything: one card per registered place, each read from what that
 * place's page reads. Each test states one thing the page must get right: the ring holds
 * every unit of the cycle in chain order with the standing the board gives it, the people
 * are the people and not the agents' actors, and a place that is not registered has no card.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Context } from 'cordis';
import type { UiRow } from '@merv/ui/types';
import type { HomeSources } from '../packages/ui/src/home.js';
import { mount, serve, settle, text, unmount } from './ui-render.js';

sessionStorage.setItem('merv:token', 'fixture-token');
Object.assign(globalThis, {
  IntersectionObserver: class {
    observe() {}
    disconnect() {}
  },
});

const { createElement } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
const { App } = await import('../packages/ui/web/app.js');

const project = {
  id: 'project_1',
  name: 'Grokking replication',
  createdAt: '2026-09-01T00:00:00Z',
};
const row = (id: string, kind: string, group = 'research', path = `/${id}`) => ({
  id,
  label: id,
  group,
  order: 10,
  path,
  view: { kind },
  status: {},
  readable: false,
});
const flow = (state: string, at = '2026-10-20T00:00:00Z') => ({
  workflow: 'task',
  version: 46,
  state,
  revision: 1,
  updatedAt: at,
});
const task = (id: string, state: string, settled: boolean, dependencies: string[] = []) => ({
  id,
  title: `Task ${id}`,
  goal: '',
  producerId: 'actor_1',
  workflow: flow(state),
  settled,
  failed: false,
  dependencies: dependencies.map((on) => ({ id: on, settled: true })),
  dependents: [],
});
const actor = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  role: 'producer',
  active: true,
  ...extra,
});

function boot(rows: object[], home: Record<string, unknown>) {
  const me = {
    id: 'actor_1',
    projectId: project.id,
    name: 'Operator',
    role: 'operator',
    active: true,
  };
  serve('/auth/config', { body: { enabled: false } });
  serve('/account', { body: { kind: 'actor', actor: me, projects: [project] } });
  serve('/tools/ui.shell', {
    body: {
      result: {
        actor: me,
        project,
        rows,
        plugins: [],
        workflows: [
          { name: 'task', states: ['in_progress', 'done'], terminal: ['done'], edges: [] },
        ],
      },
    },
  });
  serve('/tools/ui.home', { body: { result: { project, actors: [], ...home } } });
  serve('/tools/ui.running', {
    body: {
      result: {
        observedAt: '2026-10-21T00:00:00Z',
        lanes: {
          work: {
            nodes: [
              {
                key: 'work:t2',
                lane: 'work',
                title: 'Task t2',
                lines: [],
                look: 'solid',
                dot: 'live',
              },
              {
                key: 'work:t3',
                lane: 'work',
                title: 'Task t3',
                lines: [],
                look: 'solid',
                attention: { says: ['Answer the agent'] },
              },
            ],
            summaries: [],
            needsYou: 1,
          },
          sessions: { nodes: [], summaries: [], needsYou: 0 },
          hardware: { nodes: [], summaries: [], needsYou: 0 },
        },
        edges: [],
      },
    },
  });
}
const open = async () => {
  await mount(createElement(MemoryRouter, { initialEntries: ['/'] }, createElement(App)));
  await settle(30);
};

test('the ring holds every unit in chain order, each with the standing the board gives it', async (t) => {
  t.after(unmount);
  boot([row('work', 'work', 'lead'), row('tasks', 'tasks')], {
    tasks: [
      task('t3', 'in_progress', false, ['t2']),
      task('t1', 'done', true),
      task('t2', 'in_progress', false, ['t1']),
    ],
    experiments: [],
  });
  await open();
  const segments = [...document.querySelectorAll('.hub-seg')];
  assert.deepEqual(
    segments.map((seg) => seg.querySelector('title')?.textContent),
    ['Task t1', 'Task t2', 'Task t3'],
  );
  assert.deepEqual(
    segments.map((seg) => [...seg.classList].find((c) => c.startsWith('hub-seg--'))),
    ['hub-seg--done', 'hub-seg--live', 'hub-seg--stuck'],
  );
  assert.match(text(), /1 done/);
  assert.match(text(), /1 live/);
  assert.match(text(), /1 stuck/);
  assert.ok(!document.querySelector('.hub-card--pi'), 'no Pi row, no Pi card');
});

test('the people are the project members, never the actors an agent’s session or thread owns', async (t) => {
  t.after(unmount);
  boot([row('work', 'work', 'lead'), row('settings', 'settings', 'settings')], {
    tasks: [],
    experiments: [],
    actors: [
      actor('actor_1', 'Operator'),
      actor('actor_2', 'Codex producer', { sessionId: 'session_1' }),
      actor('actor_3', 'Asker', { threadId: 'thread_1' }),
      actor('actor_4', 'Claude reviewer'),
    ],
  });
  await open();
  assert.equal(document.querySelectorAll('.hub-face').length, 2);
  assert.match(text(), /2 · you are the operator/);
});

// Reproduced against the real Home: terminal failure is an outcome, not pending work.
test('failed terminal work is ended and visibly failed, even with an old live board node', async (t) => {
  t.after(unmount);
  boot([row('work', 'work', 'lead'), row('tasks', 'tasks')], {
    tasks: [{ ...task('t2', 'failed', false), failed: true }],
    experiments: [],
  });
  await open();
  assert.equal(document.querySelector('.hub-count')?.textContent, '1');
  assert.match(text(), /1 failed/);
  assert.doesNotMatch(text(), /1 stuck|1 live|1 done/);
  assert.ok(document.querySelector('.hub-seg--failed'));
});

for (const [stage, sentence] of [
  ['design_review', 'Review this design'],
  ['experiment_review', 'Review these results'],
])
  test(`Home keeps the ${stage} action visible before claiming`, async (t) => {
    t.after(unmount);
    const { styled } = await import('./ui-render.js');
    t.after(styled());
    boot(
      [
        row('work', 'work', 'lead'),
        {
          ...row('experiments', 'experiments'),
          needs: { name: 'name', owner: 'ownerId', reads: { [stage!]: sentence } },
        },
        row('reviews', 'reviews'),
      ],
      {
        tasks: [],
        experiments: [{ id: 'exp1', name: 'Candidate', ownerId: 'other', workflow: flow(stage!) }],
        reviews: [
          {
            id: 'review1',
            subjectId: 'exp1',
            open: true,
            claimable: true,
            createdAt: '2026-10-21T00:00:00Z',
          },
        ],
        workflows: {
          workflows: [{ instanceId: 'exp1', actions: [{ tool: 'review.start', status: 'ready' }] }],
        },
      },
    );
    await open();
    const action = [...document.querySelectorAll('.hub-needs .ov-say')].find(
      (n) => n.textContent === sentence,
    );
    assert.ok(action, text());
    assert.notEqual(window.getComputedStyle(action).display, 'none');
    assert.match(text(), /Claim review/);
  });

for (const [name, days, expected] of [
  [
    'unpriced',
    [{ day: '2026-10-21', usd: 0, pricedHours: 0, unpricedHours: 2 }],
    /Unavailable this month · Unavailable today · some machine prices missing/,
  ],
  [
    'mixed',
    [
      { day: '2026-10-20', usd: 0, pricedHours: 0, unpricedHours: 2 },
      { day: '2026-10-21', usd: 2, pricedHours: 2, unpricedHours: 0 },
    ],
    /\$2\.00 partial this month · \$2\.00 today · some machine prices missing/,
  ],
  [
    'free',
    [{ day: '2026-10-21', usd: 0, pricedHours: 2, unpricedHours: 0 }],
    /\$0\.00 this month · \$0\.00 today/,
  ],
  [
    'idle',
    [{ day: '2026-10-21', usd: 0, pricedHours: 0, unpricedHours: 0 }],
    /\$0\.00 this month · \$0\.00 today/,
  ],
] as const)
  test(`Fleet home projection renders ${name} compute coverage honestly`, async (t) => {
    t.after(unmount);
    const { fleetUiPlugin } = await import('../packages/fleet/src/ui.js');
    const { homeRead } = await import('../packages/ui/src/home.js');
    const registered: UiRow[] = [];
    // Capture the actual registration, then use the production trimming boundary.
    // Only the service response and unrelated identity reads are fixtures.
    fleetUiPlugin.apply({
      effect: (fn: () => unknown) => fn(),
      ui: { register: (part: UiRow) => registered.push(part), contribute: () => {} },
      fleet: { projectSpend: async () => days },
      scope: {},
    } as unknown as Context);
    const projected = await homeRead(
      {
        tools: { call: async () => [] } as unknown as HomeSources['tools'],
        isolated: async (read) => read(),
      },
      registered,
      { projectId: project.id, actorId: 'actor_1' },
    );
    assert.ok(projected && typeof projected === 'object' && !Array.isArray(projected));
    boot([row('work', 'work', 'lead')], { tasks: [], experiments: [], fleet: projected.fleet });
    await open();
    const card = document.querySelector('.hub-card--spend');
    assert.ok(card);
    assert.match(card.textContent ?? '', /Compute spend estimate/);
    assert.match(card.querySelector('.hub-line')?.textContent ?? '', expected);
    if (name === 'unpriced') {
      assert.doesNotMatch(card.textContent ?? '', /\$0/);
      assert.match(card.querySelector('title')?.textContent ?? '', /Unavailable · price missing/);
    }
  });
