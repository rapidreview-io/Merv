/**
 * The in-process Sandboxes host on a fresh schema, and the admin plugin's `/admin` mount called
 * directly, as the admin and Sandboxes tests stand them up.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { Context } from 'cordis';
import type { ZodType } from 'zod';
import { MervError, type Principal, type State } from '@merv/contracts';
import { adminPlugin, type AdminIdentity } from '@merv/admin';
import type { ApiRequest, MountHandler } from '@merv/api/types';
import host from '@merv/sandboxes/host';
import { migrate, openDatabase } from '@sandboxes/db';
import { postgresUrl, schemaFor } from './state.js';

/** A migrated Sandboxes schema, a data directory the caller removes, and the host's config on both. */
export async function hostConfig(vaultKeyEnv: string, extra: Record<string, unknown> = {}) {
  const schema = schemaFor();
  const db = await openDatabase({ url: postgresUrl, schema });
  await migrate(db, { schemaExplicit: true });
  await db.close();
  const dataDir = mkdtempSync(join(tmpdir(), 'merv-sandboxes-host-'));
  const config = host.Config.parse({
    databaseUrlEnv: 'MERV_TEST_POSTGRES_URL',
    schema,
    vaultKeyEnv,
    publicOrigin: 'https://sandboxes.example',
    dataDir,
    relayEvents: false,
    ...extra,
  });
  return { dataDir, schema, config };
}

/** The host started on `ctx`; after the test it is disposed, then its data directory removed. */
export async function startHost(
  t: TestContext,
  ctx: Context,
  vaultKeyEnv: string,
  extra: Record<string, unknown> = {},
) {
  const { dataDir, config } = await hostConfig(vaultKeyEnv, extra);
  const fiber = ctx.plugin(host, config);
  t.after(async () => {
    await fiber.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await fiber.await();
  return fiber;
}

/** This identity signed in as a person, for the next hour. */
export const person = (user: AdminIdentity): Principal => ({
  kind: 'user',
  user: { ...user, createdAt: new Date(0).toISOString() },
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});

/** The admin plugin on `ctx` and a call to its `/admin` mount, made as the first admin by default. */
export async function adminRoutes(ctx: Context, admins: AdminIdentity[]) {
  let route: MountHandler | undefined;
  ctx.provide('api', {
    mount: (_prefix: string, handler: MountHandler) => ((route = handler), () => {}),
    stop: async () => {}, // the app stops whatever api it finds
  });
  ctx.provide('tools', { registerCallerRules: () => () => {} });
  await ctx.plugin(adminPlugin, { admins });
  const first = person(admins[0]!);
  return async <T = unknown>(method: string, path: string, body?: unknown, who = first) =>
    (await route!(
      { method } as IncomingMessage,
      { setHeader() {} } as unknown as ServerResponse,
      {
        url: new URL(path, 'https://merv.example'),
        principal: who,
        json: async (schema: ZodType) => {
          const parsed = schema.safeParse(body);
          if (!parsed.success) throw new MervError('invalid_input', 'Invalid input', 400);
          return parsed.data;
        },
      } as ApiRequest,
    )) as T;
}

/** Matches a MervError of this code and status, for `assert.rejects`. */
export const refused = (code: string, status: number) => (error: unknown) =>
  error instanceof MervError && error.code === code && error.status === status;

/** The admin audit log, oldest first. */
export const adminAudit = (state: State) =>
  state.read((sql) =>
    sql.all<Record<'subject' | 'action' | 'target' | 'detail_json', string>>(
      'SELECT subject,action,target,detail_json FROM admin_audit ORDER BY at,id',
    ),
  );
