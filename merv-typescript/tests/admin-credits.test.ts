import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Context } from 'cordis';
import type { ZodType } from 'zod';
import { createService, MervError, type Principal } from '@merv/contracts';
import { adminPlugin } from '@merv/admin';
import type { AdminCredits } from '@merv/admin/models';
import type { ApiRequest, MountHandler } from '@merv/api/types';
import { personKey } from '@merv/fleet/model-ledger';
import { ProjectScope } from '@merv/scope';
import host from '@merv/sandboxes/host';
import { migrate, openDatabase } from '@sandboxes/db';
import { advisoryXactLock, Decimal } from '@sandboxes/kernel';
import { openState, postgresUrl, schemaFor } from './fixtures/state.js';

const validFrom = '2026-01-01T00:00:00Z';
const issuer = 'https://identity.example';
const admin = { issuer, subject: 'founder' };
const human = (subject: string): Principal => ({
  kind: 'user',
  user: { issuer, subject, createdAt: new Date(0).toISOString() },
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});

/** Merv's state and Scope, the in-process Sandboxes host, and the admin plugin's `/admin` mount. */
async function fixture(t: TestContext, sandboxes = true) {
  const state = await openState();
  const ctx = new Context();
  let route: MountHandler | undefined;
  ctx.provide('state', state);
  ctx.provide('scope', await createService(new ProjectScope(state)));
  ctx.provide('api', {
    mount: (_prefix: string, handler: MountHandler) => ((route = handler), () => {}),
  });
  ctx.provide('tools', { registerCallerRules: () => () => {} });
  t.after(async () => await state.close());
  if (sandboxes) {
    const schema = schemaFor();
    const dataDir = mkdtempSync(join(tmpdir(), 'merv-admin-credits-'));
    const db = await openDatabase({ url: postgresUrl, schema });
    await migrate(db, { schemaExplicit: true });
    await db.close();
    process.env.MERV_TEST_SANDBOXES_VAULT_KEY = Buffer.alloc(32, 7).toString('base64url');
    const fiber = ctx.plugin(
      host,
      host.Config.parse({
        databaseUrlEnv: 'MERV_TEST_POSTGRES_URL',
        schema,
        vaultKeyEnv: 'MERV_TEST_SANDBOXES_VAULT_KEY',
        publicOrigin: 'https://sandboxes.example',
        dataDir,
        relayEvents: false,
      }),
    );
    await fiber.await();
    t.after(async () => {
      await fiber.dispose();
      rmSync(dataDir, { recursive: true, force: true });
    });
    await ctx.sbxProviders.connections.registerIn(ctx.sbxDb, {
      id: 'cloud',
      plugin: 'fake',
      cloudAccount: 'cloud',
    });
  }
  await ctx.plugin(adminPlugin, { admins: [admin] });
  const call = async (method: string, path: string, body?: unknown, who = human('founder')) =>
    await route!(
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
    );
  const refused = (code: string, status: number) => (error: unknown) =>
    error instanceof MervError && error.code === code && error.status === status;
  return { ctx, state, call, refused };
}

