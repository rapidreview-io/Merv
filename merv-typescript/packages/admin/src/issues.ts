import { z } from 'zod';
import { check, pathSegment } from '@merv/contracts';
import type { IssueRow } from '@merv/contracts/issues';
import type { AdminIssue, AdminIssueDetail, AdminIssues } from './models.js';
import type { AdminEnv, AdminRoutes } from './index.js';

/** The founder's incident board: Issues' platform reads, each project named from Scope's
 *  directory. Intentionally global: never expose it through project-scoped tools or machine keys. */
export function issueRoutes(env: AdminEnv): AdminRoutes {
  const store = () => {
    const issues = env.ctx.get('issues');
    check(issues, 'issues_unavailable', 'Issues are unavailable', 503);
    return issues;
  };
  const named = async () => {
    const names = new Map((await env.ctx.scope.directory()).projects.map((p) => [p.id, p.name]));
    const project = (id: string | null) =>
      id && names.has(id) ? { id, name: names.get(id)! } : null;
    const row = (issue: IssueRow): AdminIssue => ({
      ...issue,
      projects: issue.projects.flatMap((id) => project(id) ?? []),
    });
    return { project, row };
  };
  const id = (r: { url: URL }) => pathSegment(r.url.pathname.split('/')[3]!);
  return {
    'GET /admin/issues': async (): Promise<AdminIssues> => {
      const { rows, open, severe } = await store().platformIssues();
      const { row } = await named();
      return { rows: rows.map(row), open, severe, at: new Date().toISOString() };
    },
    'GET /admin/issues/:id': async (r): Promise<AdminIssueDetail> => {
      const found = await store().platformIssue(id(r));
      check(found, 'not_found', 'Issue not found', 404);
      const { project, row } = await named();
      return {
        issue: row(found.issue),
        cases: found.cases.map((c) => ({ ...c, project: project(c.projectId) })),
      };
    },
    'POST /admin/issues/:id/resolve': async (r, who) => {
      await r.json(z.object({}).strict());
      const issue = id(r);
      const { state } = await store().close(issue, who.label ?? who.subject);
      await env.audit.record(who, 'issues.resolve', issue);
      return { id: issue, state };
    },
  };
}
