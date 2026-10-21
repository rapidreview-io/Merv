import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectServer, issuer } from './fixtures/agent-login.js';

type Server = Awaited<ReturnType<typeof connectServer>>;

async function server(t: TestContext, options: Parameters<typeof connectServer>[0] = {}) {
  const f = await connectServer(options);
  t.after(() => f.close());
  return f;
}

/** An HTTP server on loopback whose handler a test writes; it records every request. */
async function listen(
  t: TestContext,
  handle: (req: IncomingMessage, res: ServerResponse, body: string) => Promise<void> | void,
) {
  const requests: { method: string; url: string; body: string }[] = [];
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString();
    requests.push({ method: req.method!, url: req.url!, body });
    await handle(req, res, body);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    http.closeAllConnections();
    return new Promise<void>((resolve) => http.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, requests };
}

/** A proxy in front of Merv that lets a test act while one matching request is held. */
async function proxy(
  t: TestContext,
  target: string,
  hold: { match?: RegExp; then?: () => Promise<void> | void } = {},
) {
  return await listen(t, async (req, res, body) => {
    if (hold.match?.test(req.url!) && hold.then) {
      const then = hold.then;
      hold.then = undefined;
      await then();
    }
    const headers: Record<string, string> = {};
    for (const name of ['authorization', 'content-type', 'accept', 'mcp-protocol-version'])
      if (typeof req.headers[name] === 'string') headers[name] = req.headers[name] as string;
    const upstream = await fetch(`${target}${req.url}`, {
      method: req.method,
      headers,
      ...(req.method === 'GET' ? {} : { body }),
      redirect: 'manual',
    });
    const type = upstream.headers.get('content-type');
    res.writeHead(upstream.status, type ? { 'content-type': type } : {});
    res.end(Buffer.from(await upstream.arrayBuffer()));
  });
}

/** The directory name the connector and the page use for `origin`. */
const hostDir = (origin: string) => new URL(origin).host.replace(/[[\]]/g, '').replaceAll(':', '_');

/** The connector `f` serves, placed for a fresh HOME as install.sh places it, speaking to `origin`
 *  (Merv itself unless a test puts something in between). */
async function connector(t: TestContext, f: Server, origin = f.url) {
  const home = mkdtempSync(join(tmpdir(), 'merv-connect-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const source = (await (await fetch(`${f.url}/connect/merv-connect.mjs`)).text()).replaceAll(
    f.url,
    origin,
  );
  const dir = join(home, '.merv', 'connect', hostDir(origin));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'merv-connect.mjs');
  writeFileSync(file, source, { mode: 0o600 });
  const env = { HOME: home, PATH: process.env.PATH!, MERV_CONNECT_TIMEOUT_MS: '3000' };
  const cli = (...args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
      execFile(process.execPath, [file, ...args], { env }, (error, stdout, stderr) =>
        resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
      ),
    );
  const stdio = () => {
    const child = spawn(process.execPath, [file], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const waiting = new Map<number, (message: any) => void>();
    const lines: string[] = [];
    const notifications: any[] = [];
    let buffer = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        lines.push(line);
        const message = JSON.parse(line);
        const resolve = waiting.get(message.id);
        if (resolve) {
          waiting.delete(message.id);
          resolve(message);
        } else notifications.push(message);
      }
    });
    let id = 0;
    const request = (method: string, params: unknown = {}) =>
      new Promise<any>((resolve) => {
        waiting.set(++id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    t.after(() => child.kill());
    return {
      request,
      call: async (name: string, args: unknown = {}) =>
        (await request('tools/call', { name, arguments: args })).result,
      lines,
      notifications,
      close: async () => {
        child.stdin.end();
        return await exited;
      },
    };
  };
  const read = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
  return { home, dir, file, cli, stdio, read, has: (name: string) => existsSync(join(dir, name)) };
}

/** Signs the connector in through its command line with the code Merv mailed. */
async function signIn(f: Server, c: Awaited<ReturnType<typeof connector>>, client = 'Codex') {
  const started = await c.cli('login', 'ada@lab.org', '--client', client);
  assert.equal(started.code, 0, started.stderr);
  const done = await c.cli('login', '--code', (await f.codeFor('ada@lab.org'))!);
  assert.equal(done.code, 0, done.stderr);
  return { started, done };
}

const human = (f: Server) =>
  f.scope.members.acceptVerifiedIdentity({
    issuer,
    subject: f.ada.human.user.subject,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
const liveKeys = async (f: Server) =>
  (await f.scope.userKeys.keys(await human(f))).filter((key) => key.revokedAt === null);

/** A key straight from /connect, as another process on this machine would get one. */
async function anotherKey(f: Server) {
  const verifier = randomBytes(32).toString('base64url');
  const started = await fetch(`${f.url}/connect/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'ada@lab.org',
      client: { name: 'Cursor', host: 'other', installId: '9d5c3a1e-5f0e-4b8c-9a39-4f1e2b7c6d99' },
      verifierHash: createHash('sha256').update(verifier).digest('base64url'),
    }),
  }).then((response) => response.json() as Promise<{ loginId: string }>);
  const issued = await fetch(`${f.url}/connect/login/${started.loginId}/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: await f.codeFor('ada@lab.org'), verifier }),
  }).then((response) => response.json() as Promise<any>);
  return {
    version: 1,
    origin: f.url,
    email: issued.email,
    keyId: issued.key.id,
    token: issued.token,
    label: issued.key.label,
    expiresAt: issued.key.expiresAt,
    issuedAt: new Date().toISOString(),
  };
}
const revoke = (f: Server, token: string) =>
  fetch(`${f.url}/account/key`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });

