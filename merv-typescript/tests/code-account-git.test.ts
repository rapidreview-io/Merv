import assert from 'node:assert/strict';
import test from 'node:test';
import {
  generateKeyPairSync,
  privateDecrypt,
  createHash,
  randomBytes,
  constants,
} from 'node:crypto';
import { spawn, execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer as createHttpsServer } from 'node:https';
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
  const call = async (name: string, args: Record<string, unknown>) => {
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
        params: { name, arguments: args },
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    if (body.error || body.result?.isError) throw new Error(JSON.stringify(body));
    return JSON.parse(body.result.content[0].text);
  };
  const mint = async (mode: 'read' | 'write', projectId = f.admin.projectId, key = publicKey) =>
    (await call('code.git_credential', { projectId, publicKey: key, mode })) as {
      url: string;
      encryptedToken: string;
      expiresAt: string;
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
    call,
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
    // Read actual pushed refs through native OAuth MCP, including the retained flat alias.
    const status = (await f.call('code.read', {
      projectId: f.admin.projectId,
      action: 'status',
    })) as Awaited<ReturnType<typeof f.code.status>>;
    const legacy = (await f.call('code.status', {
      projectId: f.admin.projectId,
    })) as typeof status;
    assert.deepEqual(Object.keys(legacy).sort(), Object.keys(status).sort());
    const { observedAt, ...facts } = status.git!;
    const { observedAt: legacyObservedAt, ...legacyFacts } = legacy.git!;
    assert.ok(Number.isFinite(Date.parse(observedAt)));
    assert.ok(Number.isFinite(Date.parse(legacyObservedAt)));
    assert.deepEqual(legacyFacts, facts);
    assert.deepEqual(Object.keys(status.git!).sort(), [
      'available',
      'baselineOid',
      'baselinePolicy',
      'localWorkingTree',
      'observedAt',
      'remotePath',
      'truncated',
      'userBranches',
    ]);
    assert.equal(status.git!.remotePath, `/git/${f.admin.projectId}.git`);
    assert.equal(status.git!.available, true);
    assert.equal(status.git!.truncated, false);
    assert.equal(status.git!.userBranches.length, 2);
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

test(
  'published live batch survives executor cache cleanup boundaries and renews for later native Git work',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t);
    const execute = promisify(execFile);
    const cert = join(f.directory, 'git-cert.pem');
    const tlsKey = join(f.directory, 'git-tls-key.pem');
    await execute('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-keyout',
      tlsKey,
      '-out',
      cert,
    ]);
    const server = createHttpsServer(
      { key: readFileSync(tlsKey), cert: readFileSync(cert) },
      (req, res) => {
        void f.code.gitRemote
          .handle(req, res, new URL(req.url!, 'https://localhost'))
          .catch((error) => {
            if (res.headersSent) return res.destroy();
            res.writeHead(error.status ?? 500);
            res.end(error.message);
          });
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
    const remote = `${origin}/git/${f.admin.projectId}.git`;
    const env = {
      PATH: process.env.PATH,
      HOME: f.directory,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_SSL_CAINFO: cert,
      GIT_TERMINAL_PROMPT: '0',
    };
    const skill = readFileSync(
      new URL('../../clients/codex/skills/git-access/SKILL.md', import.meta.url),
      'utf8',
    );
    const blocks = [...skill.matchAll(/```python\n([\s\S]*?)```/g)].map((m) => m[1]!);
    assert.equal(blocks.length, 2);
    const prepare = () =>
      JSON.parse(execFileSync('python3', ['-c', blocks[0]!], { encoding: 'utf8', env }));
    const run = async (prepared: { directory: string; publicKey: string }, batch: string[][]) => {
      const reply = await f.mint('read', f.admin.projectId, prepared.publicKey);
      const script = blocks[1]!
        .replace('"<temporary-directory>"', JSON.stringify(prepared.directory))
        .replace('https://<connected-merv-host>', origin)
        .replace('<selected-project-id>', f.admin.projectId)
        .replace('<JSON-tool-reply>', JSON.stringify({ ...reply, encryption: 'RSA-OAEP-SHA256' }))
        .replace('"<existing-working-directory>"', JSON.stringify(f.directory))
        .replace('<JSON-Git-argument-arrays>', JSON.stringify(batch));
      const result = await execute('python3', ['-c', script], { env });
      assert.ok(!/mg_[A-Za-z0-9_-]{43}/.test(result.stdout + result.stderr));
      assert.ok(
        !existsSync(prepared.directory),
        'private key and cache are removed before exec returns',
      );
      return result.stdout;
    };
    const prepared = prepare();
    t.after(() => rmSync(prepared.directory, { recursive: true, force: true }));
    const socket = join(prepared.directory, 'socket');
    const old = await f.mint('read', f.admin.projectId, prepared.publicKey);
    const token = execFileSync(
      'openssl',
      [
        'pkeyutl',
        '-decrypt',
        '-inkey',
        join(prepared.directory, 'key.pem'),
        '-pkeyopt',
        'rsa_padding_mode:oaep',
        '-pkeyopt',
        'rsa_oaep_md:sha256',
        '-pkeyopt',
        'rsa_mgf1_md:sha256',
      ],
      { input: Buffer.from(old.encryptedToken, 'base64'), encoding: 'utf8' },
    );
    const host = new URL(origin).host;
    execFileSync('git', ['credential-cache', '--socket=' + socket, '--timeout=540', 'store'], {
      env,
      input: `protocol=https\nhost=${host}\npath=git/${f.admin.projectId}.git\nusername=merv\npassword=${token}\n\n`,
    });
    const options = [
      '-c',
      'credential.helper=',
      '-c',
      `credential.helper=cache --socket=${socket}`,
      '-c',
      'credential.useHttpPath=true',
    ];
    const before = await execute('git', [...options, 'ls-remote', '--refs', remote], { env });
    assert.ok(before.stdout.includes(f.root));
    // Model the executor terminating this invocation's cache child, using the native cache's
    // own shutdown command. No credential expiry or source revocation is involved.
    execFileSync('git', ['credential-cache', '--socket=' + socket, 'exit'], { env });
    await assert.rejects(
      execute('git', [...options, 'ls-remote', '--refs', remote], { env }),
      (error) => {
        const e = error as { stderr: string };
        assert.ok(!e.stderr.includes(token));
        return /could not read Username|terminal prompts disabled/.test(e.stderr);
      },
    );
    const checkout = join(f.directory, 'skill-batch-clone');
    const output = await run(prepared, [
      ['clone', remote, checkout],
      ['-C', checkout, 'fetch', 'origin'],
      ['ls-remote', '--refs', remote, 'refs/heads/merv-main'],
      ['-C', checkout, 'rev-parse', 'HEAD'],
    ]);
    assert.ok(output.includes(f.root));
    assert.ok(!output.includes(token));
    const after = execFileSync('git', ['credential-cache', '--socket=' + socket, 'get'], {
      env,
      input: `protocol=https\nhost=${host}\npath=git/${f.admin.projectId}.git\n\n`,
      encoding: 'utf8',
    });
    assert.equal(after, '', 'no cache credential survives the completed batch');
    const next = prepare();
    t.after(() => rmSync(next.directory, { recursive: true, force: true }));
    assert.ok(
      (await run(next, [['ls-remote', '--refs', remote, 'refs/heads/merv-main']])).includes(f.root),
    );
    const failed = prepare();
    t.after(() => rmSync(failed.directory, { recursive: true, force: true }));
    await assert.rejects(run(failed, [['not-a-git-command']]));
    assert.ok(!existsSync(failed.directory), 'failure also cleans up within the same invocation');
  },
);
