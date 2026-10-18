import { AsyncResource } from 'node:async_hooks';
import { check, MervError, type Caller } from '@merv/contracts';
import type {} from '@merv/customer-experiments/models';
import { adminNamed, type AdminEnv, type AdminIdentity, type AdminRoutes } from './index.js';

/** One `project.read` or `standalone.read` entry stands for an admin's reads for this long. */
const AUDIT_EVERY_MS = 3600_000;

/**
 * Platform read: a configured admin opens any project's own pages as a reader. Scope asks this
 * authority to vouch for each of its decisions; the registry offers such a caller the read-only
 * native tools alone. Route: a standalone experiment as its customer sees it.
 */
export function platformRead({ ctx, audit, admins }: AdminEnv): AdminRoutes {
  const audited = new Map<string, number>();
  // Scope asks inside a reader's snapshot, where nothing may write: the audit runs outside it.
  const detached = AsyncResource.bind((fn: () => void) => fn());
  /** One entry an hour per admin, action and target, however often the admin reads. */
  const read = (who: AdminIdentity, action: string, target: string) => {
    const key = JSON.stringify([who.issuer, who.subject, action, target]);
    if (Date.now() - (audited.get(key) ?? 0) < AUDIT_EVERY_MS) return;
    audited.set(key, Date.now());
    detached(() => void audit.record(who, action, target).catch(() => audited.delete(key)));
  };
  const vouches = ({ platform, projectId }: Caller) => {
    const who = platform && adminNamed(admins, platform);
    if (who) read(who, 'project.read', projectId);
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
    'GET /admin/standalone/:requestId': async (r, who) => {
      const customers = ctx.get('customerExperiments');
      check(customers, 'unavailable', 'Standalone experiments are not installed', 503);
      const requestId = r.url.pathname.split('/')[3]!;
      const snapshot = await customers.snapshot(requestId);
      read(who, 'standalone.read', requestId);
      return snapshot;
    },
  };
}
