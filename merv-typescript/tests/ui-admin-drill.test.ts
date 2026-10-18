/**
 * The admin's drill-in (/ui/admin/p/<project>/…): the member Workspace for a project the admin
 * is no member of, read as the platform. Its own file, because the drill-in is decided once per
 * page load, as the address is read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { click, mount, serve, settle, text, unmount } from './ui-render.js';

sessionStorage.setItem('merv:token', 'fixture-token');
// What each request carried, by path: the drill-in is a header the server reads.
const sent = new Map<string, Record<string, string>>();
const inner = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
  sent.set(String(input), { ...(init?.headers ?? {}) });
  return await inner(input as never, init as never);
}) as typeof fetch;

const api = await import('../packages/ui/web/api.js');
assert.equal(api.drillIn('/ui/admin/p/project_x/tasks/wf_1'), '/ui/admin/p/project_x');
const { createElement } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
const { App } = await import('../packages/ui/web/app.js');
const { ConfirmAction, Submit } = await import('../packages/ui/web/components.js');

const project = {
  id: 'project_x',
  name: 'Protein stability screen',
  createdAt: '2026-09-01T00:00:00Z',
};
const reader = {
  id: 'actor_platform',
  projectId: project.id,
  name: 'Platform administrator',
  role: 'reader',
  active: true,
};
const row = (id: string, kind: string, group: string, label: string) => ({
  id,
  label,
  group,
  order: 1,
  path: `/${id}`,
  view: { kind },
  status: {},
  readable: false,
});
const rows = [
  row('work', 'work', 'lead', 'Work'),
  row('pi', 'pi', 'top', 'Agent'),
  row('boards', 'boards', 'top', 'Board'),
  row('sandboxes', 'sandboxes', 'fleet', 'Sandboxes'),
  row('artifacts', 'artifacts', 'research', 'Files'),
  { ...row('settings', 'settings', 'settings', 'Settings'), rooms: true },
];

test('the drill-in opens a project nobody made it a member of, read as the platform', async (t) => {
  t.after(async () => await unmount());
  serve('/auth/config', { body: { enabled: false } });
  const user = {
    issuer: 'https://auth.example',
    subject: 'founder',
    createdAt: '2026-09-01T00:00:00Z',
  };
  serve('/account', { body: { kind: 'user', user, projects: [] } });
  serve('/tools/ui.shell', { body: { result: { actor: reader, project, rows, plugins: [] } } });
  await mount(createElement(MemoryRouter, { initialEntries: ['/settings'] }, createElement(App)));
  await settle(20);
  assert.doesNotMatch(text(), /New project|Projects/, 'no chooser: the address chose');
  const line = document.querySelector('.admin-drill')!;
  assert.equal(line.textContent, '← AdminProtein stability screen');
  assert.equal(line.querySelector('a')!.getAttribute('href'), '/ui/admin');
  // Every scoped read says it reads as the platform, in the project the address named.
  assert.equal(sent.get('/tools/ui.shell')!['x-merv-platform'], 'read');
  assert.equal(sent.get('/tools/ui.shell')!['x-merv-project-id'], 'project_x');
  assert.equal(sent.get('/account')!['x-merv-platform'], undefined);
  // A page that is only verbs has no row and no route.
  const rail = [...document.querySelectorAll('.sidebar .rail-row-label')].map((n) => n.textContent);
  assert.ok(rail.includes('Work') && rail.includes('Files'), rail.join());
  for (const verb of ['Agent', 'Board', 'Sandboxes', 'Settings'])
    assert.ok(!rail.includes(verb), verb);
  assert.match(text(), /Page not found/);
  // The project is not the reader's to switch.
  assert.equal(document.querySelector('.rail-project'), null);
  await click('Platform administrator');
  assert.doesNotMatch(document.querySelector('.account-menu')!.textContent!, /Switch project/);
});

test('a drill-in the server refuses keeps the sign-in it was refused to', async (t) => {
  t.after(async () => await unmount());
  serve('/auth/config', { body: { enabled: false } });
  serve('/account', { body: { kind: 'user', user: { issuer: 'i', subject: 's' }, projects: [] } });
  const refusal = {
    code: 'forbidden',
    message: 'Live platform administrator authority is required',
  };
  for (const tool of ['ui.shell', 'actor.whoami', 'project.get'])
    serve(`/tools/${tool}`, { status: 403, body: { error: refusal } });
  await mount(createElement(MemoryRouter, { initialEntries: ['/'] }, createElement(App)));
  await settle(20);
  assert.match(text(), /Live platform administrator authority is required/);
  assert.equal(sessionStorage.getItem('merv:token'), 'fixture-token');
  // No sign-in form for an admin still signed in: the way back to the admin instead.
  assert.equal(document.querySelector('form'), null);
  assert.equal(document.querySelector('a')!.getAttribute('href'), '/ui/admin');
});

test('in the drill-in the verb primitives draw nothing', async (t) => {
  t.after(async () => await unmount());
  await mount(
    createElement(
      'form',
      null,
      createElement(Submit, { label: 'Create' }),
      createElement(ConfirmAction, {
        label: 'Halt lease',
        title: 'Halt?',
        confirm: 'Halt lease',
        opened: true,
        onConfirm: () => undefined,
        children: 'It stops.',
      }),
    ),
  );
  assert.equal(text(), '');
  assert.equal(document.querySelectorAll('button').length, 0);
});
