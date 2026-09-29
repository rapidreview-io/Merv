import { createService } from '@merv/contracts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';

import { ProjectScope } from '@merv/scope';
import { MervError, type Caller } from '@merv/contracts';
import { ToolRegistry } from '@merv/api';
import { mountsPlugin } from '@merv/mounts';
import { Context } from 'cordis';
import { Bindings } from '../packages/mounts/src/credentials.js';
import type { CredentialBinding } from '../packages/mounts/src/types.js';
import { openState } from './fixtures/state.js';

async function fixture(t: TestContext, clock?: () => number) {
  const state = await openState(':memory:');
  t.after(async () => await state.close());
  const scope = await createService(new ProjectScope(state, clock));
  const admin = await scope.bootstrap({ projectName: 'First', actorName: 'Operator' });
  const operator = { projectId: admin.project.id, actorId: admin.actor.id };
  const producer = await scope.issueActor(operator, { name: 'Producer', role: 'producer' });
  const caller = { projectId: operator.projectId, actorId: producer.actor.id };
  const reader = await scope.issueActor(operator, { name: 'Reader', role: 'reader' });
  const readerCaller = { projectId: operator.projectId, actorId: reader.actor.id };
  const second = await scope.bootstrap({ projectName: 'Second', actorName: 'Other operator' });
  const other = { projectId: second.project.id, actorId: second.actor.id };
  return { scope, state, admin, operator, caller, readerCaller, other };
}
function environment(t: TestContext, value?: string) {
  const name = `MERV_CREDENTIAL_TEST_${randomUUID().replaceAll('-', '_')}`;
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  });
  return { name, ref: `env:${name}` };
}
const binding = (
  caller: Caller,
  secretRef: string,
  overrides: Partial<CredentialBinding> = {},
): CredentialBinding => ({
  id: `binding-${caller.actorId}`,
  ...caller,
  mountId: 'sandboxes',
  secretRef,
  ...overrides,
});
const code = (expected: string) => (error: unknown) =>
  error instanceof MervError && error.code === expected;

/** The upstream headers selected for a caller, as a new connection receives them. */
const headersFor = async (bindings: Bindings, caller: Caller, mountId = 'sandboxes') =>
  await bindings.headers(await bindings.select(caller, mountId));

test('upstream bindings select exact project, actor and mount without role inheritance', async (t) => {
  const { scope, caller, operator, readerCaller, other } = await fixture(t);
  const first = environment(t, 'first-upstream-token'),
    second = environment(t, 'second-upstream-token');
  await assert.rejects(
    async () => await new Bindings(scope, []).select(caller, 'sandboxes'),
    code('credential_forbidden'),
  );
  const configured = binding(caller, first.ref, {
    headers: { 'x-namespace': 'project-a', 'x-subject': 'subject-a' },
  });
  const bindings = new Bindings(scope, [configured, binding(other, second.ref)]);
  assert.deepEqual(await headersFor(bindings, caller), {
    'x-namespace': 'project-a',
    'x-subject': 'subject-a',
    authorization: 'Bearer first-upstream-token',
  });
  assert.deepEqual(await headersFor(bindings, other), {
    authorization: 'Bearer second-upstream-token',
  });
  // Selection does not authorize (the registry does): it only finds the exact binding.
  for (const unbound of [
    operator,
    readerCaller,
    { ...caller, projectId: other.projectId },
    { ...other, projectId: caller.projectId },
  ])
    await assert.rejects(
      async () => await bindings.select(unbound, 'sandboxes'),
      code('credential_forbidden'),
    );
  await assert.rejects(
    async () => await bindings.select(caller, 'another-mount'),
    code('credential_forbidden'),
  );
  const reloaded = new Bindings(scope, [binding(readerCaller, first.ref)]);
  assert.equal(
    (await headersFor(reloaded, readerCaller)).authorization,
    'Bearer first-upstream-token',
  );
});

