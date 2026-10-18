/**
 * What ui-cycle-gate-wait and ui-record-polls share: a signed-in reader's record page mounted
 * at a path through the real session, the shell rows it is given, a workflow graph and a count
 * of the reads a path received. Import it after ./ui-render.js and before any view.
 */
import { mount, requests, serve, settle } from './ui-render.js';

sessionStorage.setItem('merv:token', 'fixture-token');
const { createElement } = await import('react');
const { MemoryRouter, Route, Routes } = await import('react-router-dom');
// components.tsx first: it and list-filters.tsx import each other through a view, and
// only this order has every module evaluated before another one calls into it.
await import('../packages/ui/web/components.js');
const { SessionProvider } = await import('../packages/ui/web/session.js');

export const now = new Date().toISOString();
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
export const graph = (state: string, terminal: boolean) => ({
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
export async function open(path: string, view: unknown) {
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
export const reads = (path: string) =>
  requests.filter((request) => request === `POST ${path}`).length;
