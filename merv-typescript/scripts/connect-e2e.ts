/**
 * Agent sign-in end to end, as a person's agent does it: two local Merv servers (one standing in
 * for staging), `curl … /connect/install.sh | sh` for each into a temporary HOME with stand-in
 * `claude` and `codex` commands and a Cursor directory, sign-in with the code from Merv's capture
 * mailer, the installed shim spoken to as Claude Code speaks to an MCP server, and logout.
 *
 *   MERV_TEST_POSTGRES_URL=postgres://127.0.0.1:5432/merv_test npm run test:connect
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectServer } from '../tests/fixtures/agent-login.js';
import { codexStandIn } from '../tests/fixtures/connect-clients.js';
import { parse as parseToml } from 'smol-toml';

const sh = (command: string, env: Record<string, string>) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
    execFile('/bin/sh', ['-c', command], { env }, (error, stdout, stderr) =>
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
    ),
  );

/** Speaks newline-delimited JSON-RPC to `command` over stdio, as an MCP client does. */
function mcp(command: string, env: Record<string, string>) {
  const child = spawn(command, [], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map<number, (message: any) => void>();
  let buffer = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      waiting.get(message.id)?.(message);
    }
  });
  let id = 0;
  const request = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve) => {
      waiting.set(++id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  return { request, close: () => child.kill('SIGINT') };
}

test('an agent installs the connector, signs in by emailed code, uses Merv and signs out', async (t) => {
  const prod = await connectServer();
  const staging = await connectServer({ serverName: 'merv-staging' });
  t.after(async () => {
    await prod.close();
    await staging.close();
  });
  const home = mkdtempSync(join(tmpdir(), 'merv-connect-e2e-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // Stand-ins for the clients: each logs its arguments.
  const bin = join(home, 'stand-ins');
  const log = join(home, 'clients.log');
  mkdirSync(bin);
  for (const name of ['claude', 'codex']) {
    writeFileSync(
      join(bin, name),
      `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, '${name} ' + args.join(' ') + '\\n');
${name === 'codex' ? codexStandIn() : ''}
`,
    );
    chmodSync(join(bin, name), 0o755);
  }
  mkdirSync(join(home, '.cursor'));
  const env = {
    HOME: home,
    PATH: `${bin}:${join(process.execPath, '..')}:/usr/bin:/bin`,
  };
  const install = (url: string) => sh(`curl -fsSL ${url}/connect/install.sh | sh`, env);

  for (const server of [prod, staging]) {
    const installed = await install(server.url);
    assert.equal(installed.code, 0, installed.stderr);
    assert.match(installed.stdout, /Restart the client to load Merv\./);
  }
  const shim = (url: string) =>
    join(home, '.merv', 'connect', new URL(url).host.replace(':', '_'), 'bin', 'merv-connect');
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  for (const [server, name] of [
    [prod, 'merv'],
    [staging, 'merv-staging'],
  ] as const) {
    const entry = JSON.stringify({ type: 'stdio', command: shim(server.url), args: [] });
    for (const call of [
      `claude mcp get ${name}`,
      `claude mcp remove ${name} -s local`,
      `claude mcp remove ${name} -s user`,
      `claude mcp add-json ${name} ${entry} -s user`,
      `codex mcp remove ${name}`,
      `codex mcp get ${name} --json`,
    ])
      assert.ok(calls.includes(call), `${call}\n${calls.join('\n')}`);
    assert.ok(existsSync(shim(server.url)));
  }
  assert.notEqual(shim(prod.url), shim(staging.url));
  const codex = parseToml(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')) as any;
  for (const [name, url] of [
    ['merv', prod.url],
    ['merv-staging', staging.url],
  ])
    assert.deepEqual(
      { ...codex.mcp_servers[name!] },
      {
        command: shim(url!),
        args: [],
        default_tools_approval_mode: 'approve',
      },
    );
  assert.deepEqual(
    JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).permissions.allow,
    ['mcp__merv', 'mcp__merv-staging'],
  );
  const cursor = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(cursor.mcpServers).sort(), ['merv', 'merv-staging']);
  assert.equal(cursor.mcpServers.merv.command, shim(prod.url));
  assert.equal(cursor.mcpServers['merv-staging'].command, shim(staging.url));

  // A symlinked ~/.merv/connect: the installer refuses and writes nothing.
  const connect = join(home, '.merv', 'connect');
  const moved = join(home, 'moved-connect');
  renameSync(connect, moved);
  symlinkSync(moved, connect);
  const before = readdirSync(moved, { recursive: true }).sort();
  const refused = await install(prod.url);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /Refusing .*\/\.merv\/connect: it is a symlink\./);
  assert.deepEqual(readdirSync(moved, { recursive: true }).sort(), before);
  rmSync(connect);
  renameSync(moved, connect);
  assert.ok(!lstatSync(connect).isSymbolicLink());

  // Sign in on the command line, with the code Merv mailed.
  const run = (...args: string[]) =>
    sh([shim(prod.url), ...args].map((arg) => `'${arg}'`).join(' '), env);
  const started = await run('login', 'ada@lab.org', '--client', 'Claude Code');
  assert.equal(started.code, 0, started.stderr);
  const code = await prod.codeFor('ada@lab.org');
  assert.ok(code, 'a code email arrived');
  const signedIn = await run('login', '--code', code!);
  assert.equal(signedIn.code, 0, signedIn.stderr);
  assert.match(signedIn.stdout, /^Signed in as Ada@Lab\.org \(Claude Code on /);
  const notice = prod.mails.at(-1)!;
  assert.match(notice.subject, /^New Merv agent sign-in: Claude Code on /);
  assert.ok(notice.text.includes(`${prod.url}/ui/settings/keys`));
  assert.equal(staging.mails.length, 0, 'staging was never asked');

  // The shim as Claude Code starts it.
  const agent = mcp(shim(prod.url), env);
  t.after(() => agent.close());
  const init = await agent.request('initialize', {
    protocolVersion: '2025-06-18',
    clientInfo: { name: 'claude-code', version: '2.1.304' },
    capabilities: {},
  });
  assert.equal(init.result.serverInfo.name, 'merv');
  const tools = (await agent.request('tools/list')).result.tools.map(
    (tool: { name: string }) => tool.name,
  );
  assert.ok(tools.includes('project.list') && tools.includes('project.read'));
  const list = await agent.request('tools/call', { name: 'project.list', arguments: {} });
  const [project] = JSON.parse(list.result.content[0].text).projects;
  assert.equal(project.name, 'Grokking');
  const brief = await agent.request('tools/call', {
    name: 'project.read',
    arguments: { action: 'brief', projectId: project.id },
  });
  assert.equal(JSON.parse(brief.result.content[0].text).project.id, project.id);

  // Logout revokes the key at Merv.
  const credentials = JSON.parse(
    readFileSync(join(shim(prod.url), '..', '..', 'credentials.json'), 'utf8'),
  );
  const out = await run('logout');
  assert.match(out.stdout, /Signed out of Merv; the key for Claude Code on .+ is revoked\./);
  const refusedKey = await fetch(`${prod.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credentials.token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(refusedKey.status, 401);
  assert.equal(((await refusedKey.json()) as { connect: string }).connect, '/connect');
});