test('the command line signs in by emailed code and never prints the key', async (t) => {
  const f = await server(t);
  const c = await connector(t, f);
  const { started, done } = await signIn(f, c);
  assert.match(
    started.stdout,
    /^Code sent if ada@lab\.org is a Merv account in a project\. Request: [a-z]+ [a-z]+\. .* then run: merv-connect login --code <code>\.\n$/,
  );
  const phrase = /Request: ([a-z]+ [a-z]+)\./.exec(started.stdout)![1]!;
  const mail = f.mails.find((sent) => sent.subject.includes('sign-in code'))!;
  assert.ok(mail.text.includes(`Request: ${phrase}`) && mail.text.includes('Signs in: Codex on'));
  assert.match(
    done.stdout,
    /^Signed in as Ada@Lab\.org \(Codex on .+\)\. Projects: Grokking \(operator\)\. Key expires \d{4}-\d{2}-\d{2}\.\n$/,
  );
  const credentials = c.read('credentials.json');
  assert.equal(statSync(join(c.dir, 'credentials.json')).mode & 0o777, 0o600);
  assert.equal(statSync(c.dir).mode & 0o777, 0o700);
  assert.equal(c.has('pending.json'), false);
  const status = await c.cli('status');
  assert.ok(status.stdout.includes(`Key expires ${credentials.expiresAt.slice(0, 10)}`));
  assert.ok(status.stdout.includes('Grokking (operator)'));
  const again = await c.cli('login', 'ada@lab.org');
  assert.equal(again.code, 1);
  assert.match(again.stderr, /Already signed in as Ada@Lab\.org.*merv-connect logout/);
  for (const output of [started, done, status, again])
    assert.ok(!`${output.stdout}${output.stderr}`.includes('mk_'));
  assert.match(
    (await c.cli('logout')).stdout,
    /Signed out of Merv; the key for Codex on .+ is revoked\./,
  );
  assert.equal(c.has('credentials.json'), false);
  assert.equal((await revoke(f, credentials.token)).status, 401);
});

