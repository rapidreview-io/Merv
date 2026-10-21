/**
 * Home, the home of everything: one card per registered place, each read from what that
 * place's page reads. Each test states one thing the page must get right: the ring holds
 * every unit of the cycle in chain order with the standing the board gives it, the people
 * are the people and not the agents' actors, and a place that is not registered has no card.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
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
