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
import type { AdminCredits, CreditUse, PersonCredits } from '@merv/admin/models';
import type { ApiRequest, MountHandler } from '@merv/api/types';
import { personKey } from '@merv/fleet/model-ledger';
import { ProjectScope } from '@merv/scope';
import host from '@merv/sandboxes/host';
import { SandboxesPeople } from '@merv/sandboxes/people';
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
    const { sbxAuth: auth, sbxAccounts: accounts, sbxBilling: billing, sbxProviders } = ctx;
    ctx.provide(
      'sandboxesPeople',
      new SandboxesPeople({ auth, accounts, billing, providers: sbxProviders }, {}),
    );
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
  /** A verified sign-in: a person of the directory. */
  const signIn = (subject: string) =>
    ctx.scope.members.acceptVerifiedIdentity({
      issuer,
      subject,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  const audit = () =>
    state.read((sql) =>
      sql.all<{ subject: string; action: string; target: string; detail_json: string }>(
        'SELECT subject,action,target,detail_json FROM admin_audit ORDER BY at,id',
      ),
    );
  return { ctx, state, call, refused, signIn, audit };
}
const keyOf = (subject: string) => personKey({ issuer, subject }, { projectId: '', actorId: '' });
const drawer = (subject: string) =>
  `/admin/credits/people/${encodeURIComponent(`${issuer}|${subject}`)}`;
/** UTC day `offset` days from today's. */
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
/** Each window's start, as the drawer asks its owners: today, 7 days, 30 days, all time. */
const windows = () => ({ [day(0)]: 1, [day(-6)]: 2, [day(-29)]: 3, '1970-01-01': 4 });

test('the list and the drawer read each credit type from its owner per window, and Sandboxes with no lock or write', async (t) => {
  const f = await fixture(t);
  await f.signIn('alice');
  await f.signIn('bob');
  // Alice signed in to Sandboxes, with her own account; Bob has none yet.
  const person = await f.ctx.sbxAuth.persons.ensureIdentity({
    issuer,
    subject: 'alice',
    displayName: 'Alice',
  });
  const [own] = await f.ctx.sbxAccounts.accountsOf(person.id);
  await f.call('POST', '/admin/credits/grants', {
    id: 'g1',
    person: `${issuer}|alice`,
    provider: 'fake',
    amount: '10',
    validFrom,
    reason: 'Welcome credit',
  });
  // Started two days ago, the schedule has three periods due that nothing has issued yet.
  await f.call('POST', '/admin/credits/schedules', {
    id: 's1',
    person: `${issuer}|alice`,
    provider: 'fake',
    amount: '1',
    cadence: 'daily',
    startsAt: new Date(Date.now() - 2 * 86_400_000 - 1000).toISOString(),
    validityPeriods: null,
    enabled: true,
  });
  // Pi and Fleet answer each window they are asked for: its number, from 1 (today) to 4 (all).
  const asked: string[] = [];
  const reading = (owner: string, from: string, to: string) => {
    asked.push(`${owner} ${from} ${to}`);
    return windows()[from]!;
  };
  const alice = keyOf('alice');
  f.ctx.provide('pi', {
    tokensUsed: async (keys: string[], from: string, to: string) => {
      const n = reading('pi', from, to);
      return keys.map((k) => ({ used: k === alice ? 100 * n : 0, limit: 1000, own: k === alice }));
    },
  });
  f.ctx.provide('fleet', {
    peopleUsage: async (keys: string[], from: string, to: string) => {
      const n = reading('fleet', from, to);
      return keys.map((k) => ({
        usd: { used: k === alice ? 1.5 * n : 0, limit: 20, own: false },
        tokens: { used: k === alice ? 10 * n : 0, limit: 50, own: false },
      }));
    },
  });
  const issued = () => f.ctx.sbxDb.get('SELECT count(*)::int AS n FROM infra_credit_grants');
  const before = await issued();
  const [list, drawn, none] = await f.ctx.sbxDb.transaction(async (q) => {
    // Holding the account and operator locks would stall anything that takes them.
    await f.ctx.sbxAccounts.lock(q, own!.id);
    await advisoryXactLock(q, f.ctx.sbxDb.lockText('operator-credit-admission'), 0);
    return [
      (await f.call('GET', '/admin/credits')) as AdminCredits,
      (await f.call('GET', drawer('alice'))) as PersonCredits,
      (await f.call('GET', drawer('bob'))) as PersonCredits,
    ];
  });
  assert.deepEqual(await issued(), before);
  const tomorrow = day(1);
  assert.deepEqual(asked, [
    // The list asks for today alone, the drawer for each window, every one ending tomorrow.
    ...['pi', 'fleet'].map((owner) => `${owner} ${day(0)} ${tomorrow}`),
    ...['pi', 'fleet'].flatMap((owner) =>
      Object.keys(windows()).map((from) => `${owner} ${from} ${tomorrow}`),
    ),
    ...['pi', 'fleet'].flatMap((owner) =>
      Object.keys(windows()).map((from) => `${owner} ${from} ${tomorrow}`),
    ),
  ]);
  const used = (n: number) => ({ day: n, week: 2 * n, month: 3 * n, total: 4 * n });
  const kinds: CreditUse[] = [
    {
      kind: 'agent-tokens',
      label: 'Agent tokens',
      unit: 'tokens',
      limit: 1000,
      own: true,
      used: used(100),
      left: 900,
    },
    {
      kind: 'fleet-tokens',
      label: 'Fleet agent tokens',
      unit: 'tokens',
      limit: 50,
      own: false,
      used: used(10),
      left: 40,
    },
    {
      kind: 'fleet-usd',
      label: 'Fleet machines',
      unit: 'usd',
      limit: 20,
      own: false,
      used: used(1.5),
      left: 18.5,
    },
    // The grant and the three periods due: granted is the provider's limit, available what is left.
    {
      kind: 'provider:fake',
      label: 'Fake',
      unit: 'usd',
      limit: 13,
      own: false,
      used: used(0),
      left: 13,
    },
  ];
  const { settlements, pools, account_id, currency, ...held } =
    await f.ctx.sbxBilling.credits.report(own!.id);
  // report() issues the due periods now; only their creation time can differ from the drawer.
  const issuedAs = (grants: PersonCredits['grants']) =>
    grants.map(({ created_at, ...grant }) => grant);
  assert.deepEqual(
    { ...drawn, grants: issuedAs(drawn.grants) },
    {
      person: { key: `${issuer}|alice`, label: 'Alice' },
      kinds,
      grants: issuedAs(held.grants),
      schedules: held.schedules,
    },
  );
  // A person without an account sees every connected provider, with nothing granted.
  assert.deepEqual(none, {
    person: { key: `${issuer}|bob`, label: 'Unnamed' },
    kinds: [
      ...kinds.slice(0, 3).map((kind) => ({
        ...kind,
        own: false,
        used: used(0),
        left: kind.limit,
      })),
      { ...kinds[3]!, limit: 0, left: 0 },
    ],
    grants: [],
    schedules: [],
  });
  // The list: one row per person with today's use of each type.
  assert.deepEqual(
    list.people.map(({ kinds, ...person }) => [person, kinds]),
    [drawn, none].map(({ person, kinds }) => [
      person,
      kinds.map(({ used, ...kind }) => ({ ...kind, used: used.day })),
    ]),
  );
});

test('credit writes land in Sandboxes through CreditService and in the admin audit log', async (t) => {
  const f = await fixture(t);
  await f.signIn('dave');
  const person = `${issuer}|dave`;
  const grant = { id: 'g1', person, provider: 'fake', amount: '2.25', validFrom, reason: 'Try' };
  assert.deepEqual(await f.call('POST', '/admin/credits/grants', grant), { id: 'g1' });
  const { accountId } = (await f.ctx.sandboxesPeople.accountOf({ issuer, subject: 'dave' }))!;
  // The same id with the same terms is the same grant; different terms are refused.
  await f.call('POST', '/admin/credits/grants', grant);
  await assert.rejects(
    f.call('POST', '/admin/credits/grants', { ...grant, amount: '3' }),
    f.refused('sandbox_validation', 400),
  );
  const schedule = {
    id: 's1',
    person,
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
      ['founder', 'credits.grant', person],
      ['founder', 'credits.grant', person],
      ['founder', 'credits.schedule', person],
      ['founder', 'credits.schedule', person],
      ['founder', 'credits.revoke', 'g1'],
    ],
  );
  assert.deepEqual(JSON.parse(audit[0]!.detail_json), grant);
});

