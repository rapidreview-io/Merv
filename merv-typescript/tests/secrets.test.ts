import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { createService, MervError, type HumanPrincipal } from '@merv/contracts';
import { AccountSecrets } from '@merv/secrets';
import { secretsRoutes } from '@merv/secrets/api';
import { ProjectScope } from '@merv/scope';
import { ApiServer, ToolRegistry } from '@merv/api';
import { openState } from './fixtures/state.js';

const key = Buffer.alloc(32, 42).toString('base64url');
const marker = 'hf_NONCREDENTIAL_TEST_MARKER';
const person = (subject = 'one', issuer = 'https://identity.example'): HumanPrincipal => ({
  kind: 'user',
  user: { issuer, subject, createdAt: new Date().toISOString() },
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
});

test('encrypted account storage isolates issuer and subject, replaces/removes, and hides plaintext', async (t) => {
  const state = await openState();
  t.after(() => state.close());
  const secrets = await createService(new AccountSecrets(state, key));
  const one = person();
  const two = person('two');
  const realm = person('one', 'https://other.example');
  assert.deepEqual(await secrets.huggingFaceStatus(one), {
    available: true,
    configured: false,
    updatedAt: null,
  });
  const saved = await secrets.saveHuggingFace(one, marker);
  assert.equal(saved.configured, true);
  assert.equal(await secrets.resolveHuggingFaceToken(one.user), marker);
  for (const other of [two, realm]) {
    assert.equal((await secrets.huggingFaceStatus(other)).configured, false);
    assert.equal(await secrets.resolveHuggingFaceToken(other.user), null);
  }
  const rows = await state.read((sql) => sql.all('SELECT * FROM account_huggingface_secrets'));
  for (const value of [JSON.stringify(rows), JSON.stringify(saved), inspect(secrets)]) {
    assert.ok(!value.includes(marker));
    assert.ok(!value.includes(key));
  }
  await secrets.saveHuggingFace(one, 'hf_REPLACEMENT_TEST');
  assert.equal(await secrets.resolveHuggingFaceToken(one.user), 'hf_REPLACEMENT_TEST');
  assert.equal((await secrets.removeHuggingFace(one)).configured, false);
  assert.equal(await secrets.resolveHuggingFaceToken(one.user), null);
  assert.equal((await secrets.removeHuggingFace(one)).configured, false);
});

test('authenticated ciphertext refuses account substitution, tampering and another deployment key', async (t) => {
  const state = await openState();
  t.after(() => state.close());
  const secrets = await createService(new AccountSecrets(state, key));
  await secrets.saveHuggingFace(person(), marker);
  const row = await state.read((sql) =>
    sql.get<{ ciphertext: string }>('SELECT ciphertext FROM account_huggingface_secrets'),
  );
  await state.transaction((tx) =>
    tx.run(
      'INSERT INTO account_huggingface_secrets VALUES (?,?,?,?)',
      person('two').user.issuer,
      'two',
      row!.ciphertext,
      new Date().toISOString(),
    ),
  );
  await assert.rejects(secrets.resolveHuggingFaceToken(person('two').user), {
    code: 'secrets_unavailable',
  });
  const wrong = await createService(
    new AccountSecrets(state, Buffer.alloc(32, 43).toString('base64url')),
  );
  await assert.rejects(wrong.resolveHuggingFaceToken(person().user), {
    code: 'secrets_unavailable',
  });
  await state.transaction((tx) =>
    tx.run(
      'UPDATE account_huggingface_secrets SET ciphertext=? WHERE subject=?',
      row!.ciphertext.slice(0, -10) + 'tampered00',
      'one',
    ),
  );
  await assert.rejects(secrets.resolveHuggingFaceToken(person().user), (error) => {
    assert.equal((error as Error).message, 'Hugging Face token storage is unavailable');
    assert.ok(!inspect(error).includes(marker));
    return true;
  });
});