test('the stdio server answers initialize offline, then forwards to Merv once signed in', async (t) => {
  const f = await server(t);
  const offline = await connector(t, f, 'http://127.0.0.1:9');
  const lonely = offline.stdio();
  const init = await lonely.request('initialize', {
    protocolVersion: '2025-11-25',
    clientInfo: { name: 'claude-code', version: '2' },
    capabilities: {},
  });
  assert.equal(init.result.protocolVersion, '2025-11-25');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: true } });
  assert.deepEqual(init.result.serverInfo.name, 'merv');
  assert.match(init.result.instructions, /connector\.login/);
  assert.deepEqual(
    (await lonely.request('tools/list')).result.tools.map((tool: { name: string }) => tool.name),
    ['connector.status', 'connector.login'],
  );
  assert.equal(
    (await lonely.request('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion,
    '2025-06-18',
  );
  await lonely.close();

  const c = await connector(t, f);
  await signIn(f, c, 'Claude Code');
  const agent = c.stdio();
  await agent.request('initialize', {
    protocolVersion: '2025-06-18',
    clientInfo: { name: 'codex-mcp-client' },
  });
  const names = (await agent.request('tools/list')).result.tools.map(
    (tool: { name: string }) => tool.name,
  );
  assert.deepEqual(names.slice(0, 3), ['connector.status', 'connector.login', 'project.list']);
  assert.ok(names.includes('project.read') && !names.includes('connector.logout'));
  assert.ok(
    c.read('tools.json').lists[''].some((tool: { name: string }) => tool.name === 'project.list'),
  );
  const projects = JSON.parse((await agent.call('project.list')).content[0].text).projects;
  assert.deepEqual(projects, [{ ...f.ada.project, role: 'operator' }]);
  const brief = await agent.call('project.read', { action: 'brief', projectId: f.ada.project!.id });
  assert.equal(JSON.parse(brief.content[0].text).project.name, 'Grokking');
  const status = await agent.call('connector.status');
  assert.equal(status.structuredContent.signedIn, true);
  assert.equal(status.structuredContent.email, 'Ada@Lab.org');
  const refused = await agent.call('connector.login', { email: 'ada@lab.org' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /Already signed in as Ada@Lab\.org/);
  assert.ok(!agent.lines.join('\n').includes('mk_'));
});

test('connector.login signs in from the agent, and Merv tools then work without a restart', async (t) => {
  const f = await server(t);
  const c = await connector(t, f);
  const agent = c.stdio();
  await agent.request('initialize', { clientInfo: { name: 'claude-code' } });
  const notSignedIn = await agent.call('project.list');
  assert.equal(notSignedIn.isError, true);
  assert.match(notSignedIn.content[0].text, /^Not signed in to Merv on this machine/);
  const started = await agent.call('connector.login', { email: 'ada@lab.org' });
  assert.match(
    started.content[0].text,
    /^Code sent if ada@lab\.org is a Merv account in a project\. Request: [a-z]+ [a-z]+\. .* then call connector\.login with \{code\} when they give it\.$/,
  );
  const done = await agent.call('connector.login', { code: await f.codeFor('ada@lab.org') });
  assert.match(done.content[0].text, /^Signed in as Ada@Lab\.org \(Claude Code on /);
  assert.ok(
    agent.notifications.some((message) => message.method === 'notifications/tools/list_changed'),
  );
  assert.equal((await agent.call('project.list')).isError, undefined);
  assert.equal((await agent.call('connector.login', { email: 'a@b.c', code: '1' })).isError, true);
});

test('Merv answers only in its pinned shape; redirects are refused and a slow call is never replayed', async (t) => {
  const f = await server(t);
  let answer: (res: ServerResponse, id: unknown) => void = () => undefined;
  const target = await listen(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const stub = await listen(t, (req, res, body) => {
    if (req.url !== '/mcp') return void res.writeHead(404).end();
    answer(res, JSON.parse(body).id);
  });
  const c = await connector(t, f, stub.url);
  const token = `mk_${'Z'.repeat(43)}`;
  writeFileSync(
    join(c.dir, 'credentials.json'),
    JSON.stringify({
      version: 1,
      origin: stub.url,
      email: 'ada@lab.org',
      keyId: 'key_stub',
      token,
      label: 'Codex on h',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }),
    { mode: 0o600 },
  );
  const agent = c.stdio();
  const understood = /does not understand/;
  const cases: ((res: ServerResponse, id: unknown) => void)[] = [
    (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: message\ndata: {}\n\n');
    },
    (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 'someone-else', result: {} }));
    },
    (res) => res.writeHead(202).end(),
    (res, id) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ jsonrpc: '2.0', id, result: {} }]));
    },
  ];
  for (const respond of cases) {
    answer = respond;
    const result = await agent.call('project.list');
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, understood);
  }
  answer = (res) => res.writeHead(307, { location: `${target.url}/mcp` }).end();
  const redirected = await agent.call('project.list');
  assert.equal(redirected.isError, true);
  assert.equal(target.requests.length, 0, 'the redirect target receives nothing');
  const before = stub.requests.length;
  answer = () => undefined; // never answers
  const slow = await agent.call('workflow.status_and_next', { projectId: 'p' });
  assert.equal(slow.isError, true);
  assert.match(slow.content[0].text, /may still have taken effect; check before repeating it/);
  assert.equal(stub.requests.length, before + 1, 'exactly one request');
  // Redaction: a key in any model-visible field, the current token among them, never leaves.
  const leak = `mk_${'q'.repeat(43)}`;
  answer = (res, id) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `found ${leak} and ${token}` }],
          structuredContent: { nested: [{ key: leak }] },
          _meta: { note: token },
        },
      }),
    );
  };
  const redacted = await agent.call('project.list');
  assert.equal(redacted.content[0].text, 'found [redacted] and [redacted]');
  assert.deepEqual(redacted.structuredContent, { nested: [{ key: '[redacted]' }] });
  answer = (res, id) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: leak, data: { leak } },
      }),
    );
  };
  const failed = await agent.request('tools/call', { name: 'project.list', arguments: {} });
  assert.deepEqual(failed.error, {
    code: -32602,
    message: '[redacted]',
    data: { leak: '[redacted]' },
  });
  assert.ok(!agent.lines.join('\n').includes('mk_'));
});

test('two completions serialize, and one whose request was replaced revokes its own key', async (t) => {
  const f = await server(t);
  const c = await connector(t, f);
  await c.cli('login', 'ada@lab.org', '--client', 'Codex');
  const code = (await f.codeFor('ada@lab.org'))!;
  const [first, second] = await Promise.all([
    c.cli('login', '--code', code),
    c.cli('login', '--code', code),
  ]);
  assert.deepEqual([first.code, second.code].sort(), [0, 1]);
  assert.match(`${first.stderr}${second.stderr}`, /No sign-in is waiting/);
  assert.deepEqual(
    (await liveKeys(f)).map((key) => key.id),
    [c.read('credentials.json').keyId],
  );
  assert.match((await c.cli('logout')).stdout, /revoked/);

  // A completion lands after another sign-in took the request over (as a stale-lock takeover can).
  let held: Awaited<ReturnType<typeof connector>>;
  const hold = {
    match: /\/verify$/,
    then: () => {
      const pending = held.read('pending.json');
      writeFileSync(
        join(held.dir, 'pending.json'),
        JSON.stringify({ ...pending, generation: 'replaced' }),
        { mode: 0o600 },
      );
    },
  };
  const between = await proxy(t, f.url, hold);
  held = await connector(t, f, between.url);
  await held.cli('login', 'ada@lab.org');
  const late = await held.cli('login', '--code', (await f.codeFor('ada@lab.org'))!);
  assert.equal(late.code, 1);
  assert.match(late.stderr, /Another sign-in replaced this one\./);
  assert.equal(held.has('credentials.json'), false);
  assert.deepEqual(await liveKeys(f), [], 'the late key was revoked by the connector');
});