test('credits read per person, account and provider, as report() computes them, with no lock or write', async (t) => {
  const f = await fixture(t);
  const scope = f.ctx.scope;
  const alice = await scope.members.acceptVerifiedIdentity({
    issuer,
    subject: 'alice',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const project = await scope.members.createProject(alice, { name: 'Ledger', requestId: 'p' });
  // Alice signed in to Sandboxes, with her own account; her project pays from an operator's.
  const person = await f.ctx.sbxAuth.persons.ensureIdentity({
    issuer,
    subject: 'alice',
    displayName: 'Alice',
  });
  const [own] = await f.ctx.sbxAccounts.accountsOf(person.id);
  const payer = await f.ctx.sbxAccounts.ensureNativeNamespace('ops');
  await f.ctx.sbxDb.transaction((q) =>
    f.ctx.sbxAccounts.setLink(q, 'ops', {
      projectId: project.id,
      memberId: payer.default_member_id,
    }),
  );
  const credits = f.ctx.sbxBilling.credits;
  await f.call('POST', '/admin/credits/grants', {
    id: 'g1',
    accountId: own!.id,
    provider: 'fake',
    amount: '10',
    validFrom,
    reason: 'Welcome credit',
  });
  await f.call('POST', '/admin/credits/grants', {
    id: 'g2',
    accountId: payer.account_id,
    provider: 'fake',
    amount: '4.5',
    validFrom,
    reason: 'Pilot',
  });
  await f.call('POST', '/admin/credits/grants/g2/revoke');
  // Started two days ago, the schedule has three periods due that nothing has issued yet.
  const day = 86_400_000;
  await f.call('POST', '/admin/credits/schedules', {
    id: 's1',
    accountId: payer.account_id,
    provider: 'fake',
    amount: '1',
    cadence: 'daily',
    startsAt: new Date(Date.now() - 2 * day - 1000).toISOString(),
    validityPeriods: null,
    enabled: true,
  });
  // A budget cap is its own limit, listed beside the credits and never in them.
  await f.ctx.sbxBilling.setPolicy(payer.account_id, 'ops-cap', {
    scope: 'namespace',
    target: 'ops',
    window: 'month',
    metric: 'money',
    currency: 'USD',
    cap: Decimal.fromInt(50),
    provider: 'fake',
    source: null,
  });
  // Fleet reports each person by the key it charges them under; Pi is not loaded here.
  f.ctx.provide('fleet', {
    peopleToday: async (keys: string[]) =>
      keys.map((key) => ({ person: key, usd: 1.5, usdCap: 20, tokens: { used: 3, limit: 9 } })),
  });
  const issued = () => f.ctx.sbxDb.get('SELECT count(*)::int AS n FROM infra_credit_grants');
  const before = await issued();
  const view = (await f.ctx.sbxDb.transaction(async (q) => {
    await f.ctx.sbxAccounts.lock(q, payer.account_id);
    await advisoryXactLock(q, f.ctx.sbxDb.lockText('operator-credit-admission'), 0);
    return await f.call('GET', '/admin/credits');
  })) as AdminCredits;
  assert.deepEqual(await issued(), before);
  assert.deepEqual(view.providers, ['fake']);
  assert.deepEqual(view.unavailable, ['pi']);
  const [listed] = view.people;
  assert.deepEqual(
    { ...listed, fleet: listed!.fleet?.person },
    {
      label: 'Alice',
      issuer,
      subject: 'alice',
      accounts: [{ accountId: own!.id, role: 'admin' }],
      fleet: personKey({ issuer, subject: 'alice' }, { projectId: '', actorId: '' }),
      pi: null,
    },
  );
  const account = (id: string) => view.accounts.find((a) => a.accountId === id)!;
  assert.deepEqual(
    account(payer.account_id).budgets.map((b) => [b.id, b.window, b.cap, b.provider]),
    [['ops-cap', 'month', '50', 'fake']],
  );
  assert.deepEqual(account(payer.account_id).projects, [{ projectId: project.id, name: 'Ledger' }]);
  // report() issues the due periods now; only their creation time can differ from the view.
  const issuedAs = (grants: AdminCredits['accounts'][number]['grants']) =>
    grants.map(({ created_at, ...grant }) => grant);
  for (const id of [own!.id, payer.account_id]) {
    const { pools, grants, schedules } = await credits.report(id);
    assert.deepEqual(
      { ...account(id), grants: issuedAs(account(id).grants) },
      { ...account(id), pools, schedules, grants: issuedAs(grants) },
    );
  }
  assert.deepEqual(account(payer.account_id).pools, [
    {
      provider: 'fake',
      granted: '7.5',
      used: '0',
      reserved: '0',
      available: '3',
      expired: '0',
      revoked: '4.5',
    },
  ]);
});

test('credit writes land in Sandboxes through CreditService and in the admin audit log', async (t) => {
  const f = await fixture(t);
  const { account_id: accountId } = await f.ctx.sbxAccounts.ensureNativeNamespace('team');
  const grant = { id: 'g1', accountId, provider: 'fake', amount: '2.25', validFrom, reason: 'Try' };
  assert.deepEqual(await f.call('POST', '/admin/credits/grants', grant), { id: 'g1' });
  // The same id with the same terms is the same grant; different terms are refused.
  await f.call('POST', '/admin/credits/grants', grant);
  await assert.rejects(
    f.call('POST', '/admin/credits/grants', { ...grant, amount: '3' }),
    f.refused('sandbox_validation', 400),
  );
  const schedule = {
    id: 's1',
    accountId,
    provider: 'fake',
    amount: '5',
    cadence: 'monthly',
    startsAt: '2030-01-01T00:00:00Z',
    validityPeriods: 1,
    enabled: true,
  };
  await f.call('POST', '/admin/credits/schedules', schedule);
  await f.call('POST', '/admin/credits/schedules', { ...schedule, enabled: false });
  await f.call('POST', '/admin/credits/grants/g1/revoke');
  const report = await f.ctx.sbxBilling.credits.report(accountId);
  assert.deepEqual(
    report.grants.map((g) => [g.id, g.amount, !!g.revoked_at]),
    [['g1', '2.25', true]],
  );
  assert.deepEqual(
    report.schedules.map((s) => [s.id, s.cadence, s.enabled]),
    [['s1', 'monthly', false]],
  );
  const audit = await f.state.read((sql) =>
    sql.all<{
      issuer: string;
      subject: string;
      action: string;
      target: string;
      detail_json: string;
    }>('SELECT issuer,subject,action,target,detail_json FROM admin_audit ORDER BY at,id'),
  );
  assert.deepEqual(
    audit.map((row) => [row.subject, row.action, row.target]),
    [
      ['founder', 'credits.grant', accountId],
      ['founder', 'credits.grant', accountId],
      ['founder', 'credits.schedule', accountId],
      ['founder', 'credits.schedule', accountId],
      ['founder', 'credits.revoke', 'g1'],
    ],
  );
  assert.deepEqual(JSON.parse(audit[0]!.detail_json), grant);
});

test('only an admin may read or assign credits, and only real providers, accounts and amounts', async (t) => {
  const f = await fixture(t);
  const { account_id: accountId } = await f.ctx.sbxAccounts.ensureNativeNamespace('team');
  const grant = { id: 'g1', accountId, provider: 'fake', amount: '1', validFrom, reason: 'Trial' };
  for (const who of [
    human('someone'),
    { kind: 'key', keyId: 'key', issuer, subject: 'founder' } as unknown as Principal,
  ]) {
    await assert.rejects(
      f.call('GET', '/admin/credits', undefined, who),
      f.refused('forbidden', 403),
    );
    await assert.rejects(
      f.call('POST', '/admin/credits/grants', grant, who),
      f.refused('forbidden', 403),
    );
  }
  // Sandboxes refuses the values; the admin, only a body it cannot read.
  for (const body of [{ provider: 'modal' }, { amount: '0' }, { amount: '1.1234567' }])
    await assert.rejects(
      f.call('POST', '/admin/credits/grants', { ...grant, ...body }),
      f.refused('sandbox_validation', 400),
    );
  for (const body of [{ amount: '-1' }, { amount: '1e3' }, { validFrom: undefined }])
    await assert.rejects(
      f.call('POST', '/admin/credits/grants', { ...grant, ...body }),
      f.refused('invalid_input', 400),
    );
  await assert.rejects(
    f.call('POST', '/admin/credits/grants', { ...grant, accountId: 'acct_missing' }),
    f.refused('sandbox_not_found', 404),
  );
  await assert.rejects(
    f.call('POST', '/admin/credits/grants/missing/revoke'),
    f.refused('sandbox_not_found', 404),
  );
  assert.deepEqual((await f.ctx.sbxBilling.credits.report(accountId)).grants, []);
  assert.deepEqual(await f.state.read((sql) => sql.all('SELECT id FROM admin_audit')), []);
});

test('without Sandboxes the credit routes answer 503 credits_unavailable', async (t) => {
  const f = await fixture(t, false);
  for (const [method, path] of [
    ['GET', '/admin/credits'],
    ['POST', '/admin/credits/grants'],
    ['POST', '/admin/credits/schedules'],
    ['POST', '/admin/credits/grants/g1/revoke'],
  ])
    await assert.rejects(f.call(method!, path!, {}), f.refused('credits_unavailable', 503));
});
