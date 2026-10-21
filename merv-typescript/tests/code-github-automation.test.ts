import { type Caller } from '@merv/contracts';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import test from 'node:test';
import { GitHubClient } from '../packages/code/src/github-client.js';
import { CodeGitHubService } from '../packages/code/src/github.js';
// Loaded at top level so its cleanup hook belongs to the file, not to the first githubFixture test.
import './fixtures/state.js';
import { config, githubFixture, repository } from './github-fixture.js';

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

test('the owner’s agent enables automation with their key, and automation lapses with the key', async (t) => {
  const f = await githubFixture(t);
  const issued = await f.scope.userKeys.create(f.principal, { projectId: f.project.id });
  const key = {
    ...(await f.scope.caller({
      kind: 'key',
      key: await f.scope.userKeys.authenticate(issued.token),
    })),
    projectId: f.project.id,
  };
  assert.equal((await f.github.status(key)).canManage, true);
  await f.github.configureAutomation(key, {
    expectedRevision: (await f.github.status(key)).revision,
    mode: 'write',
    baseBranch: 'main',
  });
  assert.equal(await f.github.automation(f.reviewer, 'write', undefined, async () => true), true);
  // Authority delegated through a key ends with the key.
  await f.scope.userKeys.revoke(f.principal, issued.key.id);
  await assert.rejects(
    f.github.automation(f.reviewer, 'write', undefined, async () => true),
    {
      status: 403,
    },
  );
});

async function reconnect(github: CodeGitHubService, caller: Caller) {
  const before = await github.status(caller);
  const begin = await github.begin(caller, { expectedRevision: before.revision });
  const cookie = begin.cookie.split(';')[0].slice('merv_github_flow='.length);
  const state = new URL(begin.url).searchParams.get('state')!;
  await github.callback({ state, code: 'synthetic-reconnect', cookie });
  const connected = await github.finish(caller, cookie);
  assert.deepEqual(await github.finish(caller, cookie), connected, 'completion is replayable');
  return connected;
}

test('same-owner reconnect retains the repository and settings while fencing old bindings', async (t) => {
  const f = await githubFixture(t);
  await f.enable();
  const before = await f.github.status(f.caller);
  const binding = await f.github.automation(f.reviewer, 'read', undefined, async (_c, _t, b) => b);
  // A changed login is still the same stable GitHub identity.
  f.control.user.login = 'renamed-owner';
  const after = await reconnect(f.github, f.caller);
  assert.deepEqual(after.repository, before.repository);
  assert.equal(after.automation, 'write');
  assert.equal(after.baseBranch, before.baseBranch);
  assert.equal(after.revision, before.revision + 1);
  await assert.rejects(
    f.github.automation(f.reviewer, 'read', binding, async () => true),
    { code: 'github_conflict' },
  );
  assert.equal(await f.github.automation(f.reviewer, 'write', undefined, async () => true), true);
  f.control.push = false;
  await assert.rejects(
    f.github.automation(f.reviewer, 'write', undefined, async () => true),
    { code: 'github_repository_forbidden' },
  );
});

test('reconnect never inherits repository access across a changed Merv or GitHub identity', async (t) => {
  for (const changedIdentity of ['merv', 'github']) {
    const f = await githubFixture(t);
    await f.enable();
    if (changedIdentity === 'github') f.control.user.id = 99;
    const after = await reconnect(f.github, changedIdentity === 'merv' ? f.reviewer : f.caller);
    assert.equal(after.repository, null, changedIdentity);
    assert.equal(after.automation, 'off', changedIdentity);
    assert.equal(after.baseBranch, null, changedIdentity);
    await assert.rejects(
      f.github.automation(f.caller, 'read', undefined, async () => true),
      { code: 'github_automation_disabled' },
    );
  }
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
  await f.scope.members.removeMember(
    await f.scope.members.acceptVerifiedIdentity({
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