test('a 401 for an old key never removes a newer one another process stored', async (t) => {
  const f = await server(t);
  let c: Awaited<ReturnType<typeof connector>>;
  const hold: { match?: RegExp; then?: () => Promise<void> | void } = {};
  const between = await proxy(t, f.url, hold);
  c = await connector(t, f, between.url);
  await signIn(f, c);
  const agent = c.stdio();
  await agent.request('initialize', {});
  await agent.request('tools/list');
  const old = c.read('credentials.json');
  const newer = { ...(await anotherKey(f)), origin: between.url };
  assert.equal((await revoke(f, old.token)).status, 200);
  hold.match = /^\/mcp$/;
  hold.then = () =>
    writeFileSync(join(c.dir, 'credentials.json'), JSON.stringify(newer), { mode: 0o600 });
  const listed = await agent.call('project.list');
  assert.equal(listed.isError, undefined, JSON.stringify(listed));
  assert.equal(c.read('credentials.json').keyId, newer.keyId);
  // The newer key itself revoked: now the call says so, and the file goes.
  assert.equal((await revoke(f, newer.token)).status, 200);
  const refused = await agent.call('project.list');
  assert.match(refused.content[0].text, /^Not signed in to Merv on this machine/);
  assert.equal(c.has('credentials.json'), false);
  const cached = (await agent.request('tools/list')).result.tools.map(
    (tool: { name: string }) => tool.name,
  );
  assert.ok(cached.includes('project.list'), 'tools/list serves the cache');
});

test('logout racing a completion ends signed out with the key revoked, or signed in with it live', async (t) => {
  const f = await server(t);
  const c = await connector(t, f);
  await c.cli('login', 'ada@lab.org');
  const code = (await f.codeFor('ada@lab.org'))!;
  await Promise.all([c.cli('login', '--code', code), c.cli('logout')]);
  const live = await liveKeys(f);
  if (c.has('credentials.json'))
    assert.deepEqual(
      live.map((key) => key.id),
      [c.read('credentials.json').keyId],
    );
  else assert.deepEqual(live, []);
  // A lock left by a dead process is taken over.
  writeFileSync(join(c.dir, 'lock'), JSON.stringify({ pid: 2 ** 22 - 7, at: Date.now() }));
  const started = Date.now();
  assert.equal((await c.cli('logout')).code, 0);
  assert.ok(Date.now() - started < 10_000);
});

test('logout drops a waiting sign-in, so a code requested before it can no longer sign in', async (t) => {
  const f = await server(t);
  const c = await connector(t, f);
  assert.equal((await c.cli('login', 'ada@lab.org')).code, 0);
  assert.equal(c.has('pending.json'), true);
  const out = await c.cli('logout');
  assert.equal(out.stdout, 'Not signed in to Merv on this machine.\n');
  assert.equal(c.has('pending.json'), false);
  const late = await c.cli('login', '--code', (await f.codeFor('ada@lab.org'))!);
  assert.equal(late.code, 1);
  assert.match(late.stderr, /No sign-in is waiting/);
  assert.equal(c.has('credentials.json'), false);
  assert.deepEqual(await liveKeys(f), []);
});

