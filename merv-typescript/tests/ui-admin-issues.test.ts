/**
 * The admin's Issues page against a fixture server: its rows say what went wrong in words and
 * never by an id, the rail counts the open severe issues, `?issue=` opens that issue's drawer,
 * an issue already resolved offers nothing to resolve, and what is resolved waits behind the
 * open list. Credits' drawer steps and hands the cursor back through the same `useDrawer`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ADDRESS, click, mount, requests, serve, settle, text, unmount } from './ui-render.js';

sessionStorage.setItem('merv:token', 'fixture-token');
const { createElement } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
const { AdminApp } = await import('../packages/ui/web/admin/app.js');

const at = new Date(Date.now() - 3_600_000).toISOString();
const issue = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  class: 'tool',
  where: 'experiment.write:create',
  code: 'invalid_input',
  key: null,
  level: 'severe',
  loop: true,
  state: 'open',
  count: 1200,
  peakHour: 900,
  note: null,
  projects: [{ id: 'project_a', name: 'Grokking' }],
  firstAt: at,
  openedAt: at,
  lastAt: at,
  resolvedAt: null,
  resolvedBy: null,
  ...over,
});
const asked = issue('issue_ask', {
  class: 'question',
  where: 'sessions.ask',
  code: 'needs_you',
  level: 'warn',
  loop: false,
  note: 'Which dataset split should I use? The plan names two.',
  projects: [],
});
const kept = {
  id: 'case_1',
  at,
  level: 'severe',
  status: 400,
  repeats: 0,
  projectId: 'project_a',
  subject: null,
  release: '20261027T143230Z-a53efa40-d59a346aecc0',
  refs: { projectId: 'project_a', sessionId: 'session_1' },
  error: { code: 'invalid_input', status: 400 },
  note: null,
  trace: {
    projectId: 'project_a',
    threadId: 'thread_1',
    instanceId: 'wf_1',
    revision: 2,
    role: 'producer',
    harness: 'codex',
    status: 'closed',
    outcome: 'tool_failed',
    createdAt: at,
  },
  project: { id: 'project_a', name: 'Grokking' },
};
const serveIssues = (rows: unknown[]) =>
  serve('/admin/issues', { body: { rows, open: rows.length, severe: 1, at } });
const open = async (path: string) => {
  await mount(createElement(MemoryRouter, { initialEntries: [path] }, createElement(AdminApp)));
  await settle(20);
};
const drawer = () => document.querySelector<HTMLElement>('#admin-drawer')!;

test('issues read in words, never by id, and the rail counts the severe ones', async (t) => {
  t.after(unmount);
  serveIssues([issue('issue_1'), asked]);
  await open('/admin/issues');
  const page = text();
  assert.match(page, /experiment\.write create · invalid input/);
  assert.match(page, /Which dataset split should I use\?/);
  assert.match(page, /Grokking/);
  assert.match(page, /1\.2K/);
  for (const id of ['issue_1', 'issue_ask', 'project_a']) assert.ok(!page.includes(id), id);
  assert.doesNotMatch(page, ADDRESS);
  const rail = [...document.querySelectorAll('.rail-row')].find((row) =>
    row.textContent?.startsWith('Issues'),
  );
  assert.equal(rail?.querySelector('.rail-count')?.textContent, '1');
  // The rail and the page share one read.
  assert.equal(requests.filter((r) => r === 'GET /admin/issues').length, 1);
  assert.ok(drawer().hidden);
});

test('?issue= opens its drawer, whose Resolve issue posts and leaves once resolved', async (t) => {
  t.after(unmount);
  let state = 'open';
  serve('/admin/issues', () => ({
    body: { rows: [issue('issue_1', { state })], open: 1, severe: 1, at },
  }));
  serve('/admin/issues/issue_1', () => ({
    body: {
      issue: issue('issue_1', { state }),
      cases: [kept, { ...kept, id: 'case_2', refs: { instanceId: 'wf_9' }, trace: null }],
    },
  }));
  serve('/admin/issues/issue_1/resolve', () => {
    state = 'resolved';
    return { body: { id: 'issue_1', state } };
  });
  await open('/admin/issues?issue=issue_1');
  assert.ok(!drawer().hidden);
  const said = drawer().textContent ?? '';
  assert.match(said, /Producer codex/i);
  assert.match(said, /tool failed/);
  assert.match(said, /Thread →/);
  for (const id of ['session_1', 'thread_1', 'wf_1', 'a53efa40']) assert.ok(!said.includes(id));
  // A case that names only its work opens the work.
  assert.deepEqual(
    [...drawer().querySelectorAll('a.admin-more')].map((a) => [
      a.textContent,
      a.getAttribute('href'),
    ]),
    [
      ['Thread →', '/admin/p/project_a/work?key=work:wf_1&thread=thread_1'],
      ['Work →', '/admin/p/project_a/work?key=work:wf_9'],
    ],
  );
  assert.match(drawer().querySelector('li')!.title, /session session_1/);
  await click('Resolve issue');
  await settle(20);
  assert.ok(requests.includes('POST /admin/issues/issue_1/resolve'));
  assert.ok(!drawer().textContent?.includes('Resolve issue'), drawer().textContent ?? '');
  assert.ok(drawer().textContent?.includes('Download case'));
});

test('the drawer steps with ↑ and ↓, and Escape hands the cursor back to its row', async (t) => {
  t.after(unmount);
  serveIssues([issue('issue_1'), issue('issue_2', { level: 'warn' })]);
  await open('/admin/issues');
  await click('experiment.write create');
  const key = async (name: string) => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
    await settle(20);
  };
  const expanded = () =>
    [...document.querySelectorAll<HTMLElement>('.admin-name[aria-expanded="true"]')].map(
      (b) => b.dataset.id,
    );
  assert.deepEqual(expanded(), ['issue_1']);
  await key('ArrowDown');
  assert.deepEqual(expanded(), ['issue_2']);
  await key('Escape');
  assert.ok(drawer().hidden);
  assert.equal((document.activeElement as HTMLElement).dataset.id, 'issue_2');
});

test('an issue resolved leaves the list, and ↓ or Escape go on from where it stood', async (t) => {
  t.after(unmount);
  for (const [press, lands] of [
    ['ArrowDown', 'issue_3'],
    ['ArrowUp', 'issue_1'],
    ['Escape', 'issue_3'],
  ]) {
    let state = 'open';
    const rows = () =>
      ['issue_1', 'issue_2', 'issue_3'].map((id) => issue(id, id === 'issue_2' ? { state } : {}));
    serve('/admin/issues', () => ({ body: { rows: rows(), open: 3, severe: 3, at } }));
    for (const id of ['issue_1', 'issue_2', 'issue_3'])
      serve(`/admin/issues/${id}`, () => ({
        body: { issue: rows().find((r) => r.id === id), cases: [] },
      }));
    serve('/admin/issues/issue_2/resolve', () => {
      state = 'resolved';
      return { body: { id: 'issue_2', state } };
    });
    await open('/admin/issues?issue=issue_2');
    await click('Resolve issue');
    await settle(20);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: press, bubbles: true }));
    await settle(20);
    const on =
      press === 'Escape'
        ? (document.activeElement as HTMLElement).dataset.id
        : document.querySelector<HTMLElement>('.admin-name[aria-expanded="true"]')?.dataset.id;
    assert.equal(on, lands, press);
    await unmount();
  }
});

test('with only resolved issues the page says Nothing open, and Clear filters shows them', async (t) => {
  t.after(unmount);
  serveIssues([issue('issue_1', { state: 'resolved', resolvedAt: at })]);
  await open('/admin/issues');
  assert.match(text(), /Nothing open/);
  assert.doesNotMatch(text(), /experiment\.write create/);
  await click('Clear filters');
  assert.match(text(), /experiment\.write create · invalid input/);
});

test('the Credits drawer steps with ↓ and hands the cursor back to its row', async (t) => {
  t.after(unmount);
  const person = (key: string) => ({ key, label: `Person ${key}`, kinds: [] });
  serve('/admin/credits', { body: { people: [person('a'), person('b')] } });
  for (const key of ['a', 'b'])
    serve(`/admin/credits/people/${key}`, {
      body: { person: person(key), kinds: [], grants: [], schedules: [] },
    });
  await open('/admin/credits');
  await click('Person a');
  assert.ok(!drawer().hidden);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await settle(20);
  assert.match(drawer().textContent ?? '', /Person b/);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle(20);
  assert.ok(drawer().hidden);
  assert.equal((document.activeElement as HTMLElement).dataset.id, 'b');
});
