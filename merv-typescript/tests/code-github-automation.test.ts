import test from 'node:test';
import assert from 'node:assert/strict';
import { verify, createPublicKey } from 'node:crypto';
import { GitHubClient } from '../packages/code/src/github-client.js';
import { githubFixture, config, repository } from './github-fixture.js';

test('automation is explicit, owner-bound and independent of ordinary token refresh', async (t) => {
  const f = await githubFixture(t);
  assert.equal((await f.github.status(f.caller)).automation, 'off');
  await assert.rejects(
    f.github.automation(f.reviewer, 'read', undefined, async () => true),
    { code: 'github_automation_disabled' },
  );
  await assert.rejects(
    f.github.configureAutomation(f.reviewer, {
      expectedRevision: 2,
      mode: 'write',
      baseBranch: 'main',
    }),
    { code: 'github_owner' },
  );
  const caller = structuredClone(f.caller);
  const enabling = f.github.configureAutomation(caller, {
    expectedRevision: 2,
    mode: 'write',
    baseBranch: 'main',
  });
  caller.actorId = 'missing';
  const enabled = await enabling;
  const binding = await f.github.automation(
    f.reviewer,
    'read',
    undefined,
    async (_client, _token, binding) => binding,
  );
  assert.equal(binding.revision, enabled.revision);
  await f.state.transaction(async (tx) => {
    const source = structuredClone(f.caller),
      selected = structuredClone(binding);
    const checking = f.github.assertBinding(source, selected, tx, 'read');
    source.actorId = 'missing';
    selected.revision = 999;
    await checking;
  });
  const client = new GitHubClient(config, f.fetcher);
  t.after(() => client.close());
  await f.state.transaction(async (tx) => {
    const row = (await tx.get<any>('SELECT * FROM code_github'))!;
    const tokens = client.open<any>(row.credentials, `tokens:${f.project.id}:${row.token_version}`);
    tokens.expiresAt = Date.now();
    await tx.run(
      'UPDATE code_github SET credentials=?',
      client.seal(tokens, `tokens:${f.project.id}:${row.token_version}`),
    );
  });
  assert.equal(
    await f.github.automation(f.reviewer, 'write', binding, async () => 'refreshed'),
    'refreshed',
  );
  assert.equal((await f.github.status(f.caller)).revision, binding.revision);
  f.control.push = false;
  await assert.rejects(
    f.github.automation(f.reviewer, 'write', binding, async () => true),
    { code: 'github_repository_forbidden' },
  );
  assert.equal(await f.github.automation(f.reviewer, 'read', binding, async () => true), true);
});

test('relink and owner removal fence delegated automation without changing the caller', async (t) => {
  const f = await githubFixture(t);
  await f.enable();
  const binding = await f.github.automation(f.reviewer, 'read', undefined, async (_c, _t, b) => b);
  await f.github.link(f.caller, {
    expectedRevision: binding.revision,
    repositoryId: 101,
    installationId: 17,
  });
  assert.equal((await f.github.status(f.caller)).automation, 'off');
  await assert.rejects(
    f.github.automation(f.reviewer, 'read', binding, async () => true),
    { code: 'github_automation_disabled' },
  );
  await f.enable();
  await f.scope.removeMember(
    await f.scope.acceptVerifiedIdentity({
      issuer: f.caller.human!.issuer,
      subject: 'reviewer',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }),
    f.project.id,
    'owner',
  );
  await assert.rejects(
    f.github.automation(f.reviewer, 'read', undefined, async () => true),
    (e) => (e as any).code === 'membership_required',
  );
});

test('App JWTs mint only the selected repository and permission; tokens are not persisted', async (t) => {
  const f = await githubFixture(t);
  await f.enable();
  const grant = await f.github.automation(f.reviewer, 'read', undefined, (client, _t, binding) =>
    client.installationToken(binding.repository, false),
  );
  assert.equal(grant.token, 'synthetic-installation-secret');
  const request = f.calls.find((c) => c.path === '/app/installations/17/access_tokens')!;
  assert.deepEqual(request.body, { repository_ids: [101], permissions: { contents: 'read' } });
  const jwt = request.authorization.slice('Bearer '.length).split('.');
  assert.equal(
    verify(
      'RSA-SHA256',
      Buffer.from(jwt.slice(0, 2).join('.')),
      createPublicKey(Buffer.from(config.privateKey!, 'base64')),
      Buffer.from(jwt[2], 'base64url'),
    ),
    true,
  );
  const claims = JSON.parse(Buffer.from(jwt[1], 'base64url').toString());
  assert.equal(claims.iss, config.clientId);
  assert.ok(claims.exp - claims.iat <= 600);
  const stored = await f.state.read((sql) => sql.all('SELECT * FROM code_github'));
  assert.equal(JSON.stringify(stored).includes(grant.token), false);
  f.control.badTokenScope = true;
  const client = new GitHubClient(config, f.fetcher);
  t.after(() => client.close());
  await assert.rejects(client.installationToken(repository, true), { code: 'github_response' });
  assert.equal(f.calls.at(-1)?.path, '/installation/token');
  assert.equal(f.calls.at(-1)?.method, 'DELETE');
});

test('token cleanup remains available when automation is disabled during issuance', async (t) => {
  const f = await githubFixture(t);
  await f.enable();
  f.control.badTokenScope = true;
  f.control.before = async (path) => {
    if (path === '/app/installations/17/access_tokens') {
      f.control.before = undefined;
      await f.github.configureAutomation(f.caller, {
        expectedRevision: 3,
        mode: 'off',
        baseBranch: null,
      });
    }
  };
  await assert.rejects(
    f.github.automation(f.reviewer, 'write', undefined, (client, _token, binding) =>
      client.installationToken(binding.repository, true),
    ),
    { code: 'github_response' },
  );
  assert.equal(f.calls.at(-1)?.path, '/installation/token');
  assert.equal(f.calls.at(-1)?.method, 'DELETE');
  assert.equal((await f.github.branches(f.caller))[0].name, 'main');
});

test('GitHub browsing cannot switch to another caller while pending', async (t) => {
  const f = await githubFixture(t);
  for (const method of ['status', 'repositories', 'branches', 'pulls', 'pullDetails'] as const) {
    await t.test(method, async () => {
      const caller = { ...structuredClone(f.caller), actorId: 'missing' };
      const before = f.calls.length;
      const pending =
        method === 'pullDetails' ? f.github.pullDetails(caller, 1) : f.github[method](caller);
      Object.assign(caller, f.caller);
      await assert.rejects(pending, { code: 'membership_required' });
      assert.equal(f.calls.length, before);
    });
  }
});
