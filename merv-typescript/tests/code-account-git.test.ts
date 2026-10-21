import assert from 'node:assert/strict';
import test from 'node:test';
import {
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  createHash,
  randomBytes,
  constants,
} from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiServer, ToolRegistry } from '@merv/api';
import { OAuth } from '@merv/scope/oauth';
import { codeToolsPlugin } from '@merv/code-work/tools';
import { writerFixture } from './fixtures/code-writers.js';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const decrypt = (encryptedToken: string) =>
  privateDecrypt(
    { key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(encryptedToken, 'base64'),
  ).toString();

async function fixture(t: test.TestContext) {
  const f = await writerFixture(t);
  await f.human();
  const person = await f.scope.members.acceptVerifiedIdentity({
    issuer: 'https://issuer.example.test',
    subject: 'operator',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const oauth = new OAuth(f.state, f.scope, 'https://merv.example');
  await oauth.initialize();
  const client = await oauth.register({ redirect_uris: ['http://localhost:7777/callback'] });
  const verifier = randomBytes(32).toString('base64url');
  const request = await oauth.start(
    new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0]!,
      resource: oauth.resource,
      response_type: 'code',
      state: 'test',
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    }),
  );
  const callback = new URL(await oauth.consent(request, person, true));
  let tokens = await oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: callback.searchParams.get('code')!,
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0]!,
      resource: oauth.resource,
    }),
  );
  const calls: unknown[] = [];
  const tools = new ToolRegistry(f.scope, f.scope.toolPolicy, undefined, (c) => calls.push(c));
  codeToolsPlugin.apply({ tools, codeWork: f.code, effect: (fn: () => unknown) => fn() } as never);
  const server = new ApiServer(f.scope, tools);
  server.oauth({
    metadataUrl: oauth.origin + '/.well-known/oauth-protected-resource/mcp',
    authenticate: (token) => oauth.authenticate(token),
  });
  server.mount('/git', (req, res, r) => f.code.gitRemote.handle(req, res, r.url), { public: true });
  const base = await server.start();
  const initialized = await fetch(base + '/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tokens.access_token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'git-orientation-test', version: '1' },
      },
    }),
  });
  assert.equal(initialized.status, 200);
  const instructions = (await initialized.json()).result.instructions as string;
  assert.match(instructions, /code.git_credential/);
  assert.match(instructions, /connect\/bundle.json/);
  assert.match(instructions, /experiment pins/);
  t.after(async () => {
    await server.stop();
    await tools.close();
  });
  const mint = async (mode: 'read' | 'write', projectId = f.admin.projectId, key = publicKey) => {
    const response = await fetch(base + '/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'code.git_credential', arguments: { projectId, publicKey: key, mode } },
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    if (body.error || body.result?.isError) throw new Error(JSON.stringify(body));
    return JSON.parse(body.result.content[0].text) as {
      url: string;
      encryptedToken: string;
      expiresAt: string;
    };
  };
  const access = async (token: string, projectId = f.admin.projectId, write = false) =>
    fetch(
      `${base}/git/${projectId}.git/info/refs?service=git-${write ? 'receive' : 'upload'}-pack`,
      { headers: { authorization: `Basic ${Buffer.from('merv:' + token).toString('base64')}` } },
    );
  return {
    ...f,
    person,
    oauth,
    calls,
    base,
    mint,
    access,
    principal: await oauth.authenticate(tokens.access_token),
    refresh: async () => {
      tokens = await oauth.exchange(
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
          client_id: client.client_id,
          resource: oauth.resource,
        }),
      );
    },
    revoke: () =>
      oauth.revoke(
        new URLSearchParams({ client_id: client.client_id, token: tokens.refresh_token }),
      ),
  };
}

