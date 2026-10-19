import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Context, type Fiber } from 'cordis';
import { createService, digest, MervError } from '@merv/contracts';
import { sandboxIntegrationPlugin } from '@merv/sandboxes/integration';
import { sandboxesPeoplePlugin, type SandboxesPeople } from '@merv/sandboxes/people';
import { ProjectScope } from '@merv/scope';
import { linkProject, projectNamespace } from '@sandboxes/auth';
import { Decimal, Instant } from '@sandboxes/kernel';
import { startHost } from './fixtures/admin.js';
import { openState } from './fixtures/state.js';

const issuer = 'https://identity.example/auth/v1';
const welcome = (provider: string, subject: string) =>
  `welcome:${provider}:${digest([issuer, subject]).slice(0, 40)}`;

/** Merv's Scope beside the in-process Sandboxes host, whose operator has connected `fake`. */
async function fixture(t: TestContext) {
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  const ctx = new Context();
  ctx.provide('scope', scope);
  // After the test, the people go before the host they use, and Merv's state after both.
  let people: Fiber | undefined;
  t.after(async () => await people?.dispose());
  process.env.MERV_TEST_SANDBOXES_VAULT_KEY = Buffer.alloc(32, 7).toString('base64url');
  await startHost(t, ctx, 'MERV_TEST_SANDBOXES_VAULT_KEY');
  t.after(async () => await state.close());
  await ctx.sbxProviders.connections.registerIn(ctx.sbxDb, {
    id: 'cloud',
    plugin: 'fake',
    cloudAccount: 'cloud',
  });
  const logged: string[] = [];
  t.mock.method(process.stderr, 'write', (line: string) => logged.push(line) > 0);
  return {
    ctx,
    scope,
    /** The bridge's people, (re)started with these credits; settled once its backfill is done. */
    start: async (newPersonCredits: Record<string, string>) => {
      await people?.dispose();
      people = ctx.plugin(sandboxesPeoplePlugin, { newPersonCredits });
      await people.await();
      await service().settled();
      return service();
    },
    signIn: (subject: string) =>
      scope.members.acceptVerifiedIdentity({
        issuer,
        subject,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    grants: async (accountId: string) =>
      (await ctx.sbxBilling.credits.report(accountId)).grants.map((g) => [g.id, g.amount]),
    logs: (event: string) => logged.filter((line) => line.includes(`"event":"${event}"`)),
  };
  function service() {
    return ctx.sandboxesPeople as SandboxesPeople;
  }
}

test('ensure is idempotent: one person, their own account with them its admin, one grant', async (t) => {
  const f = await fixture(t);
  const people = await f.start({ fake: '10' });
  const first = await people.ensure({ issuer, subject: 'alice', label: 'Alice' });
  const again = await Promise.all([
    people.ensure({ issuer, subject: 'alice' }),
    people.ensure({ issuer, subject: 'alice', label: 'Someone else' }),
  ]);
  assert.deepEqual(again, [first, first]);
  const person = (await f.ctx.sbxAuth.persons.byIdentity(issuer, 'alice'))!;
  assert.equal(person.display_name, 'Alice');
  assert.deepEqual(
    (await f.ctx.sbxAccounts.accountsOf(person.id)).map((a) => [a.id, a.role]),
    [[first.accountId, 'admin']],
  );
  assert.equal(
    (await f.ctx.sbxAccounts.namespace(person.home_namespace!)).account_id,
    first.accountId,
  );
  assert.deepEqual(await f.grants(first.accountId), [[welcome('fake', 'alice'), '10']]);
  // Welcome credit comes with access to spend it.
  assert.deepEqual(
    (await f.ctx.sbxProviders.connections.listEntitlements({ accountId: first.accountId })).map(
      (e) => [e.connection_id, e.enabled],
    ),
    [['cloud', true]],
  );
  const [grant] = (await f.ctx.sbxBilling.credits.report(first.accountId)).grants;
  assert.deepEqual([grant!.valid_from, grant!.expires_at], [person.created_at.toJSON(), null]);
  // Another person is another account, even when their first two ensures race.
  const [bob, also] = await Promise.all([
    people.ensure({ issuer, subject: 'bob' }),
    people.ensure({ issuer, subject: 'bob' }),
  ]);
  assert.deepEqual(also, bob);
  assert.notEqual(bob.accountId, first.accountId);
  assert.deepEqual(await f.grants(bob.accountId), [[welcome('fake', 'bob'), '10']]);
  // Sandboxes' refusal reaches Merv as a Merv error.
  await assert.rejects(
    people.ensure({ issuer, subject: 'x'.repeat(257) }),
    (error) => error instanceof MervError && error.code === 'sandbox_validation',
  );
});

test('credit comes with access to spend it; a disabled schedule and an access an operator revoked do not', async (t) => {
  const f = await fixture(t);
  const people = await f.start({});
  const { connections } = f.ctx.sbxProviders;
  const access = async (accountId: string) =>
    (await connections.listEntitlements({ accountId })).map((e) => [e.connection_id, e.enabled]);
  const now = Instant.parseIso(new Date().toISOString());
  const terms = { provider: 'fake', amount: Decimal.parse('1'), reason: 'More' };
  const alice = { issuer, subject: 'alice' };
  assert.equal(await people.accountOf(alice), null);
  const { accountId } = await people.ensure(alice);
  assert.deepEqual(await people.accountOf(alice), { accountId, name: null });
  assert.deepEqual(await access(accountId), []);
  await people.grant(alice, { ...terms, id: 'g1', validFrom: now, expiresAt: null });
  assert.deepEqual(await access(accountId), [['cloud', true]]);
  await connections.setEntitlement({ connectionId: 'cloud', accountId, enabled: false });
  await people.grant(alice, { ...terms, id: 'g2', validFrom: now, expiresAt: null });
  assert.deepEqual(await access(accountId), [['cloud', false]]);
  // Bob's first credit is a schedule saved disabled: his account is made, with no access.
  const bob = { issuer, subject: 'bob' };
  await people.schedule(bob, {
    ...terms,
    id: 's1',
    cadence: 'daily',
    startsAt: now,
    validityPeriods: null,
    endsAt: null,
    enabled: false,
  });
  assert.deepEqual(await access((await people.accountOf(bob))!.accountId), []);
});

test('a first sign-in makes the account; later sign-ins do not ask again', async (t) => {
  const f = await fixture(t);
  const people = await f.start({ fake: '10' });
  const heard: string[] = [];
  const stop = f.scope.members.onFirstSignIn((person) => heard.push(person.subject));
  // A listener's failure never fails the sign-in.
  f.scope.members.onFirstSignIn(() => {
    throw new Error('listener failed');
  });
  await f.signIn('carol');
  await f.signIn('carol');
  await people.settled();
  const own = await f.ctx.sbxAccounts.accountsOf(
    (await f.ctx.sbxAuth.persons.byIdentity(issuer, 'carol'))!.id,
  );
  assert.deepEqual(await f.grants(own[0]!.id), [[welcome('fake', 'carol'), '10']]);
  stop();
  await f.signIn('dave');
  await people.settled();
  assert.deepEqual(heard, ['carol']);
  assert.ok(await f.ctx.sbxAuth.persons.byIdentity(issuer, 'dave'));
});

test('start backfills everyone already signed in; one person failing stops no one', async (t) => {
  const f = await fixture(t);
  // Scope takes a longer subject than Sandboxes does.
  const unfit = 'b'.repeat(300);
  for (const subject of ['erin', unfit, 'frank']) await f.signIn(subject);
  await f.start({ fake: '5' });
  for (const subject of ['erin', 'frank']) {
    const person = (await f.ctx.sbxAuth.persons.byIdentity(issuer, subject))!;
    const [own] = await f.ctx.sbxAccounts.accountsOf(person.id);
    assert.deepEqual(await f.grants(own!.id), [[welcome('fake', subject), '5']]);
  }
  assert.equal(await f.ctx.sbxAuth.persons.byIdentity(issuer, unfit), null);
  assert.equal(f.logs('sandboxes.people.ensure_failed').length, 1);
  assert.match(f.logs('sandboxes.people.ensure_failed')[0]!, /invalid verified identity/);
});

test('without configured credits a person gets their account and no grant', async (t) => {
  const f = await fixture(t);
  const people = await f.start({});
  const { accountId } = await people.ensure({ issuer, subject: 'gina' });
  assert.ok((await f.ctx.sbxAccounts.get(accountId)).id);
  assert.deepEqual(await f.grants(accountId), []);
});

test('a provider without an operator connection is skipped, logged once, granted once connected', async (t) => {
  const f = await fixture(t);
  const people = await f.start({ fake: '10', lambda: '25' });
  const hal = await people.ensure({ issuer, subject: 'hal' });
  const ivy = await people.ensure({ issuer, subject: 'ivy' });
  for (const [subject, { accountId }] of [
    ['hal', hal],
    ['ivy', ivy],
  ] as const)
    assert.deepEqual(await f.grants(accountId), [[welcome('fake', subject), '10']]);
  assert.equal(f.logs('sandboxes.people.credits_skipped').length, 1);
  assert.match(f.logs('sandboxes.people.credits_skipped')[0]!, /"provider":"lambda"/);
  await f.ctx.sbxProviders.connections.registerIn(f.ctx.sbxDb, {
    id: 'lambda-labs',
    plugin: 'lambda',
    cloudAccount: 'lambda',
  });
  await people.ensure({ issuer, subject: 'hal' });
  assert.deepEqual((await f.grants(hal.accountId)).sort(), [
    [welcome('fake', 'hal'), '10'],
    [welcome('lambda', 'hal'), '25'],
  ]);
});

test('the welcome grant id never grants twice across restarts, even with new amounts', async (t) => {
  const f = await fixture(t);
  await f.signIn('jack');
  await f.start({ fake: '10' });
  const jack = await f.ctx.sbxAccounts.accountsOf(
    (await f.ctx.sbxAuth.persons.byIdentity(issuer, 'jack'))!.id,
  );
  // A restart backfills Jack again; the new amount is only for people new to it.
  const people = await f.start({ fake: '20' });
  assert.deepEqual(await f.grants(jack[0]!.id), [[welcome('fake', 'jack'), '10']]);
  await f.signIn('kate');
  await people.settled();
  const { accountId } = await people.ensure({ issuer, subject: 'kate' });
  assert.deepEqual(await f.grants(accountId), [[welcome('fake', 'kate'), '20']]);
  assert.equal(
    (await f.ctx.sbxDb.get<{ n: number }>('SELECT count(*)::int AS n FROM infra_credit_grants'))!.n,
    2,
  );
  assert.deepEqual(f.logs('sandboxes.people.ensure_failed'), []);
});

test('a project lives in its admin’s own account: linked at creation, moved with its namespace when the admin changes', async (t) => {
  const f = await fixture(t);
  const people = await f.start({});
  const alice = await f.signIn('alice');
  const project = await f.scope.members.createProject(alice, { name: 'Billed', requestId: 'r' });
  await people.settled();
  const own = async (subject: string) => (await people.accountOf({ issuer, subject }))!.accountId;
  const holder = async () => {
    const linked = (await f.ctx.sbxAccounts.linked(project.id))!;
    assert.equal(linked.name, projectNamespace(project.id));
    return linked.account_id;
  };
  assert.equal(await holder(), await own('alice'));
  // Linked there already, it is left alone.
  people.adminChanged(project.id, { issuer, subject: 'alice' });
  await f.scope.members.addMember(alice, project.id, { subject: 'bob', role: 'operator' });
  const bob = await f.signIn('bob');
  // Bob takes billing on; then hands it back, and Alice hands it to him again.
  await f.scope.members.setAdmin(bob, project.id, { issuer, subject: 'bob' });
  await people.settled();
  assert.equal(await holder(), await own('bob'));
  await f.scope.members.setAdmin(bob, project.id, { issuer, subject: 'alice' });
  await people.settled();
  assert.equal(await holder(), await own('alice'));
  await f.scope.members.setAdmin(alice, project.id, { issuer, subject: 'bob' });
  await people.settled();
  assert.equal(await holder(), await own('bob'));
  assert.equal(f.logs('sandboxes.projects.relinked').length, 3);
  assert.deepEqual(f.logs('sandboxes.projects.link_failed'), []);
});

test('start links every project to its admin; a project failing stops no other', async (t) => {
  const f = await fixture(t);
  const unfit = 'u'.repeat(300);
  const projects = [];
  for (const subject of ['erin', unfit, 'frank'])
    projects.push(
      await f.scope.members.createProject(await f.signIn(subject), { name: 'P', requestId: 'r' }),
    );
  await f.scope.credentials.bootstrap({ projectName: 'Unowned', actorName: 'Op' });
  const people = await f.start({});
  const linked = async (projectId: string) =>
    (await f.ctx.sbxAccounts.linked(projectId))?.account_id ?? null;
  assert.deepEqual(await Promise.all(projects.map((project) => linked(project.id))), [
    (await people.accountOf({ issuer, subject: 'erin' }))!.accountId,
    null,
    (await people.accountOf({ issuer, subject: 'frank' }))!.accountId,
  ]);
  assert.equal(f.logs('sandboxes.projects.link_failed').length, 1);
  assert.deepEqual(f.logs('sandboxes.projects.relinked'), []);
  // Linked by someone else since, the project stays where they put it across restarts.
  const erin = (await people.accountOf({ issuer, subject: 'erin' }))!.accountId;
  const { sbxDb: db, sbxAccounts: accounts, sbxClock: clock } = f.ctx;
  const linker = (await f.ctx.sbxAuth.persons.byIdentity(issuer, 'erin'))!.id;
  await linkProject({ db, accounts, clock }, linker, projects[1]!.id, { account_id: erin });
  await f.start({});
  assert.equal(await linked(projects[1]!.id), erin);
  assert.equal(f.logs('sandboxes.projects.link_failed').length, 1);
});

test('the integration takes positive USD per provider, none by default', () => {
  const { Config } = sandboxIntegrationPlugin;
  assert.deepEqual(Config.parse(undefined), { newPersonCredits: {} });
  assert.deepEqual(Config.parse({ newPersonCredits: { lambda: '12.5' } }).newPersonCredits, {
    lambda: '12.5',
  });
  for (const newPersonCredits of [
    { lambda: '0' },
    { lambda: '-1' },
    { lambda: 5 },
    { Lambda: '1' },
  ])
    assert.throws(() => Config.parse({ newPersonCredits }));
});