test('every line out is redacted, property names too, on the command line and over MCP', async (t) => {
  const f = await server(t);
  const token = `mk_${'T'.repeat(43)}`;
  const planted = `mk_${'S'.repeat(43)}`;
  const stub = await listen(t, (req, res, body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/account')
      return void res.end(
        JSON.stringify({
          key: { label: 'Codex on h', expiresAt: '2027-01-01T00:00:00.000Z' },
          projects: [{ id: 'p', name: `Leak ${token} ${planted}`, role: 'operator' }],
        }),
      );
    const { id } = JSON.parse(body);
    const result = {
      content: [{ type: 'text', text: `text ${token}` }],
      structuredContent: { [planted]: planted, nested: { [`named ${token}`]: [token] } },
    };
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
  const c = await connector(t, f, stub.url);
  writeFileSync(
    join(c.dir, 'credentials.json'),
    JSON.stringify({
      version: 1,
      origin: stub.url,
      email: 'ada@lab.org',
      keyId: 'key_stub',
      token,
      label: 'Codex on h',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }),
    { mode: 0o600 },
  );
  const leaked = (text: string) => text.includes('T'.repeat(20)) || text.includes('S'.repeat(20));
  const status = await c.cli('status');
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /Projects: Leak \[redacted\] \[redacted\] \(operator\)/);
  const agent = c.stdio();
  await agent.request('initialize', { clientInfo: { name: 'codex' } });
  const result = await agent.call('project.list');
  assert.deepEqual(result.structuredContent, {
    '[redacted]': '[redacted]',
    nested: { 'named [redacted]': ['[redacted]'] },
  });
  assert.equal(
    (await agent.call('connector.status')).structuredContent.projects[0].name,
    'Leak [redacted] [redacted]',
  );
  for (const text of [status.stdout, status.stderr, ...agent.lines]) assert.ok(!leaked(text), text);
});

test('a directory or credential others can change or read is refused before any key is read', async (t) => {
  const f = await server(t);
  const c = await connector(t, f);
  await signIn(f, c);
  const refusedFor = async (path: string, mode: number, restore: number) => {
    chmodSync(path, mode);
    const status = await c.cli('status');
    chmodSync(path, restore);
    assert.equal(status.code, 1, path);
    assert.ok(status.stderr.includes(`Refusing ${path}: it is open to other users`), status.stderr);
    assert.equal(status.stdout, '');
  };
  await refusedFor(c.home, 0o777, 0o700);
  await refusedFor(join(c.home, '.merv'), 0o770, 0o700);
  await refusedFor(join(c.home, '.merv', 'connect'), 0o702, 0o700);
  await refusedFor(c.dir, 0o720, 0o700);
  await refusedFor(join(c.dir, 'credentials.json'), 0o644, 0o600);
  await refusedFor(join(c.dir, 'credentials.json'), 0o620, 0o600);
  // A ~/.merv others may only list is left as its person made it; ours are made private again.
  chmodSync(join(c.home, '.merv'), 0o755);
  chmodSync(c.dir, 0o755);
  assert.equal((await c.cli('status')).code, 0);
  assert.equal(statSync(join(c.home, '.merv')).mode & 0o777, 0o755);
  assert.equal(statSync(c.dir).mode & 0o777, 0o700);
});

test('install makes ~/.merv private, and copies in only the connector whose digest it was given', async (t) => {
  const f = await server(t);
  const c = await connector(t, f);
  // As install.sh runs it: from a download outside ~/.merv, in a HOME with no ~/.merv yet.
  const download = mkdtempSync(join(tmpdir(), 'merv-download-'));
  t.after(() => rmSync(download, { recursive: true, force: true }));
  const file = join(download, 'merv-connect.mjs');
  copyFileSync(c.file, file);
  rmSync(join(c.home, '.merv'), { recursive: true });
  const env = { HOME: c.home, PATH: '/usr/bin:/bin' };
  const install = (sha: string) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
      execFile(
        process.execPath,
        [file, 'install', sha, '/usr/local/bin/node'],
        { env },
        (error, stdout, stderr) => resolve({ code: error ? 1 : 0, stdout, stderr }),
      ),
    );
  const wrong = await install('0'.repeat(64));
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /Download check failed\. Nothing was installed\./);
  assert.equal(existsSync(c.file), false);
  const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
  const done = await install(sha);
  assert.equal(done.code, 0, done.stderr);
  const merv = join(c.home, '.merv');
  for (const dir of [merv, join(merv, 'connect'), c.dir, join(c.dir, 'bin')])
    assert.equal(statSync(dir).mode & 0o777, 0o700, dir);
  assert.equal(readFileSync(c.file, 'utf8'), readFileSync(file, 'utf8'));
  assert.equal(statSync(c.file).mode & 0o777, 0o600);
  const shim = readFileSync(join(c.dir, 'bin', 'merv-connect'), 'utf8');
  assert.ok(shim.startsWith("#!/bin/sh\nN='/usr/local/bin/node'\n"), shim);
  assert.equal(statSync(join(c.dir, 'bin', 'merv-connect')).mode & 0o777, 0o700);
});