test('a grant may name a person: it lands on their own account, which the bridge makes sure of', async (t) => {
  const f = await fixture(t);
  await f.signIn('carol');
  const grant = {
    id: 'g1',
    person: `${issuer}|carol`,
    provider: 'fake',
    amount: '5',
    validFrom,
    reason: 'Base credit',
  };
  // Granted to the person, it lands on their own account, made now, which may then spend it.
  assert.deepEqual(await f.call('POST', '/admin/credits/grants', grant), { id: 'g1' });
  const { grants, kinds } = (await f.call('GET', drawer('carol'))) as PersonCredits;
  const { accountId } = (await f.ctx.sandboxesPeople.accountOf({ issuer, subject: 'carol' }))!;
  assert.deepEqual(
    (await f.ctx.sbxProviders.connections.listEntitlements({ accountId })).map((e) => [
      e.scope,
      e.enabled,
    ]),
    [['account', true]],
  );
  assert.deepEqual(
    grants.map((g) => [g.id, g.amount, g.available]),
    [['g1', '5', '5']],
  );
  assert.deepEqual(
    kinds.map(({ kind, limit, left }) => [kind, limit, left]),
    [['provider:fake', 5, 5]],
  );
  const [row] = await f.audit();
  assert.deepEqual([row!.action, row!.target], ['credits.grant', grant.person]);
  assert.deepEqual(JSON.parse(row!.detail_json), grant);
  // An account instead of a person, or no person, is refused; so is a person nobody signed in as.
  const { person: _, ...unnamed } = grant;
  for (const body of [{ ...unnamed, accountId }, unnamed])
    await assert.rejects(
      f.call('POST', '/admin/credits/grants', body),
      f.refused('invalid_input', 400),
    );
  await assert.rejects(
    f.call('POST', '/admin/credits/grants', { ...grant, person: `${issuer}|nobody` }),
    f.refused('not_found', 404),
  );
  assert.equal((await f.audit()).length, 1);
});

