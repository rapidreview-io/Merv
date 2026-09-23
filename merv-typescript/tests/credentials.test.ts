import { createService } from '@merv/contracts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';

import { ProjectScope } from '@merv/scope';
import { MervError, type Caller } from '@merv/contracts';
import { EnvironmentCredentials } from '../packages/mounts/src/credentials.js';
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

test('upstream credentials select exact current project, actor and mount without role inheritance', async (t) => {
  const { scope, caller, operator, readerCaller, other } = await fixture(t);
  const first = environment(t, 'first-upstream-token'),
    second = environment(t, 'second-upstream-token');
  await assert.rejects(
    async () => await new EnvironmentCredentials(scope).resolve(caller, 'sandboxes'),
    code('credential_forbidden'),
  );
  const provider = new EnvironmentCredentials(scope, [
    binding(caller, first.ref),
    binding(other, second.ref),
  ]);
  assert.deepEqual((await provider.resolve(caller, 'sandboxes')).headers(), {
    authorization: 'Bearer first-upstream-token',
  });
  assert.deepEqual((await provider.resolve(other, 'sandboxes')).headers(), {
    authorization: 'Bearer second-upstream-token',
  });
  for (const unbound of [operator, readerCaller])
    await assert.rejects(
      async () => await provider.resolve(unbound, 'sandboxes'),
      code('credential_forbidden'),
    );
  await assert.rejects(
    async () => await provider.resolve(caller, 'another-mount'),
    code('credential_forbidden'),
  );
  await assert.rejects(
    async () => await provider.resolve({ ...caller, projectId: other.projectId }, 'sandboxes'),
    code('forbidden'),
  );
  await assert.rejects(
    async () => await provider.resolve({ ...other, projectId: caller.projectId }, 'sandboxes'),
    code('forbidden'),
  );
  provider.replace([binding(readerCaller, first.ref)]);
  assert.equal(
    (await provider.resolve(readerCaller, 'sandboxes')).headers().authorization,
    'Bearer first-upstream-token',
  );
});

test('actor and binding revocation deny the next resolution, and invalid replacements preserve the old selection', async (t) => {
  const { scope, caller, operator, readerCaller } = await fixture(t);
  const env = environment(t, 'revocable-upstream-token');
  const original = binding(caller, env.ref);
  const provider = new EnvironmentCredentials(scope, [original, binding(readerCaller, env.ref)]);
  const before = (await provider.resolve(caller, 'sandboxes')).identityKey;
  assert.throws(
    () =>
      provider.replace([binding(readerCaller, env.ref), { ...original, secretRef: 'raw-secret' }]),
    code('invalid_credential_config'),
  );
  assert.equal((await provider.resolve(caller, 'sandboxes')).identityKey, before);
  assert.throws(
    () => provider.replace([original, { ...original, id: 'another-id' }]),
    code('invalid_credential_config'),
  );
  assert.throws(
    () => provider.replace([original, binding(readerCaller, env.ref, { id: original.id })]),
    code('invalid_credential_config'),
  );
  await scope.revokeActor(operator, caller.actorId);
  await assert.rejects(async () => await provider.resolve(caller, 'sandboxes'), code('forbidden'));
  assert.ok(await provider.resolve(readerCaller, 'sandboxes'));
  provider.replace([]);
  await assert.rejects(
    async () => await provider.resolve(readerCaller, 'sandboxes'),
    code('credential_forbidden'),
  );
});

test('identity snapshots isolate caller configuration and change with rotation, scope or selectors', async (t) => {
  const { scope, caller, readerCaller, other } = await fixture(t);
  const env = environment(t, 'rotation-before');
  const original = binding(caller, env.ref, {
    headers: { 'X-Namespace': 'project-a', 'x-subject': 'subject-a' },
  });
  const provider = new EnvironmentCredentials(scope, [original]);
  const first = await provider.resolve(caller, 'sandboxes');
  original.headers!['X-Namespace'] = 'mutated';
  original.secretRef = 'env:DOES_NOT_EXIST';
  assert.deepEqual(first.headers(), {
    'x-namespace': 'project-a',
    'x-subject': 'subject-a',
    authorization: 'Bearer rotation-before',
  });
  assert.equal((await provider.resolve(caller, 'sandboxes')).identityKey, first.identityKey);
  const equal = binding(caller, env.ref, {
    headers: { 'X-Subject': 'subject-a', 'x-namespace': 'project-a' },
  });
  provider.replace([equal]);
  assert.equal((await provider.resolve(caller, 'sandboxes')).identityKey, first.identityKey);
  process.env[env.name] = 'rotation-after';
  const rotated = await provider.resolve(caller, 'sandboxes');
  assert.notEqual(rotated.identityKey, first.identityKey);
  assert.equal(first.headers().authorization, 'Bearer rotation-before');
  assert.equal(rotated.headers().authorization, 'Bearer rotation-after');
  provider.replace([{ ...equal, headers: { ...equal.headers, 'X-Subject': 'subject-b' } }]);
  const changedSelector = await provider.resolve(caller, 'sandboxes');
  assert.notEqual(changedSelector.identityKey, rotated.identityKey);
  // Keep the binding ID, secret reference and selectors identical to isolate scope in the hash.
  provider.replace([{ ...equal, ...readerCaller }]);
  assert.notEqual(
    (await provider.resolve(readerCaller, 'sandboxes')).identityKey,
    rotated.identityKey,
  );
  provider.replace([{ ...equal, ...other }]);
  assert.notEqual((await provider.resolve(other, 'sandboxes')).identityKey, rotated.identityKey);
  provider.replace([{ ...equal, mountId: 'other-mount' }]);
  assert.notEqual((await provider.resolve(caller, 'other-mount')).identityKey, rotated.identityKey);
});