test('a symlinked credential file or connector directory is refused', async (t) => {
  const f = await server(t);
  const c = await connector(t, f);
  const elsewhere = mkdtempSync(join(tmpdir(), 'merv-elsewhere-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  writeFileSync(join(elsewhere, 'credentials.json'), '{}', { mode: 0o600 });
  symlinkSync(join(elsewhere, 'credentials.json'), join(c.dir, 'credentials.json'));
  const status = await c.cli('status');
  assert.equal(status.code, 1);
  assert.match(status.stderr, /Refusing .*credentials\.json: it is a symlink\./);
  rmSync(join(c.dir, 'credentials.json'));
  const moved = join(elsewhere, 'moved');
  renameSync(c.dir, moved);
  symlinkSync(moved, c.dir);
  const login = await execFileStatus(
    process.execPath,
    [join(moved, 'merv-connect.mjs'), 'login', 'ada@lab.org'],
    c.home,
  );
  assert.equal(login.code, 1);
  assert.match(login.stderr, /Refusing .*: it is a symlink\./);
  assert.equal(f.mails.length, 0);
});

function execFileStatus(file: string, args: string[], home: string) {
  return new Promise<{ code: number; stderr: string }>((resolve) =>
    execFile(file, args, { env: { HOME: home, PATH: process.env.PATH! } }, (error, _out, stderr) =>
      resolve({ code: error ? 1 : 0, stderr }),
    ),
  );
}

/** Claude Code and Codex stand-ins on a PATH of their own: `mcp get` prints what a test left in
 *  `<state>/<client>-had`; every call is logged. */
function fakeClients(
  t: TestContext,
  c: Awaited<ReturnType<typeof connector>>,
  configEnv: Record<string, string> = {},
) {
  const state = mkdtempSync(join(tmpdir(), 'merv-clients-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const bin = join(state, 'bin');
  mkdirSync(bin);
  for (const client of ['claude', 'codex'])
    writeFileSync(
      join(bin, client),
      `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const had = ${JSON.stringify(join(state, `${client}-had`))};
fs.appendFileSync(${JSON.stringify(join(state, 'log'))}, '${client} ' + args.join(' ') + '\\n');
if (args[0] === 'mcp' && args[1] === 'get') {
  if (!fs.existsSync(had)) process.exit(1);
  process.stdout.write(fs.readFileSync(had));
}
if (args[0] === 'mcp' && args[1] === 'add') {
  const dir = process.env.CODEX_HOME || path.join(process.env.HOME, '.codex');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.toml');
  if (!fs.existsSync(file)) fs.writeFileSync(file, '[mcp_servers.' + args[2] + ']\\n', { mode: 0o600 });
  fs.writeFileSync(had, 'command: ' + args[4]);
}
if (args[0] === 'mcp' && args[1] === 'add-json')
  fs.writeFileSync(had, 'Command: ' + JSON.parse(args[3]).command);
// Leave config removal to the connector, so tests can check the precise approval edit.
`,
      { mode: 0o700 },
    );
  const env = {
    HOME: c.home,
    PATH: `${bin}:/usr/bin:/bin`,
    MERV_CONNECT_TIMEOUT_MS: '3000',
    ...configEnv,
  };
  return {
    had: (client: string, text: string) => writeFileSync(join(state, `${client}-had`), text),
    log: () => (existsSync(join(state, 'log')) ? readFileSync(join(state, 'log'), 'utf8') : ''),
    run: (...args: string[]) =>
      new Promise<{ code: number; out: string }>((resolve) =>
        execFile(process.execPath, [c.file, ...args], { env }, (error, stdout, stderr) =>
          resolve({ code: error ? 1 : 0, out: `${stdout}${stderr}` }),
        ),
      ),
  };
}

test('install grants only this server approval, is idempotent, and uninstall removes the grants', async (t) => {
  for (const [name, header] of [
    ['merv', '[mcp_servers.merv]'],
    ['merv-staging', '[mcp_servers."merv-staging"]'],
    ['merv-staging', "[mcp_servers.'merv-staging']"],
  ]) {
    const f = await server(t, { serverName: name });
    const c = await connector(t, f);
    const custom = name === 'merv-staging';
    const codexDir = join(c.home, custom ? 'codex-config' : '.codex');
    const claudeDir = join(c.home, custom ? 'claude-config' : '.claude');
    const clients = fakeClients(
      t,
      c,
      custom ? { CODEX_HOME: codexDir, CLAUDE_CONFIG_DIR: claudeDir } : {},
    );
    mkdirSync(codexDir);
    mkdirSync(claudeDir);
    const config = join(codexDir, 'config.toml');
    const settings = join(claudeDir, 'settings.json');
    const otherName = name === 'merv' ? 'merv-staging' : 'merv';
    const before = `# keep formatting\nmodel = "test"\n[mcp_servers.other]\ndefault_tools_approval_mode = "prompt"\n\n${header} # Merv\ncommand = "shim"\nargs = []\n\n[mcp_servers."${name}".env]\nKEEP = "yes"\n[mcp_servers.${otherName}]\ndefault_tools_approval_mode = "approve"\n`;
    const initial = {
      theme: 'dark',
      permissions: {
        deny: ['Read(.env)'],
        allow: ['Bash(git status)', `mcp__${otherName}`, `mcp__${name}__project_list`],
      },
    };
    writeFileSync(config, before, { mode: 0o640 });
    writeFileSync(settings, JSON.stringify(initial), { mode: 0o640 });
    let installed = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await clients.run('install');
      assert.equal(result.code, 0, result.out);
      assert.ok(
        result.out.includes(
          'Codex: Merv\'s tools run without asking (default_tools_approval_mode = "approve").',
        ),
        result.out,
      );
      assert.ok(
        result.out.includes(
          `Claude Code: Merv's tools are allowed without asking (permissions.allow mcp__${name}).`,
        ),
        result.out,
      );
      const after = readFileSync(config, 'utf8');
      assert.equal(
        after,
        before.replace(
          `${header} # Merv\n`,
          `${header} # Merv\ndefault_tools_approval_mode = "approve"\n`,
        ),
      );
      if (attempt) assert.equal(after, installed);
      installed = after;
      assert.equal(statSync(config).mode & 0o777, 0o640);
      assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), {
        ...initial,
        permissions: {
          ...initial.permissions,
          allow: [...initial.permissions.allow, `mcp__${name}`],
        },
      });
    }
    const copies = readdirSync(claudeDir).filter((file) => file.startsWith('settings.json.bak-'));
    assert.equal(copies.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(claudeDir, copies[0]!), 'utf8')), initial);
    assert.equal(statSync(join(claudeDir, copies[0]!)).mode & 0o777, 0o600);
    const removed = await clients.run('uninstall');
    assert.equal(removed.code, 0, removed.out);
    assert.equal(readFileSync(config, 'utf8'), before);
    assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), initial);
  }
});

