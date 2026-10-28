/**
 * The admin's Issues page against a fixture server: the week at a glance (each class's reports and
 * where it fails), then one card per issue that says what went wrong in words and never by an id,
 * and opens its newest case's context in its project as that project's people see it: the agent's
 * visit on its work's Agents tab, the work, the machine, else the project; a fault's code at the
 * release that ran it. `?issue=` unfolds an issue's kept cases; nothing on the page resolves an
 * issue. Credits' drawer steps and hands the cursor back through `useDrawer`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ADDRESS, click, mount, requests, serve, settle, text, unmount } from './ui-render.js';

sessionStorage.setItem('merv:token', 'fixture-token');
const { createElement } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
const { AdminApp } = await import('../packages/ui/web/admin/app.js');

const at = new Date(Date.now() - 3_600_000).toISOString();
const hour = at.slice(0, 13);
const grokking = { id: 'project_a', name: 'Grokking' };
const visit = {
  projectId: 'project_a',
  threadId: 'thread_1',
  instanceId: 'wf_1',
  revision: 2,
  role: 'producer',
  harness: 'codex',
  status: 'closed',
  outcome: 'tool_failed',
  createdAt: at,
};
const kept = {
  id: 'case_1',
  at,
  level: 'severe',
  status: 400,
  repeats: 3,
  projectId: 'project_a',
  subject: null,
  release: '20261027T143230Z-a53efa40-d59a346aecc0',
  refs: { projectId: 'project_a', sessionId: 'session_1' },
  error: { code: 'invalid_input', status: 400, fields: ['create.intent'] },
  note: null,
  trace: visit,
  project: grokking,
  visit,
  work: {
    id: 'wf_1',
    kind: 'experiment',
    name: 'grokking-sweep',
    state: 'planning',
    terminal: false,
  },
};
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
  projects: [grokking],
  visits: 3,
  firstAt: at,
  openedAt: at,
  lastAt: at,
  resolvedAt: null,
  resolvedBy: null,
  hours: [[hour, 1200]],
  latest: kept,
  ...over,
});
const asked = issue('issue_ask', {
  class: 'question',
  where: 'session.ask_owner',
  code: 'asked',
  key: 'question_1',
  level: 'warn',
  loop: false,
  count: 1,
  note: 'Which dataset split should I use? The plan names two.',
  hours: [[hour, 1]],
  latest: { ...kept, id: 'case_ask', error: null },
});
const gone = issue('issue_gone', {
  class: 'platform',
  where: 'fleet.machine_gone',
  code: 'stopped',
  loop: false,
  count: 2,
  hours: [[hour, 2]],
  latest: {
    ...kept,
    id: 'case_gone',
    trace: null,
    visit: null,
    error: null,
    refs: { projectId: 'project_a', instanceId: 'wf_1', allocationId: 'alloc_1' },
  },
});
const crashed = issue('issue_crash', {
  class: 'platform',
  where: 'api_error',
  code: 'internal_error',
  key: 'POST /tools',
  loop: false,
  count: 1,
  projects: [],
  hours: [[hour, 1]],
  latest: {
    ...kept,
    id: 'case_crash',
    projectId: null,
    project: null,
    trace: null,
    visit: null,
    work: null,
    refs: {},
    error: {
      name: 'TypeError',
      at: [
        'at Dispatch.offer (/srv/merv/merv-typescript/packages/sessions/src/dispatch.ts:392:11)',
      ],
    },
  },
});
const serveIssues = (rows: unknown[]) =>
  serve('/admin/issues', { body: { rows, open: rows.length, severe: 1, at } });
const open = async (path: string) => {
  await mount(createElement(MemoryRouter, { initialEntries: [path] }, createElement(AdminApp)));
  await settle(20);
};
const drawer = () => document.querySelector<HTMLElement>('#admin-drawer')!;
const card = (id: string) => document.getElementById(`issue-${id}`)!;
const links = (id: string) =>
  [...card(id).querySelectorAll('.issue-acts a')].map((a) => [
    a.textContent,
    a.getAttribute('href'),
  ]);

test('issues read in words, never by id, the week counts each class and the rail the severe', async (t) => {
  t.after(unmount);
  serveIssues([issue('issue_1'), asked, gone, crashed]);
  await open('/admin/issues');
  const page = text();
  assert.match(page, /experiment write create · invalid input/);
  assert.match(page, /Which dataset split should I use\?/);
  assert.match(page, /A Fleet machine vanished · stopped/);
  assert.match(
    card('issue_1').querySelector('.issue-where')!.textContent!,
    /^GrokkingExperiment grokking-sweepProducer · Codex3 agents$/,
  );
  assert.match(page, /fields create\.intent/);
  assert.match(page, /packages\/sessions\/src\/dispatch\.ts:392/);
  assert.match(page, /3 agents/);
  // The week: each class with its reports, and where it fails by tool, project and part.
  const legend = [...document.querySelectorAll('.issues-key')].map((b) => b.textContent);
  assert.deepEqual(legend, ['Tool calls 1.2K', 'Questions 1', 'Platform 3']);
  const parts = [...document.querySelectorAll('.issues-part li')].map((li) => li.textContent);
  assert.deepEqual(parts, ['experiment.write1.2K', 'Grokking1', 'Fleet2', 'Server1']);
  for (const id of ['issue_1', 'issue_ask', 'project_a', 'wf_1', 'thread_1', 'question_1'])
    assert.ok(!page.includes(id), id);
  assert.doesNotMatch(page, ADDRESS);
  assert.doesNotMatch(page, /Resolve/);
  const rail = [...document.querySelectorAll('.rail-row')].find((row) =>
    row.textContent?.startsWith('Issues'),
  );
  assert.equal(rail?.querySelector('.rail-count')?.textContent, '1');
  // The rail and the page share one read.
  assert.equal(requests.filter((r) => r === 'GET /admin/issues').length, 1);
});

test('each issue opens its context in its project: the agent’s visit, the work and machine, the code', async (t) => {
  t.after(unmount);
  serveIssues([issue('issue_1'), asked, gone, crashed]);
  await open('/admin/issues');
  const session = '/admin/p/project_a/work?key=work:wf_1&thread=thread_1';
  const commit = 'https://github.com/rapidreview-io/Merv/blob/a53efa40/merv-typescript';
  assert.deepEqual(links('issue_1'), [['Open agent session', session]]);
  assert.deepEqual(links('issue_ask'), [['Open agent session', session]]);
  assert.deepEqual(links('issue_gone'), [
    ['Open experiment', '/admin/p/project_a/work?key=work:wf_1'],
    ['Machine', '/admin/p/project_a/fleet/alloc_1'],
  ]);
  assert.deepEqual(links('issue_crash'), [
    ['Open code at a53efa40', `${commit}/packages/sessions/src/dispatch.ts#L392`],
  ]);
});

test('a group of the week narrows the cards to its issues, and again shows them all', async (t) => {
  t.after(unmount);
  serveIssues([issue('issue_1'), asked, gone, crashed]);
  await open('/admin/issues');
  await click('Fleet');
  assert.deepEqual(
    [...document.querySelectorAll('.issue')].map((li) => li.id),
    ['issue-issue_gone'],
  );
  await click('Fleet');
  assert.equal(document.querySelectorAll('.issue').length, 4);
  await click('Questions');
  assert.deepEqual(
    [...document.querySelectorAll('.issue')].map((li) => li.id),
    ['issue-issue_ask'],
  );
});

test('?issue= unfolds its kept cases, each opening its own context, with the case to download', async (t) => {
  t.after(unmount);
  serveIssues([issue('issue_1')]);
  serve('/admin/issues/issue_1', {
    body: {
      issue: issue('issue_1'),
      cases: [
        kept,
        {
          ...kept,
          id: 'case_2',
          visit: null,
          trace: null,
          refs: { instanceId: 'wf_9' },
          work: null,
        },
      ],
    },
  });
  await open('/admin/issues?issue=issue_1');
  await settle(20);
  const cases = card('issue_1').querySelector('.issue-cases')!;
  assert.match(cases.textContent ?? '', /GrokkingExperiment grokking-sweepProducer · Codex/);
  assert.match(cases.textContent ?? '', /×3/);
  assert.deepEqual(
    [...cases.querySelectorAll('li a:not([target])')].map((a) => a.getAttribute('href')),
    [
      '/admin/p/project_a/work?key=work:wf_1&thread=thread_1',
      '/admin/p/project_a/work?key=work:wf_9',
    ],
  );
  assert.match(cases.textContent ?? '', /Download case/);
  await click('experiment write create · invalid input');
  assert.equal(card('issue_1').querySelector('.issue-cases'), null);
});

test('with only ended issues the page says Nothing open, and Clear filters shows them', async (t) => {
  t.after(unmount);
  serveIssues([issue('issue_1', { state: 'resolved', resolvedAt: at })]);
  await open('/admin/issues');
  assert.match(text(), /Nothing open/);
  assert.equal(document.querySelectorAll('.issue').length, 0);
  await click('Clear filters');
  assert.match(text(), /experiment write create · invalid input/);
  assert.match(card('issue_1').textContent ?? '', /ended/);
  // An alert's link names an issue that has ended since: it is shown, unfolded, all the same.
  await unmount();
  serve('/admin/issues/issue_1', { body: { issue: issue('issue_1'), cases: [kept] } });
  await open('/admin/issues?issue=issue_1');
  assert.ok(card('issue_1').querySelector('.issue-cases'));
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
