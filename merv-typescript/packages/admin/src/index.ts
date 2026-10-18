import type { Context } from 'cordis';
import { z } from 'zod';
import { check, MervError, type PlatformDirectory, type State } from '@merv/contracts';
import { personName } from '@merv/contracts/text';
import type { ApiPrincipal, ApiRequest } from '@merv/api/types';
import { AdminAudit, auditMigrations } from './audit.js';
import { adminCredentials, credentialMigrations } from './credentials.js';
import { creditRoutes } from './credits.js';
import { platformRead } from './platform.js';
import { workRoutes } from './work.js';

const identity = z
  .object({
    issuer: z.string().min(1),
    subject: z.string().min(1),
    label: z.string().min(1).max(254).optional(),
  })
  .strict();
export type AdminIdentity = z.infer<typeof identity>;

/** The configured admin a verified human principal is, if any. */
export function adminOf(
  principal: ApiPrincipal | undefined,
  admins: readonly AdminIdentity[],
): AdminIdentity | undefined {
  if (principal?.kind !== 'user' || !('user' in principal)) return undefined;
  const { issuer, subject } = principal.user;
  return admins.find((a) => a.issuer === issuer && a.subject === subject);
}
/** A person's name on every admin page: their configured admin label, else a name one of their
 *  project actors goes by that is neither their subject nor an identifier. */
export const personLabel = (
  admins: readonly AdminIdentity[],
  { issuer, subject, actors }: PlatformDirectory['people'][number],
) =>
  admins.find((a) => a.issuer === issuer && a.subject === subject)?.label ??
  actors.find(({ name }) => name !== subject && personName(name))?.name;

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
  inject: ['state'],
  async apply(ctx: Context, config: { admins: AdminIdentity[] }) {
    if (!config.admins.length) return;
    const state: State = ctx.state;
    await state.migrate('admin', { ...auditMigrations, ...credentialMigrations });
    const audit = new AdminAudit(state);
    // The admin is a page of the API: a composition without it has nothing to serve.
    ctx.inject(['api', 'scope', 'tools'], (ctx) => {
      const env: AdminEnv = { ctx, state, audit, admins: config.admins };
      const routes: AdminRoutes = {
        ...workRoutes(env),
        ...platformRead(env),
        ...creditRoutes(env),
        'GET /admin/credentials': async () => await adminCredentials(env),
      };
      ctx.effect(() =>
        ctx.api.mount('/admin', async (req, _res, r) => {
          const who = adminOf(r.principal, env.admins);
          check(who, 'forbidden', 'Platform administrator access required', 403);
          const route = match(routes, req.method ?? 'GET', r.url.pathname);
          if (!route) throw new MervError('not_found', 'Route not found', 404);
          return await route(r, who);
        }),
      );
    });
  },
};

export default adminPlugin;
