/**
 * The admin's Issues routes: Issues' platform reads with each project named from Scope's
 * directory, a resolve that is audited, and 503 while Issues is not installed.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Context } from 'cordis';
import type { IssueCase, IssueRow, IssueStore } from '@merv/contracts/issues';
import type { AdminIssueDetail, AdminIssues } from '@merv/admin/models';
import { adminAudit, adminRoutes, refused } from './fixtures/admin.js';
import { openState } from './fixtures/state.js';

const admin = { issuer: 'https://identity.example/auth/v1', subject: 'founder', label: 'Founder' };
const at = '2026-10-27T10:00:00.000Z';
const row: IssueRow = {
  id: 'issue_1',
  class: 'tool',
  where: 'experiment.write:create',
  code: 'invalid_input',
  key: null,
  level: 'severe',
  loop: false,
  state: 'open',
  count: 3,
  peakHour: 2,
  note: null,
  projects: ['project_a', 'project_gone'],
  firstAt: at,
  openedAt: at,
  lastAt: at,
  resolvedAt: null,
  resolvedBy: null,
};
const kept: IssueCase = {
  id: 'case_1',
  at,
  level: 'severe',
  status: 400,
  repeats: 0,
  projectId: 'project_a',
  subject: null,
  release: null,
  refs: { projectId: 'project_a' },
  error: { code: 'invalid_input', status: 400 },
  note: null,
  trace: null,
};

async function fixture(t: TestContext, installed = true) {
  const state = await openState(':memory:');
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  ctx.provide('state', state);
  ctx.provide('scope', {
    directory: async () => ({ people: [], projects: [{ id: 'project_a', name: 'Grokking' }] }),
    registerPlatformAuthority: () => () => {},
  });
  const closed: [string, string][] = [];
  const issues: IssueStore = {
    report() {},
    resolve() {},
    platformIssues: async () => ({ rows: [row], open: 1, severe: 1 }),
    platformIssue: async (id) =>
      id === row.id
        ? { issue: row, cases: [kept, { ...kept, id: 'case_2', projectId: null }] }
        : undefined,
    close: async (id, by) => (closed.push([id, by]), { ...row, state: 'resolved' }),
  };
  if (installed) ctx.provide('issues', issues);
  const call = await adminRoutes(ctx, [admin]);
  return { state, call, closed };
}

test('the issue list names each project Scope still knows', async (t) => {
  const { call } = await fixture(t);
  const listed = await call<AdminIssues>('GET', '/admin/issues');
  assert.deepEqual(
    { ...listed, at: undefined },
    {
      rows: [{ ...row, projects: [{ id: 'project_a', name: 'Grokking' }] }],
      open: 1,
      severe: 1,
      at: undefined,
    },
  );
  assert.ok(Date.parse(listed.at));
});

test('an issue opens with its cases, each named by its project', async (t) => {
  const { call } = await fixture(t);
  const detail = await call<AdminIssueDetail>('GET', '/admin/issues/issue_1');
  assert.deepEqual(detail.issue.projects, [{ id: 'project_a', name: 'Grokking' }]);
  assert.deepEqual(
    detail.cases.map((c) => c.project),
    [{ id: 'project_a', name: 'Grokking' }, null],
  );
  await assert.rejects(call('GET', '/admin/issues/issue_none'), refused('not_found', 404));
});

test('resolving an issue is recorded under the admin and audited', async (t) => {
  const { state, call, closed } = await fixture(t);
  await assert.rejects(
    call('POST', '/admin/issues/issue_1/resolve', { reason: 'no' }),
    refused('invalid_input', 400),
  );
  assert.deepEqual(await call('POST', '/admin/issues/issue_1/resolve', {}), {
    id: 'issue_1',
    state: 'resolved',
  });
  assert.deepEqual(closed, [['issue_1', 'Founder']]);
  const audit = await adminAudit(state);
  assert.deepEqual(
    audit.map(({ action, target }) => [action, target]),
    [['issues.resolve', 'issue_1']],
  );
});

test('every Issues route answers 503 while Issues is not installed', async (t) => {
  const { call } = await fixture(t, false);
  for (const [method, path] of [
    ['GET', '/admin/issues'],
    ['GET', '/admin/issues/issue_1'],
    ['POST', '/admin/issues/issue_1/resolve'],
  ] as const)
    await assert.rejects(call(method, path, {}), refused('issues_unavailable', 503), path);
});