test('mount status, errors and inspected services never contain an upstream secret', async (t) => {
  const { scope, operator } = await fixture(t);
  const secret = 'private-upstream-secret-that-must-not-be-inspected';
  const env = environment(t, secret);
  const configured = [
    binding(operator, env.ref, {
      mountId: 'fixture',
      headers: { 'x-subject': 'private-selector' },
    }),
  ];
  const registry = new ToolRegistry(scope, scope.toolPolicy);
  scope.toolPolicy.replace([{ ...operator, mountId: 'fixture', tools: ['inspect'] }]);
  const ctx = new Context();
  ctx.provide('tools', registry);
  ctx.provide('scope', scope);
  const mounts = {
    mounts: [
      {
        id: 'fixture',
        url: 'http://127.0.0.1:1/mcp',
        tools: ['inspect'],
        discovery: operator,
        timeoutMs: 200,
        reconnectMs: 60_000,
      },
    ],
    bindings: configured,
  };
  await ctx.plugin(mountsPlugin, mounts).await();
  t.after(async () => {
    await ctx.fiber.dispose();
    await registry.close();
  });
  // apply does not wait for discovery: the refused endpoint fails the first round.
  for (let wait = 0; wait < 400 && ctx.mounts.status()[0].state === 'connecting'; wait++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const bindings = new Bindings(scope, configured);
  const failures: unknown[] = [];
  await headersFor(bindings, { ...operator, actorId: 'unbound' }, 'fixture').catch((error) =>
    failures.push(error),
  );
  process.env[env.name] = (
    await scope.issueActor(operator, { name: 'Local', role: 'producer' })
  ).token;
  await headersFor(bindings, operator, 'fixture').catch((error) => failures.push(error));
  assert.equal(failures.length, 2);
  assert.equal(ctx.mounts.status()[0].state, 'failed');
  for (const rendered of [
    JSON.stringify(ctx.mounts.status()),
    inspect(ctx.mounts.status(), { showHidden: true, depth: 10 }),
    inspect(bindings, { showHidden: true, depth: 10 }),
    JSON.stringify(bindings),
    ...failures.map((error) => `${String(error)} ${inspect(error)} ${JSON.stringify(error)}`),
  ]) {
    assert.ok(!rendered.includes(secret));
    assert.ok(!rendered.includes(process.env[env.name]!));
    assert.ok(!rendered.includes('private-selector'));
    assert.ok(!rendered.includes(env.name));
  }
});

test('missing or malformed environment secrets and active local tokens fail with sanitized errors', async (t) => {
  const { scope, caller, admin } = await fixture(t);
  const env = environment(t);
  const bindings = new Bindings(scope, [binding(caller, env.ref)]);
  const unsafe = [
    '',
    ' ',
    'prefix\r\nInjected: value',
    'Bearer not-a-raw-token',
    'unicode-\u2603',
    admin.token,
  ];
  const verify = async () =>
    await assert.rejects(
      async () => await headersFor(bindings, caller),
      (error: unknown) => {
        assert.ok(code('credential_unavailable')(error));
        const rendered = `${String(error)} ${inspect(error)} ${JSON.stringify(error)}`;
        assert.ok(!rendered.includes(env.name));
        for (const secret of unsafe.filter((value) => value.length > 1))
          assert.ok(!rendered.includes(secret));
        return true;
      },
    );
  await verify();
  for (const value of unsafe) {
    process.env[env.name] = value;
    await verify();
  }
  process.env[env.name] = 'valid-upstream-token';
  assert.ok(await headersFor(bindings, caller));
});

test('known local credentials cannot become upstream bearers after expiry, rotation or revocation', async (t) => {
  let time = Date.parse('2026-09-14T00:00:00.000Z');
  const { scope, caller, operator, admin } = await fixture(t, () => time);
  const expiring = await scope.issueActor(operator, {
    name: 'Expiring',
    role: 'producer',
    expiresAt: new Date(time + 1000).toISOString(),
  });
  const rotated = await scope.issueActor(operator, { name: 'Rotated', role: 'producer' });
  const successor = await scope.rotateCredential(operator, { credentialId: rotated.credential.id });
  const revoked = await scope.issueActor(operator, { name: 'Revoked token', role: 'producer' });
  await scope.revokeCredential(operator, revoked.credential.id);
  const inactive = await scope.issueActor(operator, { name: 'Revoked actor', role: 'producer' });
  await scope.revokeActor(operator, inactive.actor.id);
  const foreign = await scope.bootstrap({ projectName: 'Foreign token', actorName: 'Foreign' });
  time += 1000;

  for (const issued of [expiring, rotated, revoked, inactive])
    await assert.rejects(async () => await scope.authenticate(issued.token), code('unauthorized'));
  const env = environment(t);
  const bindings = new Bindings(scope, [binding(caller, env.ref)]);
  const locals = [admin, expiring, rotated, successor, revoked, inactive, foreign];
  for (const issued of locals) {
    process.env[env.name] = issued.token;
    await assert.rejects(
      async () => await headersFor(bindings, caller),
      (error: unknown) => {
        assert.ok(code('credential_unavailable')(error));
        assert.equal((error as Error).cause, undefined);
        const rendered = `${String(error)} ${inspect(error)} ${JSON.stringify(error)}`;
        for (const local of locals) {
          assert.ok(!rendered.includes(local.token));
          assert.ok(!rendered.includes(local.credential.id));
        }
        assert.ok(!rendered.includes(env.name));
        return true;
      },
    );
  }
  process.env[env.name] = 'distinct-upstream-token';
  assert.deepEqual(await headersFor(bindings, caller), {
    authorization: 'Bearer distinct-upstream-token',
  });
});

test('unexpected Scope recognition failures are sanitized and do not admit credentials', async (t) => {
  const { scope, caller } = await fixture(t);
  const secret = 'upstream-value-in-unexpected-database-error';
  const env = environment(t, secret);
  const bindings = new Bindings(scope, [binding(caller, env.ref)]);
  t.mock.method(scope, 'recognizesCredential', () => {
    throw new Error(`Database error: ${secret}`);
  });
  await assert.rejects(
    async () => await headersFor(bindings, caller),
    (error: unknown) => {
      assert.ok(code('credential_unavailable')(error));
      assert.ok(!inspect(error).includes(secret));
      assert.equal((error as Error).cause, undefined);
      return true;
    },
  );
});
