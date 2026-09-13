import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { Context } from 'cordis';
import { SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { MervError, type Caller } from '@merv/contracts';
import { EnvironmentCredentials, credentialsPlugin } from '../packages/credentials/src/index.js';
import type { CredentialBinding } from '../packages/credentials/src/types.js';

function fixture(t: TestContext) {
  const state = new SqliteState(':memory:');
  t.after(() => state.close());
  const scope = new ProjectScope(state);
  const admin = scope.bootstrap({ projectName: 'First', actorName: 'Operator' });
  const operator = { projectId: admin.project.id, actorId: admin.actor.id };
  const producer = scope.issueActor(operator, { name: 'Producer', role: 'producer' });
  const caller = { projectId: operator.projectId, actorId: producer.actor.id };
  const reader = scope.issueActor(operator, { name: 'Reader', role: 'reader' });
  const readerCaller = { projectId: operator.projectId, actorId: reader.actor.id };
  const second = scope.bootstrap({ projectName: 'Second', actorName: 'Other operator' });
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

test('upstream credentials select exact current project, actor and mount without role inheritance', (t) => {
  const { scope, caller, operator, readerCaller, other } = fixture(t);
  const first = environment(t, 'first-upstream-token'),
    second = environment(t, 'second-upstream-token');
  assert.throws(
    () => new EnvironmentCredentials(scope).resolve(caller, 'sandboxes'),
    code('credential_forbidden'),
  );
  const provider = new EnvironmentCredentials(scope, [
    binding(caller, first.ref),
    binding(other, second.ref),
  ]);
  assert.deepEqual(provider.resolve(caller, 'sandboxes').headers(), {
    authorization: 'Bearer first-upstream-token',
  });
  assert.deepEqual(provider.resolve(other, 'sandboxes').headers(), {
    authorization: 'Bearer second-upstream-token',
  });
  for (const unbound of [operator, readerCaller])
    assert.throws(() => provider.resolve(unbound, 'sandboxes'), code('credential_forbidden'));
  assert.throws(() => provider.resolve(caller, 'another-mount'), code('credential_forbidden'));
  assert.throws(
    () => provider.resolve({ ...caller, projectId: other.projectId }, 'sandboxes'),
    code('forbidden'),
  );
  assert.throws(
    () => provider.resolve({ ...other, projectId: caller.projectId }, 'sandboxes'),
    code('forbidden'),
  );
  provider.replace([binding(readerCaller, first.ref)]);
  assert.equal(
    provider.resolve(readerCaller, 'sandboxes').headers().authorization,
    'Bearer first-upstream-token',
  );
});

test('actor and binding revocation deny the next resolution, and invalid replacements preserve the old selection', (t) => {
  const { scope, caller, operator, readerCaller } = fixture(t);
  const env = environment(t, 'revocable-upstream-token');
  const original = binding(caller, env.ref);
  const provider = new EnvironmentCredentials(scope, [original, binding(readerCaller, env.ref)]);
  const before = provider.resolve(caller, 'sandboxes').identityKey;
  assert.throws(
    () =>
      provider.replace([binding(readerCaller, env.ref), { ...original, secretRef: 'raw-secret' }]),
    code('invalid_credential_config'),
  );
  assert.equal(provider.resolve(caller, 'sandboxes').identityKey, before);
  assert.throws(
    () => provider.replace([original, { ...original, id: 'another-id' }]),
    code('invalid_credential_config'),
  );
  assert.throws(
    () => provider.replace([original, binding(readerCaller, env.ref, { id: original.id })]),
    code('invalid_credential_config'),
  );
  scope.revokeActor(operator, caller.actorId);
  assert.throws(() => provider.resolve(caller, 'sandboxes'), code('forbidden'));
  assert.ok(provider.resolve(readerCaller, 'sandboxes'));
  provider.replace([]);
  assert.throws(() => provider.resolve(readerCaller, 'sandboxes'), code('credential_forbidden'));
});

test('identity snapshots isolate caller configuration and change with rotation, scope or selectors', (t) => {
  const { scope, caller, readerCaller, other } = fixture(t);
  const env = environment(t, 'rotation-before');
  const original = binding(caller, env.ref, {
    headers: { 'X-Namespace': 'project-a', 'x-subject': 'subject-a' },
  });
  const provider = new EnvironmentCredentials(scope, [original]);
  const first = provider.resolve(caller, 'sandboxes');
  original.headers!['X-Namespace'] = 'mutated';
  original.secretRef = 'env:DOES_NOT_EXIST';
  assert.deepEqual(first.headers(), {
    'x-namespace': 'project-a',
    'x-subject': 'subject-a',
    authorization: 'Bearer rotation-before',
  });
  assert.equal(provider.resolve(caller, 'sandboxes').identityKey, first.identityKey);
  const equal = binding(caller, env.ref, {
    headers: { 'X-Subject': 'subject-a', 'x-namespace': 'project-a' },
  });
  provider.replace([equal]);
  assert.equal(provider.resolve(caller, 'sandboxes').identityKey, first.identityKey);
  process.env[env.name] = 'rotation-after';
  const rotated = provider.resolve(caller, 'sandboxes');
  assert.notEqual(rotated.identityKey, first.identityKey);
  assert.equal(first.headers().authorization, 'Bearer rotation-before');
  assert.equal(rotated.headers().authorization, 'Bearer rotation-after');
  provider.replace([{ ...equal, headers: { ...equal.headers, 'X-Subject': 'subject-b' } }]);
  const changedSelector = provider.resolve(caller, 'sandboxes');
  assert.notEqual(changedSelector.identityKey, rotated.identityKey);
  // Keep the binding ID, secret reference and selectors identical to isolate scope in the hash.
  provider.replace([{ ...equal, ...readerCaller }]);
  assert.notEqual(provider.resolve(readerCaller, 'sandboxes').identityKey, rotated.identityKey);
  provider.replace([{ ...equal, ...other }]);
  assert.notEqual(provider.resolve(other, 'sandboxes').identityKey, rotated.identityKey);
  provider.replace([{ ...equal, mountId: 'other-mount' }]);
  assert.notEqual(provider.resolve(caller, 'other-mount').identityKey, rotated.identityKey);
});

test('resolved credentials expose only an opaque identity during serialization and inspection', (t) => {
  const { scope, caller } = fixture(t);
  const secret = 'private-upstream-secret-that-must-not-be-inspected';
  const env = environment(t, secret);
  const provider = new EnvironmentCredentials(scope, [
    binding(caller, env.ref, { headers: { 'x-subject': 'private-selector-value' } }),
  ]);
  const resolved = provider.resolve(caller, 'sandboxes');
  assert.match(resolved.identityKey, /^credential_[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(JSON.stringify(resolved)), { identityKey: resolved.identityKey });
  assert.deepEqual(Object.keys(resolved), ['identityKey']);
  for (const rendered of [
    JSON.stringify({ resolved, provider }),
    inspect(resolved),
    inspect({ resolved, provider }, { showHidden: true, depth: 10 }),
    inspect(resolved, { customInspect: false, showHidden: true }),
    inspect(Object.getOwnPropertyDescriptors(resolved)),
  ]) {
    assert.ok(!rendered.includes(secret));
    assert.ok(!rendered.includes('private-selector-value'));
    assert.ok(!rendered.includes(env.name));
  }
  assert.throws(() => {
    (resolved as { identityKey: string }).identityKey = 'changed';
  }, TypeError);
  assert.throws(() => {
    (resolved.headers() as Record<string, string>).authorization = 'changed';
  }, TypeError);
  assert.equal(resolved.headers().authorization, `Bearer ${secret}`);
});

test('configuration rejects inline authentication, protocol headers, wildcards and unsafe selectors without echoing values', (t) => {
  const { scope, caller } = fixture(t);
  const env = environment(t, 'valid-upstream-token');
  const provider = new EnvironmentCredentials(scope);
  const sentinel = 'SHOULD-NOT-APPEAR-IN-ERROR';
  const invalid: unknown[] = [
    null,
    { ...binding(caller, env.ref), authorization: sentinel },
    binding(caller, sentinel),
    binding(caller, 'file:/tmp/secret'),
    binding(caller, 'env:INVALID-NAME'),
    binding(caller, env.ref, { actorId: '*' }),
    binding(caller, env.ref, { projectId: '*' }),
    binding(caller, env.ref, { mountId: '*' }),
    binding(caller, env.ref, { headers: { 'X-Subject': sentinel, 'x-subject': sentinel } }),
    binding(caller, env.ref, { headers: { 'x-subject': `Bearer ${sentinel}` } }),
    binding(caller, env.ref, { headers: { 'x-subject': `Basic ${sentinel}` } }),
    binding(caller, env.ref, { headers: { 'x-subject': `env:${sentinel}` } }),
    binding(caller, env.ref, { headers: { 'x-subject': `${sentinel}\r\nInjected: value` } }),
  ];
  for (const name of [
    'Authorization',
    'Cookie',
    'Host',
    'MCP-Protocol-Version',
    'Mcp-Session-Id',
    'Content-Type',
    'Proxy-Authorization',
    'X-Api-Key',
    'X-Auth-Token',
    'X-Session-Id',
    'X-Forwarded-Host',
    'X-Secret',
    'X-Credentials',
    'X-Password',
    'X-Bearer',
    'X-Signature',
    'X-Jwt-Assertion',
  ])
    invalid.push(binding(caller, env.ref, { headers: { [name]: sentinel } }));
  for (const value of invalid) {
    assert.throws(
      () => provider.replace([value as CredentialBinding]),
      (error: unknown) => {
        assert.ok(code('invalid_credential_config')(error));
        assert.ok(!String(error).includes(sentinel));
        assert.ok(!inspect(error).includes(sentinel));
        return true;
      },
    );
  }
});

test('missing or malformed environment secrets and active local tokens fail with sanitized errors', (t) => {
  const { scope, caller, admin } = fixture(t);
  const env = environment(t);
  const provider = new EnvironmentCredentials(scope, [binding(caller, env.ref)]);
  const unsafe = [
    '',
    ' ',
    'prefix\r\nInjected: value',
    'Bearer not-a-raw-token',
    'unicode-\u2603',
    admin.token,
  ];
  const verify = () =>
    assert.throws(
      () => provider.resolve(caller, 'sandboxes'),
      (error: unknown) => {
        assert.ok(code('credential_unavailable')(error));
        const rendered = `${String(error)} ${inspect(error)} ${JSON.stringify(error)}`;
        assert.ok(!rendered.includes(env.name));
        for (const secret of unsafe.filter((value) => value.length > 1))
          assert.ok(!rendered.includes(secret));
        return true;
      },
    );
  verify();
  for (const value of unsafe) {
    process.env[env.name] = value;
    verify();
  }
  process.env[env.name] = 'valid-upstream-token';
  assert.ok(provider.resolve(caller, 'sandboxes'));
});

test('unexpected Scope authentication failures are sanitized and do not admit credentials', (t) => {
  const { scope, caller } = fixture(t);
  const secret = 'upstream-value-in-unexpected-database-error';
  const env = environment(t, secret);
  const provider = new EnvironmentCredentials(scope, [binding(caller, env.ref)]);
  t.mock.method(scope, 'authenticate', () => {
    throw new Error(`Database error: ${secret}`);
  });
  assert.throws(
    () => provider.resolve(caller, 'sandboxes'),
    (error: unknown) => {
      assert.ok(code('credential_unavailable')(error));
      assert.ok(!inspect(error).includes(secret));
      assert.equal((error as Error).cause, undefined);
      return true;
    },
  );
});

test('Cordis credentials activate with Scope alone and withdraw with the dependency', async (t) => {
  const { scope, caller } = fixture(t);
  const env = environment(t, 'independent-upstream-token');
  const ctx = new Context();
  try {
    const fiber = ctx.plugin(credentialsPlugin, { bindings: [binding(caller, env.ref)] });
    assert.equal(ctx.get('credentials'), undefined);
    const scopeFiber = ctx.plugin({
      name: 'test-scope-provider',
      apply(ctx: Context) {
        ctx.provide('scope', scope);
      },
    });
    await Promise.all([fiber.await(), scopeFiber.await()]);
    assert.equal(
      ctx.credentials.resolve(caller, 'sandboxes').headers().authorization,
      'Bearer independent-upstream-token',
    );
    for (const service of ['state', 'artifacts', 'tools', 'api'])
      assert.equal(ctx.get(service), undefined);
    await scopeFiber.dispose();
    assert.equal(ctx.get('credentials'), undefined);
  } finally {
    await ctx.fiber.dispose();
  }
});
