/**
 * The admin's Issues routes: Issues' platform reads with each project named from Scope's
 * directory, each case's visit read from Sessions until Issues pins it and its work named by
 * Workflows, and 503 while Issues is not installed.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Context } from 'cordis';
import type { IssueCase, IssueRow, IssueStore, SessionTrace } from '@merv/contracts/issues';
import type { AdminIssueDetail, AdminIssues } from '@merv/admin/models';
import { adminRoutes, refused } from './fixtures/admin.js';
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
  visits: 1,
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
  refs: { projectId: 'project_a', sessionId: 'session_1' },
  error: { code: 'invalid_input', status: 400 },
  note: null,
  trace: null,
};
const visit: SessionTrace = {
  projectId: 'project_a',
  threadId: 'thread_1',
  instanceId: 'wf_1',
  revision: 3,
  role: 'producer',
  harness: 'codex',
  status: 'active',
  createdAt: at,
};
const named = { id: 'project_a', name: 'Grokking' };
const work = {
  id: 'wf_1',
  kind: 'experiment',
  name: 'grokking-sweep',
  state: 'running',
  terminal: false,
};

async function fixture(t: TestContext, installed = true) {
  const state = await openState(':memory:');
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  ctx.provide('state', state);
  ctx.provide('scope', {
    directory: async () => ({ people: [], projects: [named] }),
    registerPlatformAuthority: () => () => {},
  });
  const asked: string[][] = [];
  ctx.provide('sessions', {
    running: {
      platformTrace: async (ids: string[]) => (asked.push(ids), new Map([['session_1', visit]])),
    },
  });
  const units: (readonly string[])[] = [];
  ctx.provide('workflows', {
    platformWork: async (ids: readonly string[]) => (
      units.push(ids),
      [{ ...work, workflow: work.kind, projectId: 'project_a' }]
    ),
  });
  const issues: IssueStore = {
    report() {},
    resolve() {},
    drain: async () => {},
    platformIssues: async () => ({
      rows: [{ ...row, hours: [['2026-10-27T10', 3]], latest: kept }],
      open: 1,
      severe: 1,
    }),
    platformIssue: async (id) =>
      id === row.id
        ? {
            issue: row,
            cases: [kept, { ...kept, id: 'case_2', projectId: null, refs: {}, trace: visit }],
          }
        : undefined,
  };
  if (installed) ctx.provide('issues', issues);
  const call = await adminRoutes(ctx, [admin]);
  return { state, call, asked, units };
}

test('the issue list names each project and reads its newest case’s visit and work', async (t) => {
  const { call, asked, units } = await fixture(t);
  const listed = await call<AdminIssues>('GET', '/admin/issues');
  assert.deepEqual(
    { ...listed, at: undefined },
    {
      rows: [
        {
          ...row,
          projects: [named],
          hours: [['2026-10-27T10', 3]],
          latest: { ...kept, project: named, visit, work },
        },
      ],
      open: 1,
      severe: 1,
      at: undefined,
    },
  );
  assert.ok(Date.parse(listed.at));
  // Only a visit Issues has not pinned is read from Sessions, and only its work from Workflows.
  assert.deepEqual(asked, [['session_1']]);
  assert.deepEqual(units, [['wf_1']]);
});

test('an issue opens with its cases, each with its project, visit and work', async (t) => {
  const { call, asked } = await fixture(t);
  const detail = await call<AdminIssueDetail>('GET', '/admin/issues/issue_1');
  assert.deepEqual(detail.issue.projects, [named]);
  assert.deepEqual(
    detail.cases.map((c) => [c.project, c.visit?.threadId, c.work?.name]),
    [
      [named, 'thread_1', 'grokking-sweep'],
      [null, 'thread_1', 'grokking-sweep'],
    ],
  );
  assert.deepEqual(asked, [['session_1']]);
  await assert.rejects(call('GET', '/admin/issues/issue_none'), refused('not_found', 404));
});

test('every Issues route answers 503 while Issues is not installed', async (t) => {
  const { call } = await fixture(t, false);
  for (const path of ['/admin/issues', '/admin/issues/issue_1'])
    await assert.rejects(call('GET', path), refused('issues_unavailable', 503), path);
});
