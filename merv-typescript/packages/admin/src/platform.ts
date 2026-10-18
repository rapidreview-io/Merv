import { AsyncResource } from 'node:async_hooks';
import { check, MervError, type Caller, type Project } from '@merv/contracts';
import type {} from '@merv/customer-experiments/models';
import type { AdminEnv, AdminRoutes } from './index.js';

/** One `project.read` audit entry stands for an admin's reads of one project for this long. */
const AUDIT_EVERY_MS = 3600_000;

/**
 * Platform read: a configured admin opens any project's own pages as a reader. Scope asks this
 * authority to vouch for each of its decisions; the registry offers such a caller the read-only
 * native tools alone. Routes: every project for the drill-in picker, and a standalone experiment
 * as its customer sees it.
 */
export function platformRead({ ctx, state, audit, admins }: AdminEnv): AdminRoutes {
  const audited = new Map<string, number>();
  // Scope asks inside a reader's snapshot, where nothing may write: the audit runs outside it.
  const detached = AsyncResource.bind((fn: () => void) => fn());
  const vouches = ({ platform, projectId }: Caller) => {
    const who = admins.find(
      (a) => a.issuer === platform?.issuer && a.subject === platform?.subject,
    );
    const key = who && JSON.stringify([who.issuer, who.subject, projectId]);
    if (key && Date.now() - (audited.get(key) ?? 0) >= AUDIT_EVERY_MS) {
      audited.set(key, Date.now());
      const { issuer, subject } = who;
      const entry = { issuer, subject, action: 'project.read', target: projectId };
      detached(() => void audit.record(entry).catch(() => audited.delete(key)));
    }
    return !!who;
  };
  ctx.effect(() => ctx.scope.registerPlatformAuthority({ vouches }));
  ctx.effect(() =>
    ctx.tools.registerCallerRules('platform', {
      offers: (tool) => tool.readOnly,
      forbidden: new MervError('platform_read_only', 'Platform administrators only read', 403),
    }),
  );
  return {
    'GET /admin/projects': async () => ({
      projects: await state.read((sql) =>
        sql.all<Project>(
          'SELECT id,name,created_at AS "createdAt" FROM projects ORDER BY created_at DESC,id',
        ),
      ),
    }),
    'GET /admin/standalone/:requestId': async (r) => {
      const customers = ctx.get('customerExperiments');
      check(customers, 'unavailable', 'Standalone experiments are not installed', 503);
      return await customers.snapshot(r.url.pathname.split('/')[3]!);
    },
  };
}
