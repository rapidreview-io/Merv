/** Cycle 11 review: a refused cycle move is checked again while it waits. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mount, requests, serve, settle, unmount } from './ui-render.js';

sessionStorage.setItem('merv:token', 'fixture-token');
const { createElement } = await import('react');
const { MemoryRouter, Route, Routes } = await import('react-router-dom');
// components.tsx first: it and list-filters.tsx import each other through a view, and
// only this order has every module evaluated before another one calls into it.
await import('../packages/ui/web/components.js');
const { ResearchView } = await import('../packages/ui/web/views/research.js');
const { SessionProvider } = await import('../packages/ui/web/session.js');

const now = new Date().toISOString();
const row = (id: string) => ({
  id,
  label: id,
  group: 'work',
  order: 1,
  path: `/${id}`,
  view: { kind: id },
  readable: true,
});
const shell = {
  rows: [row('tasks'), row('experiments'), row('research'), row('reflections')],
  plugins: [],
};
const graph = (state: string, terminal: boolean) => ({
  instanceId: 'wf_1',
  workflow: 'x',
  version: 1,
  revision: 3,
  state,
  currentGate: state,
  terminal,
  dependencies: [],
  nodes: [
    {
      state,
      initial: true,
      terminal,
      current: true,
      entries: 1,
      firstEnteredAt: now,
      blockers: [],
    },
  ],
  edges: [],
});
async function open(path: string, view: unknown) {
  const project = { id: 'project_1', name: 'Grokking', createdAt: now };
  const actor = { id: 'actor_me', projectId: project.id, name: 'Me', role: 'reader' };
  serve('/auth/config', { body: { enabled: false } });
  serve('/account', {
    body: { kind: 'actor', actor: { ...actor, active: true }, projects: [project] },
  });
  serve('/tools/ui.shell', { body: { result: { actor, project, rows: [], plugins: [] } } });
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(
        SessionProvider,
        null,
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: `/${path.split('/')[1]}/*`,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            element: createElement(view as any, { row: row(path.split('/')[1]!), shell }),
          }),
        ),
      ),
    ),
  );
  await settle(20);
}
const reads = (path: string) => requests.filter((request) => request === `POST ${path}`).length;

/**
 * A cycle whose gate refuses while it waits on something its page's check-free read does not
 * show (its consolidation's code reaching main) must not keep that refusal on screen forever:
 * nothing about the cycle or its work moves when the wait ends.
 */
test('a refused cycle move is checked again while it waits, though nothing on the page moves', async (t) => {
  t.after(unmount);
  let ready = false;
  const record = {
    id: 'wf_1',
    name: 'Grokking cycle',
    ownerId: 'actor_1',
    workflow: { workflow: 'research', state: 'consolidating', revision: 4, updatedAt: now },
    researchDependencies: [],
    reflectionId: null,
    integrations: [],
    writable: true,
    automation: null,
    progress: { settled: 1, total: 1 },
  };
  serve('/tools/ui.read', () => ({
    body: { result: { record, process: { ...graph('consolidating', false), revision: 4 } } },
  }));
  serve('/tools/workflow.status_and_next', () => ({
    body: {
      result: {
        instanceId: 'wf_1',
        revision: 4,
        terminal: false,
        actions: [
          {
            action: 'advance',
            tool: 'research.advance',
            status: ready ? 'ready' : 'blocked',
            blockers: ready
              ? []
              : [{ code: 'dependencies_pending', message: 'Waiting for the consolidation code' }],
            requiredInput: [],
          },
        ],
        blockers: [],
        dependencies: [],
      },
    },
  }));
  await open('/research/wf_1', ResearchView);
  const button = () =>
    [...document.querySelectorAll('button')].find((each) =>
      each.textContent!.includes('Start next step'),
    );
  assert.ok(button(), 'the move is drawn');
  assert.equal(button()!.disabled, true, 'refused while it waits');
  // The consolidation's code reaches main: the gate would now let the cycle move.
  ready = true;
  await settle(31_000);
  assert.equal(button()!.disabled, false, 'the move opens once the gate does');
});