test('resolved credentials expose only an opaque identity during serialization and inspection', async (t) => {
  const { scope, caller } = await fixture(t);
  const secret = 'private-upstream-secret-that-must-not-be-inspected';
  const env = environment(t, secret);
  const provider = new EnvironmentCredentials(scope, [
    binding(caller, env.ref, { headers: { 'x-subject': 'private-selector-value' } }),
  ]);
  const resolved = await provider.resolve(caller, 'sandboxes');
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

test('configuration rejects inline authentication, protocol headers, wildcards and unsafe selectors without echoing values', async (t) => {
  const { scope, caller } = await fixture(t);
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

test('missing or malformed environment secrets and active local tokens fail with sanitized errors', async (t) => {
  const { scope, caller, admin } = await fixture(t);
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
  const verify = async () =>
    await assert.rejects(
      async () => await provider.resolve(caller, 'sandboxes'),
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
  assert.ok(await provider.resolve(caller, 'sandboxes'));
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
  const provider = new EnvironmentCredentials(scope, [binding(caller, env.ref)]);
  const locals = [admin, expiring, rotated, successor, revoked, inactive, foreign];
  for (const issued of locals) {
    process.env[env.name] = issued.token;
    await assert.rejects(
      async () => await provider.resolve(caller, 'sandboxes'),
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
  assert.deepEqual((await provider.resolve(caller, 'sandboxes')).headers(), {
    authorization: 'Bearer distinct-upstream-token',
  });
});

test('unexpected Scope recognition failures are sanitized and do not admit credentials', async (t) => {
  const { scope, caller } = await fixture(t);
  const secret = 'upstream-value-in-unexpected-database-error';
  const env = environment(t, secret);
  const provider = new EnvironmentCredentials(scope, [binding(caller, env.ref)]);
  t.mock.method(scope, 'recognizesCredential', () => {
    throw new Error(`Database error: ${secret}`);
  });
  await assert.rejects(
    async () => await provider.resolve(caller, 'sandboxes'),
    (error: unknown) => {
      assert.ok(code('credential_unavailable')(error));
      assert.ok(!inspect(error).includes(secret));
      assert.equal((error as Error).cause, undefined);
      return true;
    },
  );
});

for (const change of ['remove', 'replace', 'rotate'] as const) {
  test(`credential resolution rejects ${change} during local-token validation`, async (t) => {
    const { scope, caller } = await fixture(t);
    const env = environment(t, 'before-change');
    const original = binding(caller, env.ref);
    const provider = new EnvironmentCredentials(scope, [original]);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    const recognizes = scope.recognizesCredential.bind(scope);
    let held = false;
    t.mock.method(scope, 'recognizesCredential', async (secret: string) => {
      const result = await recognizes(secret);
      if (!held) {
        held = true;
        enter();
        await waiting;
      }
      return result;
    });
    const pending = provider.resolve(caller, 'sandboxes');
    const rejected = assert.rejects(pending, { code: 'credential_changed' });
    await entered;
    if (change === 'remove') provider.replace([]);
    else if (change === 'replace')
      provider.replace([{ ...original, headers: { 'x-subject': 'new-subject' } }]);
    else process.env[env.name] = 'after-change';
    release();
    await rejected;
    if (change === 'remove') {
      await assert.rejects(provider.resolve(caller, 'sandboxes'), { code: 'credential_forbidden' });
    } else {
      const fresh = await provider.resolve(caller, 'sandboxes');
      assert.equal(
        fresh.headers()[change === 'replace' ? 'x-subject' : 'authorization'],
        change === 'replace' ? 'new-subject' : 'Bearer after-change',
      );
    }
  });
}