test('missing or invalid key fails closed for save, remains removable, and does not break tokenless runtime', async (t) => {
  const state = await openState();
  t.after(() => state.close());
  await (await createService(new AccountSecrets(state, key))).saveHuggingFace(person(), marker);
  for (const value of [undefined, '', 'bad', key + '=', 'A'.repeat(42) + 'B']) {
    const secrets = await createService(new AccountSecrets(state, value));
    const status = await secrets.huggingFaceStatus(person());
    assert.equal(status.available, false);
    assert.equal(status.configured, true);
    assert.equal(await secrets.resolveHuggingFaceToken(person().user), null);
    await assert.rejects(secrets.saveHuggingFace(person(), marker), {
      code: 'secrets_unavailable',
    });
  }
  const missing = new AccountSecrets(state, undefined);
  assert.equal((await missing.removeHuggingFace(person())).configured, false);
  const expired = { ...person(), expiresAt: new Date(0).toISOString() };
  for (const operation of [
    () => missing.huggingFaceStatus(expired),
    () => missing.removeHuggingFace(expired),
    () => missing.saveHuggingFace(expired, marker),
  ])
    await assert.rejects(operation(), { code: 'forbidden' });
});

test('HTTP accepts transport humans only, exposes metadata, rejects invalid bodies, and publishes no tools', async (t) => {
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  const secrets = await createService(new AccountSecrets(state, key));
  const tools = new ToolRegistry(scope);
  const identity = {
    configuration: () => ({ enabled: true }),
    verify: async (token: string) => ({
      issuer: person().user.issuer,
      subject: token,
      expiresAt: person().expiresAt,
    }),
  };
  const api = new ApiServer(scope, tools, { port: 0 }, identity);
  api.mount('/secrets', secretsRoutes(secrets));
  const base = await api.start();
  t.after(async () => {
    await api.stop();
    await tools.close();
    await state.close();
  });
  const request = (
    bearer = 'human.one.jwt',
    method = 'GET',
    body?: unknown,
    path = '/secrets/huggingface',
  ) =>
    fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const saved = await request('human.one.jwt', 'PUT', { token: marker });
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.get('cache-control'), 'no-store');
  const savedBody = await saved.json();
  assert.deepEqual(Object.keys(savedBody).sort(), ['available', 'configured', 'updatedAt']);
  assert.equal(savedBody.configured, true);
  assert.equal((await (await request('human.two.jwt')).json()).configured, false);
  assert.equal((await request('human.one.jwt', 'PUT', { token: '' })).status, 400);
  assert.equal(
    (await request('human.one.jwt', 'PUT', { token: marker, issuer: 'forged' })).status,
    400,
  );
  assert.equal(
    (await request('human.one.jwt', 'GET', undefined, '/secrets/huggingface?token=ignored')).status,
    400,
  );
  assert.equal((await request('human.one.jwt', 'PUT', { token: 'x'.repeat(9000) })).status, 413);
  const principal = await scope.members.acceptVerifiedIdentity(
    await identity.verify('human.one.jwt'),
  );
  const project = await scope.members.createProject(principal, {
    name: 'Account',
    requestId: 'account',
  });
  const issued = await scope.userKeys.create(principal, { projectId: project.id });
  const actor = await scope.credentials.issueActor(await scope.caller(principal, project.id), {
    name: 'Machine',
    role: 'reader',
  });
  for (const bearer of [issued.token, actor.token]) {
    for (const method of ['GET', 'PUT', 'DELETE'])
      assert.equal(
        (await request(bearer, method, method === 'PUT' ? { token: marker } : undefined)).status,
        403,
      );
  }
  for (const kind of ['managed', 'conversation']) {
    api.credential(`${kind}_`, {
      kind,
      routes: () => true,
      forbidden: new MervError('forbidden', 'Denied', 403),
      authenticate: async () => ({ projectId: project.id, actorId: actor.actor.id }),
    });
    for (const method of ['GET', 'PUT', 'DELETE'])
      assert.equal(
        (await request(`${kind}_fixture`, method, method === 'PUT' ? { token: marker } : undefined))
          .status,
        403,
      );
  }
  assert.ok(!(await tools.describe()).some((tool) => /huggingface|secrets/.test(tool.name)));
  const removed = await request('human.one.jwt', 'DELETE');
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).configured, false);
});