test('install creates missing Claude settings and preserves an existing server allow entry', async (t) => {
  for (const existing of [undefined, {}, { permissions: { allow: ['mcp__merv'] } }]) {
    const f = await server(t);
    const c = await connector(t, f);
    const clients = fakeClients(t, c);
    const dir = join(c.home, '.claude');
    const file = join(dir, 'settings.json');
    if (existing) {
      mkdirSync(dir);
      writeFileSync(file, JSON.stringify(existing), { mode: 0o600 });
    }
    const installed = await clients.run('install');
    assert.equal(installed.code, 0, installed.out);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).permissions.allow, ['mcp__merv']);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const removed = await clients.run('uninstall');
    assert.equal(removed.code, 0, removed.out);
    assert.deepEqual(
      JSON.parse(readFileSync(file, 'utf8')).permissions.allow,
      existing?.permissions?.allow ?? [],
    );
  }
});

test('install replaces an earlier key-based Merv without printing its settings, and keeps a copy', async (t) => {
  const f = await server(t);
  const c = await connector(t, f);
  const clients = fakeClients(t, c);
  const key = `mk_${'K'.repeat(43)}`;
  const oauth = 'eyJhbGciOiJIUzI1NiJ9.oauth-secret';
  // What the old Keys page told people to run, as each client shows it back.
  clients.had(
    'claude',
    `merv:\n  Scope: User config\n  Type: http\n  URL: https://merv.example/mcp\n  Headers:\n    Authorization: Bearer ${key}\n    X-Other: Bearer ${oauth}\n`,
  );
  clients.had(
    'codex',
    `merv\n  transport: streamable_http\n  url: https://merv.example/mcp\n  http_headers: Authorization=Bearer ${key}\n`,
  );
  const codexConfig = join(c.home, '.codex', 'config.toml');
  mkdirSync(join(c.home, '.codex'));
  const toml = `[mcp_servers.merv]\nurl = "https://merv.example/mcp"\nhttp_headers = { "Authorization" = "Bearer ${key}" }\n`;
  writeFileSync(codexConfig, toml, { mode: 0o600 });
  mkdirSync(join(c.home, '.cursor'));
  writeFileSync(
    join(c.home, '.cursor', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        merv: { url: 'https://merv.example/mcp', headers: { Authorization: `Bearer ${key}` } },
      },
    }),
  );
  const shim = join(c.dir, 'bin', 'merv-connect');
  const { code, out } = await clients.run('install');
  assert.equal(code, 0, out);
  assert.ok(!out.includes('K'.repeat(20)) && !out.includes('oauth-secret'), out);
  for (const client of ['Claude Code', 'Codex', 'Cursor'])
    assert.match(out, new RegExp(`${client}: replacing an earlier "merv".*Keys page`));
  const saved = /previous config saved as (\S+config\.toml\.bak-\d+)\)/.exec(out)![1]!;
  assert.equal(readFileSync(saved, 'utf8'), toml);
  assert.equal(statSync(saved).mode & 0o777, 0o600);
  const log = clients.log();
  assert.ok(
    log.includes(`claude mcp add-json merv {"type":"stdio","command":"${shim}","args":[]} -s user`),
  );
  assert.ok(log.includes(`codex mcp add merv -- ${shim}`));
  assert.deepEqual(
    JSON.parse(readFileSync(join(c.home, '.cursor', 'mcp.json'), 'utf8')).mcpServers.merv,
    {
      type: 'stdio',
      command: shim,
      args: [],
    },
  );
});

test("install and uninstall leave another Merv server's registration alone", async (t) => {
  const f = await server(t);
  const c = await connector(t, f);
  const clients = fakeClients(t, c);
  const theirs = '/home/ada/.merv/connect/experiments.rapidreview.io/bin/merv-connect';
  clients.had('claude', `merv:\n  Type: stdio\n  Command: ${theirs}\n  Args:\n`);
  clients.had('codex', `merv\n  transport: stdio\n  command: ${theirs}\n`);
  mkdirSync(join(c.home, '.cursor'));
  const cursorConfig = JSON.stringify({ mcpServers: { merv: { type: 'stdio', command: theirs } } });
  writeFileSync(join(c.home, '.cursor', 'mcp.json'), cursorConfig);
  for (const command of ['install', 'uninstall']) {
    const { out } = await clients.run(command);
    if (command === 'install')
      for (const client of ['Claude Code', 'Codex', 'Cursor'])
        assert.ok(
          out.includes(
            `${client}: "merv" runs the connector for another Merv server (experiments.rapidreview.io), so it was left alone.`,
          ),
          out,
        );
    assert.doesNotMatch(clients.log(), /mcp (remove|add)/, command);
    assert.equal(readFileSync(join(c.home, '.cursor', 'mcp.json'), 'utf8'), cursorConfig);
  }
  // Its own registration is the one uninstall removes.
  const shim = join(c.dir, 'bin', 'merv-connect');
  clients.had('claude', `merv:\n  Type: stdio\n  Command: ${shim}\n`);
  await clients.run('uninstall');
  assert.match(clients.log(), /claude mcp remove merv -s user/);
  assert.doesNotMatch(clients.log(), /codex mcp remove/);
});