test(
  'native MCP OAuth mints encrypted Git access; ordinary credential-cache clone/push and renewal work',
  { timeout: 90_000 },
  async (t) => {
    const f = await fixture(t);
    const operator = await f.scope.members.acceptVerifiedIdentity({
      issuer: f.person.user.issuer,
      subject: 'sync-admin',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    await f.scope.members.addMember(f.person, f.admin.projectId, {
      subject: 'sync-admin',
      role: 'operator',
    });
    await f.scope.members.changeMemberRole(operator, f.admin.projectId, {
      subject: f.person.user.subject,
      role: 'producer',
    });
    await f.lease('pinned-cloud-work');
    const pinned = (await f.unit()).base;
    assert.ok(pinned);
    const grant = await f.mint('write');
    const token = decrypt(grant.encryptedToken);
    assert.ok(token.startsWith('mg_'));
    assert.ok(!JSON.stringify(grant).includes(token));
    const retained = await f.state.read((sql) => sql.all('SELECT * FROM code_git_credentials'));
    assert.ok(!JSON.stringify(retained).includes(token));
    const cache = mkdtempSync('/tmp/merv-git-cache-');
    t.after(() => rmSync(cache, { recursive: true, force: true }));
    const socket = join(cache, 'socket');
    const env = {
      PATH: process.env.PATH,
      HOME: cache,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    };
    const git = (args: string[], input?: string) =>
      new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn('git', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', (c) => (output += c));
        child.stderr.on('data', (c) => (output += c));
        child.on('error', reject);
        child.on('close', (code) => {
          assert.ok(!output.includes(token));
          resolve({ code, output });
        });
        child.stdin.end(input);
      });
    t.after(() => git(['credential-cache', '--socket=' + socket, 'exit']));
    const url = new URL(grant.url, f.base);
    const stored = await git(
      ['credential-cache', '--socket=' + socket, '--timeout=540', 'store'],
      `protocol=http\nhost=${url.host}\npath=${url.pathname.slice(1)}\nusername=merv\npassword=${token}\n\n`,
    );
    assert.equal(stored.code, 0);
    const options = [
      '-c',
      'credential.helper=',
      '-c',
      `credential.helper=cache --socket=${socket}`,
      '-c',
      'credential.useHttpPath=true',
      '-c',
      'http.followRedirects=false',
    ];
    const checkout = join(f.directory, 'oauth-clone');
    const cloned = await git([...options, 'clone', '--origin', 'merv', url.href, checkout]);
    assert.equal(cloned.code, 0, cloned.output);
    assert.ok(!readFileSync(join(checkout, '.git/config'), 'utf8').includes(token));
    await git(['-C', checkout, 'remote', 'add', 'origin', 'https://example.invalid/user/repo.git']);
    writeFileSync(join(checkout, 'local-only.txt'), 'not committed or synchronized');
    const pushed = await git([
      ...options,
      '-C',
      checkout,
      'push',
      'merv',
      'HEAD:refs/heads/user/oauth-smoke',
    ]);
    assert.equal(pushed.code, 0, pushed.output);
    await git([...options, '-C', checkout, 'push', 'merv', 'HEAD:refs/heads/merv-main']);
    // Send a changed commit to exercise reserved admission rather than Git's no-op path.
    const next = f.source.commit({ 'oauth.txt': 'new content\n' });
    const protectedPush = await git([
      ...options,
      '-C',
      f.source.repository,
      'push',
      url.href,
      'HEAD:refs/heads/merv-main',
    ]);
    assert.notEqual(protectedPush.code, 0);
    assert.match(protectedPush.output, /reserved|protected|main/i);
    const synced = await git([
      ...options,
      '-C',
      f.source.repository,
      'push',
      url.href,
      'HEAD:refs/heads/user/oauth-smoke',
    ]);
    assert.equal(synced.code, 0, synced.output);
    const separate = await git([
      ...options,
      '-C',
      f.source.repository,
      'push',
      url.href,
      `${f.root}:refs/heads/user/other-agent`,
    ]);
    assert.equal(separate.code, 0, separate.output);
    const remote = await git([
      ...options,
      'ls-remote',
      '--refs',
      url.href,
      'refs/heads/user/oauth-smoke',
    ]);
    assert.equal(remote.output.trim().split('\t')[0], next);
    const status = await f.code.status(await f.scope.caller(f.principal, f.admin.projectId));
    assert.equal(
      status.git!.userBranches.find((b) => b.name === 'user/oauth-smoke')!.headOid,
      next,
    );
    assert.equal(
      status.git!.userBranches.find((b) => b.name === 'user/other-agent')!.headOid,
      f.root,
    );
    assert.equal(status.git!.baselineOid, f.root);
    assert.equal(status.git!.baselinePolicy, 'reviewed_integration');
    assert.equal(status.git!.localWorkingTree, 'unknown');
    assert.deepEqual((await f.unit()).base, pinned);
    assert.ok(!status.git!.userBranches.some((b) => b.name.startsWith('merv')));
    const rollback = await git([
      ...options,
      '-C',
      f.source.repository,
      'push',
      '--force',
      url.href,
      `${f.root}:refs/heads/user/oauth-smoke`,
    ]);
    assert.notEqual(rollback.code, 0);
    const deletion = await git([
      ...options,
      '-C',
      f.source.repository,
      'push',
      url.href,
      ':refs/heads/user/oauth-smoke',
    ]);
    assert.notEqual(deletion.code, 0);
    assert.equal(
      (await git(['-C', checkout, 'remote', 'get-url', 'origin'])).output.trim(),
      'https://example.invalid/user/repo.git',
    );
    assert.equal(
      readFileSync(join(checkout, 'local-only.txt'), 'utf8'),
      'not committed or synchronized',
    );
    const machine = await f.scope.userKeys.create(f.person, { projectId: f.admin.projectId });
    assert.equal((await f.access(machine.token, f.admin.projectId, true)).status, 200);
    await f.refresh();
    const renewed = decrypt((await f.mint('write')).encryptedToken);
    assert.notEqual(renewed, token);
    assert.equal((await f.access(renewed)).status, 200);
    assert.ok(!JSON.stringify(f.calls).includes(token));
    assert.ok(!JSON.stringify(f.calls).includes(renewed));
    await f.revoke();
    assert.equal((await f.access(token)).status, 403);
    assert.equal((await f.access(renewed)).status, 403);
  },
);

test(
  'derived Git credentials enforce project, mode, live roles, source revocation, expiry and worker fences',
  { timeout: 90_000 },
  async (t) => {
    const f = await fixture(t);
    const a = f.admin.projectId;
    const other = await f.scope.members.createProject(f.person, {
      name: 'Other',
      requestId: 'other',
    });
    const read = decrypt((await f.mint('read')).encryptedToken);
    assert.equal((await f.access(read)).status, 200);
    assert.equal((await f.access(read, a, true)).status, 403);
    assert.equal((await f.access(read, other.id)).status, 401);
    const b = decrypt((await f.mint('read', other.id)).encryptedToken);
    assert.equal((await f.access(b, a)).status, 401);
    assert.equal((await f.access(decrypt((await f.mint('read', a)).encryptedToken))).status, 200);
    await assert.rejects(f.mint('read', 'arbitrary-project'));
    await assert.rejects(f.mint('read', a, 'not a key'));
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 })
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    await assert.rejects(f.mint('read', a, weak));
    const caller = await f.scope.caller(f.principal, a);
    await assert.rejects(
      f.code.gitRemote.issueAccount(
        { ...caller, session: { id: 'worker' } },
        { publicKey, mode: 'write' },
      ),
      { code: 'code_git_account_required' },
    );
    await assert.rejects(
      f.code.gitRemote.issueAccount(
        { ...caller, managed: {} as never },
        { publicKey, mode: 'write' },
      ),
      { code: 'code_git_account_required' },
    );
    await assert.rejects(f.code.gitRemote.issueAccount(f.admin, { publicKey, mode: 'read' }), {
      code: 'code_git_account_required',
    });
    // A second live operator can remove/downgrade the OAuth owner.
    const second = await f.scope.members.acceptVerifiedIdentity({
      issuer: f.person.user.issuer,
      subject: 'second',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    await f.scope.members.addMember(f.person, a, { subject: 'second', role: 'operator' });
    const write = decrypt((await f.mint('write')).encryptedToken);
    await f.scope.members.changeMemberRole(second, a, {
      subject: f.person.user.subject,
      role: 'reader',
    });
    assert.equal((await f.access(write, a, true)).status, 403);
    assert.equal((await f.access(read)).status, 403); // role replacement invalidates the old membership
    await assert.rejects(f.mint('write'));
    assert.equal((await f.access(decrypt((await f.mint('read')).encryptedToken))).status, 200);
    await f.scope.members.changeMemberRole(second, a, {
      subject: f.person.user.subject,
      role: 'reviewer',
    });
    await assert.rejects(f.mint('write'));
    assert.equal((await f.access(decrypt((await f.mint('read')).encryptedToken))).status, 200);
    await f.scope.members.removeMember(second, a, f.person.user.subject);
    assert.equal((await f.access(read)).status, 403);
    await assert.rejects(f.mint('read'));
    await f.scope.members.addMember(second, a, {
      subject: f.person.user.subject,
      role: 'operator',
    });
    const fresh = decrypt((await f.mint('read')).encryptedToken);
    const realNow = Date.now();
    t.mock.method(Date, 'now', () => realNow + 11 * 60_000);
    assert.equal((await f.access(fresh)).status, 401);
    // OAuth is still live and can replace an expired Git credential without another consent.
    assert.equal((await f.access(decrypt((await f.mint('read')).encryptedToken))).status, 200);
    t.mock.restoreAll();
  },
);

test('published skill commands decrypt only into native Git cache, with path separation and key cleanup', () => {
  const skill = readFileSync(
    new URL('../../clients/codex/skills/git-access/SKILL.md', import.meta.url),
    'utf8',
  );
  const blocks = [...skill.matchAll(/```python\n([\s\S]*?)```/g)].map((m) => m[1]!);
  assert.equal(blocks.length, 2);
  const prepared = JSON.parse(execFileSync('python3', ['-c', blocks[0]!], { encoding: 'utf8' }));
  const token = 'mg_' + randomBytes(32).toString('base64url');
  const reply = {
    url: '/git/project_test.git',
    encryption: 'RSA-OAEP-SHA256',
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    encryptedToken: publicEncrypt(
      { key: prepared.publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(token),
    ).toString('base64'),
  };
  const script = blocks[1]!
    .replace('"<temporary-directory>"', JSON.stringify(prepared.directory))
    .replace('https://<connected-merv-host>', 'https://merv.example')
    .replace('<selected-project-id>', 'project_test')
    .replace('<JSON-tool-reply>', JSON.stringify(reply));
  const socket = join(prepared.directory, 'socket');
  try {
    const output = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
    assert.ok(!output.includes(token));
    assert.equal(JSON.parse(output).remote, 'https://merv.example/git/project_test.git');
    assert.ok(!existsSync(join(prepared.directory, 'key.pem')));
    const cached = execFileSync('git', ['credential-cache', '--socket=' + socket, 'get'], {
      input: 'protocol=https\nhost=merv.example\npath=git/project_test.git\nusername=merv\n\n',
      encoding: 'utf8',
    });
    assert.ok(cached.includes('password=' + token));
    const other = execFileSync('git', ['credential-cache', '--socket=' + socket, 'get'], {
      input: 'protocol=https\nhost=merv.example\npath=git/other.git\nusername=merv\n\n',
      encoding: 'utf8',
    });
    assert.equal(other, '');
  } finally {
    execFileSync('git', ['credential-cache', '--socket=' + socket, 'exit']);
    rmSync(prepared.directory, { recursive: true, force: true });
  }
});
