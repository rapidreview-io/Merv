import type { Context } from 'cordis';
import { z } from 'zod';
import { check, MervError, type State } from '@merv/contracts';
import type { ApiPrincipal, ApiRequest } from '@merv/api/types';
import { AdminAudit, auditMigrations } from './audit.js';
import type { AdminIdentity } from './models.js';
import { adminOverview } from './work.js';

export type { AdminIdentity } from './models.js';

const identity = z
  .object({
    issuer: z.string().min(1),
    subject: z.string().min(1),
    label: z.string().min(1).max(254).optional(),
  })
  .strict();

/** The configured admin a verified human principal is, if any. */
export function adminOf(
  principal: ApiPrincipal | undefined,
  admins: readonly AdminIdentity[],
): AdminIdentity | undefined {
  if (principal?.kind !== 'user' || !('user' in principal)) return undefined;
  const { issuer, subject } = principal.user;
  return admins.find((a) => a.issuer === issuer && a.subject === subject);
}

/** What every admin route reads with: the plugin's context, its state, audit and admins. */
export interface AdminEnv {
  ctx: Context;
  state: State;
  audit: AdminAudit;
  admins: readonly AdminIdentity[];
}
/** One admin route, answering for the verified admin `who`. */
export type AdminRoute = (r: ApiRequest, who: AdminIdentity) => Promise<unknown>;
/** Routes keyed `METHOD /admin/path`; a `:param` segment matches any one segment. */
export type AdminRoutes = Record<string, AdminRoute>;

const match = (routes: AdminRoutes, method: string, path: string) =>
  Object.entries(routes).find(([key]) => {
    const [m, pattern] = key.split(' ');
    const want = pattern.split('/');
    const have = path.split('/');
    return (
      m === method &&
      want.length === have.length &&
      want.every((part, i) => part.startsWith(':') || part === have[i])
    );
  })?.[1];

/** The platform admin: only the configured human identities, only through `/admin`. */
export const adminPlugin = {
  name: 'merv-admin',
  Config: z
    .object({ admins: z.array(identity).default([]) })
    .strict()
    .default({}),
  inject: ['api', 'state'],
  async apply(ctx: Context, config: { admins: AdminIdentity[] }) {
    if (!config.admins.length) return;
    const state: State = ctx.get('state')!;
    await state.migrate('admin', auditMigrations);
    const env: AdminEnv = { ctx, state, audit: new AdminAudit(state), admins: config.admins };
    const routes: AdminRoutes = {
      'GET /admin/experiments': async () => await adminOverview(env.state, env.admins),
    };
    ctx.effect(() =>
      ctx.api.mount('/admin', async (req, res, r) => {
        const who = adminOf(r.principal, env.admins);
        check(who, 'forbidden', 'Platform administrator access required', 403);
        const route = match(routes, req.method ?? 'GET', r.url.pathname);
        if (!route) throw new MervError('not_found', 'Route not found', 404);
        res.setHeader('Cache-Control', 'private, no-store');
        return await route(r, who);
      }),
    );
  },
};

export default adminPlugin;