test("tools/list forwards the client's project selection, and each selection keeps its own cache", async (t) => {
  const f = await server(t);
  let up = true;
  const merv = await listen(t, (_req, res, body) => {
    const { id, params } = JSON.parse(body);
    const project = params?._meta?.['merv/projectId'];
    res.writeHead(up ? 200 : 503, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        up
          ? {
              jsonrpc: '2.0',
              id,
              result: { tools: [{ name: project ? `${project}.tool` : 'plain' }] },
            }
          : { jsonrpc: '2.0', id, error: { code: -32603, message: 'down' } },
      ),
    );
  });
  const c = await connector(t, f, merv.url);
  writeFileSync(
    join(c.dir, 'credentials.json'),
    JSON.stringify({
      origin: merv.url,
      email: 'ada@lab.org',
      keyId: 'key_1',
      token: `mk_${'a'.repeat(43)}`,
      label: 'Codex on test',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }),
    { mode: 0o600 },
  );
  const agent = c.stdio();
  await agent.request('initialize', {});
  const names = async (params: unknown) =>
    (await agent.request('tools/list', params)).result.tools
      .map((tool: { name: string }) => tool.name)
      .slice(2);
  const scoped = { _meta: { 'merv/projectId': 'p1' } };
  assert.deepEqual(await names(scoped), ['p1.tool']);
  assert.deepEqual(JSON.parse(merv.requests.at(-1)!.body).params, scoped);
  assert.deepEqual(await names({}), ['plain']);
  up = false;
  assert.deepEqual(await names(scoped), ['p1.tool']);
  assert.deepEqual(await names({}), ['plain']);
});

test('an IPv6 origin makes a working connector, in the directory the page names', async (t) => {
  const f = await server(t);
  const c = await connector(t, f, 'http://[::1]:8080');
  const help = await c.cli('help');
  assert.equal(help.code, 0, help.stderr);
  assert.equal((await c.cli('status')).stdout, 'Not signed in to Merv on this machine.\n');
  assert.deepEqual(readdirSync(join(c.home, '.merv', 'connect')), ['__1_8080']);
});

/** Runs `withLock` exactly as the connector has it in `workers` processes at once; each enters
 *  `rounds` times and logs entering and leaving. */
async function lockRace(
  t: TestContext,
  workers: number,
  rounds: number,
  before?: (dir: string) => void,
) {
  const source = readFileSync(
    new URL('../packages/scope/src/connect/merv-connect.mjs', import.meta.url),
    'utf8',
  );
  const lock = source.slice(
    source.indexOf('/** Creates `path` holding'),
    source.indexOf("// ---- Merv's HTTP API"),
  );
  const dir = mkdtempSync(join(tmpdir(), 'merv-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, 'worker.mjs');
  writeFileSync(
    script,
    `import * as fs from 'node:fs';\nimport { randomBytes, randomUUID } from 'node:crypto';\nimport { join } from 'node:path';\nconst DIR = process.argv[2];\nconst ensureDir = () => {};\nclass Refusal extends Error {}\nconst sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));\n${lock}\nfor (let i = 0; i < ${rounds}; i++)\n  await withLock(async () => {\n    fs.appendFileSync(join(DIR, 'log'), '+' + process.pid + '\\n');\n    await sleep(20);\n    fs.appendFileSync(join(DIR, 'log'), '-' + process.pid + '\\n');\n  });\n`,
  );
  before?.(dir);
  await Promise.all(
    Array.from(
      { length: workers },
      () => new Promise((resolve) => execFile(process.execPath, [script, dir], resolve)),
    ),
  );
  return readFileSync(join(dir, 'log'), 'utf8').trim().split('\n');
}
const exclusive = (log: string[]) =>
  log.every((line, at) =>
    at % 2 === 0 ? line.startsWith('+') : line === `-${log[at - 1]!.slice(1)}`,
  );

test('the sign-in lock admits one holder at a time, also while a dead holder is taken over', async (t) => {
  for (let trial = 0; trial < 4; trial++) {
    const fresh = await lockRace(t, 4, 4);
    assert.equal(fresh.length, 32);
    assert.ok(exclusive(fresh), fresh.join(' '));
    const stale = await lockRace(t, 4, 4, (dir) =>
      writeFileSync(join(dir, 'lock'), JSON.stringify({ pid: 2 ** 22 - 7, at: Date.now() })),
    );
    assert.equal(stale.length, 32);
    assert.ok(exclusive(stale), stale.join(' '));
  }
  // A lock whose holder has not written it yet (here: empty) is held, not taken over.
  const started = Date.now();
  const waited = await lockRace(t, 1, 1, (dir) => {
    writeFileSync(join(dir, 'lock'), '');
    setTimeout(() => rmSync(join(dir, 'lock')), 400);
  });
  assert.equal(waited.length, 2);
  assert.ok(Date.now() - started >= 400);
});
