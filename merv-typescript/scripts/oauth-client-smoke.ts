/** Real installed CLI transport checks with isolated configuration and a synthetic consent
 * boundary. This does NOT test browser account sign-in, a fresh LLM chat, or production. */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { OAuth } from '@merv/scope/oauth';
import { oauthRoutes } from '@merv/scope/oauth-api';
import { setupRoutes } from '@merv/scope/setup';
import { packageFiles, packageName } from '@merv/scope/client-package';
import { scopeRoutes } from '@merv/scope/api';
import { ApiServer, ToolRegistry } from '@merv/api';
import { openState } from '../tests/fixtures/state.js';

const root = await mkdtemp(join(tmpdir(), 'merv-oauth-client-'));
const state = await openState();
const scope = await createService(new ProjectScope(state));
const person = await scope.members.acceptVerifiedIdentity({
  issuer: 'https://test-identity.invalid',
  subject: 'test-person',
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
});
const project = await scope.members.createProject(person, {
  name: 'Isolated OAuth client check',
  requestId: 'client-check',
});
const tools = new ToolRegistry(scope, scope.toolPolicy);
const identity = {
  configuration: () => ({ enabled: false }),
  verify: async () => {
    throw new Error('Browser identity is outside this test');
  },
};
const api = new ApiServer(scope, tools, { port: 55442 }, identity);
const origin = await api.start();
const oauth = new OAuth(state, scope, origin);
await oauth.initialize();
const route = oauthRoutes(oauth, identity);
api.mount('/oauth', route, { public: true });
api.mount('/.well-known', route, { public: true });
api.mount('/connect', setupRoutes(origin), { public: true });
api.mount('/account', scopeRoutes(scope));
let authenticatedRequests = 0;
api.oauth({
  metadataUrl: `${origin}/.well-known/oauth-protected-resource/mcp`,
  authenticate: (t) => {
    authenticatedRequests++;
    return oauth.authenticate(t);
  },
});
const name = packageName(origin);
const marketplace = join(root, 'plugins');
for (const [path, text] of Object.entries(packageFiles(origin))) {
  const file = join(marketplace, path);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, text);
}
const results: Record<string, unknown> = {
  caveat: 'Real client binaries; synthetic consent, no browser identity or model chat.',
};
async function run(bin: string, args: string[], env: NodeJS.ProcessEnv, login = false) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const interactive = bin === 'claude' && args[0] === 'mcp' && args[1] === 'login';
    const child = spawn(
      interactive ? 'python3' : bin,
      interactive
        ? [
            fileURLToPath(new URL('../tests/fixtures/client-terminal.py', import.meta.url)),
            bin,
            ...args,
          ]
        : args,
      { env, cwd: root, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let output = '',
      handled = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${bin} ${args.slice(0, 2).join(' ')} timed out`));
    }, 45000);
    const collect = (data: Buffer) => {
      output += data.toString();
      if (login && !handled) {
        const match = output.match(
          /http:\/\/127\.0\.0\.1:55442\/oauth\/authorize\?[^\s\x00-\x1f\x7f]+/,
        );
        if (match) {
          handled = true;
          void (async () => {
            const response = await fetch(match[0], { redirect: 'manual' });
            if (!response.headers.get('location')) {
              const body = await response.json();
              throw new Error(
                JSON.stringify({
                  status: response.status,
                  oauth: body,
                  parameterNames: [...new URL(match[0]).searchParams.keys()],
                }),
              );
            }
            const id = new URL(response.headers.get('location')!).pathname.split('/').at(-1)!;
            const callback = await oauth.consent(id, person, project.id, true);
            if (interactive) child.stdin.write(callback + '\n');
            else await fetch(callback); // Real client's callback listener and PKCE token exchange.
          })().catch((e) => {
            child.kill('SIGTERM');
            reject(e);
          });
        }
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}
try {
  for (const bin of ['codex', 'claude']) {
    const dir = join(root, bin);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const env = {
      ...process.env,
      ...(bin === 'codex' ? { CODEX_HOME: dir } : { CLAUDE_CONFIG_DIR: dir }),
      BROWSER: 'true',
    };
    if (bin === 'codex')
      await writeFile(
        join(dir, 'config.toml'),
        'mcp_oauth_credentials_store = "file"\n[mcp_servers.unrelated]\nurl = "http://127.0.0.1:1/mcp"\n',
      );
    const addMarket = await run(bin, ['plugin', 'marketplace', 'add', marketplace], env);
    const install = await run(
      bin,
      ['plugin', bin === 'codex' ? 'add' : 'install', `${name}@${name}`],
      env,
    );
    const bundled = await run(bin, ['mcp', 'list'], env);
    results[`${bin}Plugin`] = {
      marketplace: addMarket.code,
      install: install.code,
      bundledMcpVisible: bundled.output.includes(origin),
    };
    // Direct registration is checked in isolation, after uninstalling the bundled connection.
    const remove = await run(
      bin,
      ['plugin', bin === 'codex' ? 'remove' : 'uninstall', `${name}@${name}`],
      env,
    );
    results[`${bin}PluginRemoval`] = remove.code;
    const add = await run(
      bin,
      bin === 'codex'
        ? ['mcp', 'add', name, '--url', `${origin}/mcp`]
        : ['mcp', 'add', '--transport', 'http', '--scope', 'user', name, `${origin}/mcp`],
      env,
      true,
    );
    const login = await run(
      bin,
      ['mcp', 'login', name, ...(bin === 'claude' ? ['--no-browser'] : [])],
      env,
      true,
    );
    // A new CLI process must find the saved connection; no credential file is inspected.
    const beforeRequests = authenticatedRequests;
    const inspect = await run(bin, ['mcp', 'get', name], env);
    results[`${bin}Direct`] = {
      add: add.code,
      login: login.code,
      newProcessGet: inspect.code,
      newProcessAuthenticatedRequests: authenticatedRequests - beforeRequests,
      connected: /Connected|Successfully logged in|Successfully authenticated/i.test(
        inspect.output + ' ' + login.output,
      ),
      ...(login.code
        ? {
            error: login.output
              .replace(/https?:\/\/[^\s]+/g, '[URL]')
              .replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]'),
          }
        : {}),
    };
    if (bin === 'codex')
      results.unrelatedPreserved = (await readFile(join(dir, 'config.toml'), 'utf8')).includes(
        '[mcp_servers.unrelated]',
      );
    await run(bin, ['mcp', 'logout', name], env);
  }
} finally {
  await api.stop();
  await tools.close();
  await state.close();
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify(results, null, 2));
}

for (const bin of ['codex', 'claude']) {
  const plugin = results[`${bin}Plugin`] as { marketplace: number; install: number };
  const direct = results[`${bin}Direct`] as { add: number; login: number; newProcessGet: number };
  if (
    plugin.marketplace ||
    plugin.install ||
    results[`${bin}PluginRemoval`] ||
    direct.add ||
    direct.login ||
    direct.newProcessGet
  )
    process.exitCode = 1;
}
