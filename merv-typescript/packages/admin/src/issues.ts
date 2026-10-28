import { check, pathSegment } from '@merv/contracts';
import type { IssueCase, IssueRow } from '@merv/contracts/issues';
import type { AdminIssueCase, AdminIssueDetail, AdminIssues } from './models.js';
import type { AdminEnv, AdminRoutes } from './index.js';

/** A platform read the page does without while its owner is away or failing. */
const quiet = async <T>(read: Promise<T> | undefined) => await read?.catch(() => undefined);

/** The founder's incident board: Issues' platform reads, each project named from Scope's
 *  directory and each case's visit and work read from their owners. Intentionally global: never
 *  expose it through project-scoped tools or machine keys. */
export function issueRoutes({ ctx }: AdminEnv): AdminRoutes {
  const store = () => {
    const issues = ctx.get('issues');
    check(issues, 'issues_unavailable', 'Issues are unavailable', 503);
    return issues;
  };
  const reader = async (cases: IssueCase[]) => {
    const names = new Map((await ctx.scope.directory()).projects.map((p) => [p.id, p.name]));
    const project = (id: string | null) =>
      id && names.has(id) ? { id, name: names.get(id)! } : null;
    // A visit Issues has not pinned yet, still open or just ended, is read as Sessions has it now.
    const unpinned = [...new Set(cases.flatMap((c) => (!c.trace && c.refs.sessionId) || []))];
    const live =
      (unpinned.length && (await quiet(ctx.get('sessions')?.running.platformTrace(unpinned)))) ||
      new Map();
    const visit = (c: IssueCase) =>
      c.trace ?? (c.refs.sessionId && live.get(c.refs.sessionId)) ?? null;
    const served = [
      ...new Set(cases.flatMap((c) => visit(c)?.instanceId ?? c.refs.instanceId ?? [])),
    ];
    const units = new Map(
      ((await quiet(ctx.get('workflows')?.platformWork(served))) ?? []).map((u) => [u.id, u]),
    );
    return {
      named: <T extends IssueRow>(row: T) => ({
        ...row,
        projects: row.projects.flatMap((id) => project(id) ?? []),
      }),
      read: (c: IssueCase): AdminIssueCase => {
        const seen = visit(c);
        const unit = units.get(seen?.instanceId ?? c.refs.instanceId ?? '');
        return {
          ...c,
          project: project(c.projectId),
          visit: seen,
          work: unit
            ? {
                id: unit.id,
                kind: unit.workflow,
                name: unit.name,
                state: unit.state,
                terminal: unit.terminal,
              }
            : null,
        };
      },
    };
  };
  const id = (r: { url: URL }) => pathSegment(r.url.pathname.split('/')[3]!);
  return {
    'GET /admin/issues': async (): Promise<AdminIssues> => {
      const { rows, open, severe } = await store().platformIssues();
      const { named, read } = await reader(rows.flatMap((row) => row.latest ?? []));
      return {
        rows: rows.map((row) => ({ ...named(row), latest: row.latest && read(row.latest) })),
        open,
        severe,
        at: new Date().toISOString(),
      };
    },
    'GET /admin/issues/:id': async (r): Promise<AdminIssueDetail> => {
      const found = await store().platformIssue(id(r));
      check(found, 'not_found', 'Issue not found', 404);
      const { named, read } = await reader(found.cases);
      return { issue: named(found.issue), cases: found.cases.map(read) };
    },
  };
}