test('a person’s own limits are set and cleared in their owners, each recorded as credits.limit', async (t) => {
  const f = await fixture(t);
  await f.signIn('dana');
  const path = `${drawer('dana')}/limits`;
  await assert.rejects(
    f.call('POST', path, { kind: 'agent-tokens', limit: 5 }),
    f.refused('credits_unavailable', 503),
  );
  const set: unknown[] = [];
  f.ctx.provide('pi', { setTokenLimit: async (...limit: unknown[]) => void set.push(limit) });
  f.ctx.provide('fleet', { setPersonLimit: async (...limit: unknown[]) => void set.push(limit) });
  const bodies = [
    { kind: 'agent-tokens', limit: 2_000_000 },
    { kind: 'fleet-tokens', limit: 500 },
    { kind: 'fleet-usd', limit: 12.5 },
    { kind: 'fleet-usd', limit: null },
  ];
  for (const body of bodies) assert.deepEqual(await f.call('POST', path, body), body);
  const key = keyOf('dana');
  assert.deepEqual(set, [
    [key, 2_000_000],
    [key, 'tokens', 500],
    [key, 'usd', 12.5],
    [key, 'usd', null],
  ]);
  // A value its owner would not take is refused before the owner is asked.
  for (const body of [
    { kind: 'agent-tokens', limit: 1.5 },
    { kind: 'fleet-tokens', limit: 0 },
    { kind: 'fleet-usd', limit: -1 },
    { kind: 'provider:fake', limit: 5 },
    { kind: 'fleet-usd' },
  ])
    await assert.rejects(f.call('POST', path, body), f.refused('invalid_input', 400));
  await assert.rejects(
    f.call('POST', `${drawer('nobody')}/limits`, bodies[0]),
    f.refused('not_found', 404),
  );
  assert.equal(set.length, 4);
  // Four writes may share a millisecond, which orders the log no further.
  const sorted = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).sort();
  assert.deepEqual(
    sorted((await f.audit()).map((row) => [row.action, row.target, JSON.parse(row.detail_json)])),
    sorted(bodies.map((body) => ['credits.limit', `${issuer}|dana`, body])),
  );
});

test('only an admin may read or assign credits, and only real providers, accounts and amounts', async (t) => {
  const f = await fixture(t);
  await f.signIn('erin');
  const person = `${issuer}|erin`;
  const grant = { id: 'g1', person, provider: 'fake', amount: '1', validFrom, reason: 'Trial' };
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
    await assert.rejects(
      f.call('GET', drawer('founder'), undefined, who),
      f.refused('forbidden', 403),
    );
    await assert.rejects(
      f.call('POST', `${drawer('founder')}/limits`, { kind: 'fleet-usd', limit: 9 }, who),
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
    f.call('POST', '/admin/credits/grants', { ...grant, person: `${issuer}|nobody` }),
    f.refused('not_found', 404),
  );
  await assert.rejects(
    f.call('POST', '/admin/credits/grants/missing/revoke'),
    f.refused('sandbox_not_found', 404),
  );
  const own = await f.ctx.sandboxesPeople.accountOf({ issuer, subject: 'erin' });
  assert.deepEqual((await f.ctx.sbxBilling.credits.report(own!.accountId)).grants, []);
  assert.deepEqual(await f.state.read((sql) => sql.all('SELECT id FROM admin_audit')), []);
});

test('without Sandboxes the credit routes answer 503 credits_unavailable', async (t) => {
  const f = await fixture(t, false);
  for (const [method, path] of [
    ['GET', '/admin/credits'],
    ['GET', drawer('founder')],
    ['POST', '/admin/credits/grants'],
    ['POST', '/admin/credits/schedules'],
    ['POST', '/admin/credits/grants/g1/revoke'],
  ])
    await assert.rejects(f.call(method!, path!, {}), f.refused('credits_unavailable', 503));
});
