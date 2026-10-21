/** Real plugin-bundled MCP checks in two fresh model sessions per installed client.
 * Uses existing model credentials privately; Merv consent is synthetic.
 * This does not test browser account sign-in or production. */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile, chmod } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from 'cordis';
import { scopeToolsPlugin } from '@merv/scope/tools';
import { createService } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { OAuth } from '@merv/scope/oauth';
import { oauthRoutes } from '@merv/scope/oauth-api';
import { setupRoutes } from '@merv/scope/setup';
import { packageFiles, packageName } from '@merv/scope/client-package';
import { scopeRoutes } from '@merv/scope/api';
import { ApiServer, ToolRegistry } from '@merv/api';
import { openState } from '../tests/fixtures/state.js';

const loginOnly = process.argv.includes('--login-only');
if (!loginOnly && process.env.MERV_ALLOW_MODEL_TESTS !== '1')
  throw new Error(
    'Set MERV_ALLOW_MODEL_TESTS=1 to authorize paid model calls and private reuse of local model credentials.',
  );

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
const context = new Context();
context.provide('scope', scope);
context.provide('tools', tools);
await context.plugin(scopeToolsPlugin);
const called: string[] = [];
const invoke = tools.invoke.bind(tools);
tools.invoke = async (...args) => {
  called.push(args[0]);
  return invoke(...args);
};
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
async function run(bin: string, args: string[], env: NodeJS.ProcessEnv, login = false) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const interactive = bin === 'claude' && args[0] === 'mcp' && args[1] === 'login';
    const child = spawn(
      interactive ? 'python3' : bin === 'codex' ? (process.env.MERV_CODEX_BIN ?? bin) : bin,
      interactive
        ? [
            fileURLToPath(new URL('../tests/fixtures/client-terminal.py', import.meta.url)),
            bin,
            ...args,
          ]
        : args,
      { env, cwd: root, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    if (args[0] === 'exec' || args[0] === '-p') child.stdin.end();
    let output = '',
      handled = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${bin} ${args.slice(0, 2).join(' ')} timed out`));
    }, 240000);
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
            const callback = await oauth.consent(id, person, true);
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

const prompt =
  'Use Merv for a read-only connection check. Read the installed Merv research skill, then use only the plugin-bundled MCP tools to list projects and read the project brief. Report the exact project name and your role. Do not add standalone MCP servers, do not read credential files, and do not use HTTP or shell to replace an MCP tool call. If authentication is needed, report the exact bundled server name and supported sign-in action. This is an isolated test; do not write or run experiments.';
try {
  for (const bin of ['codex', 'claude']) {
    const dir = join(root, bin);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(bin === 'codex' ? { CODEX_HOME: dir } : { CLAUDE_CONFIG_DIR: dir }),
      BROWSER: 'true',
    };
    if (bin === 'codex') {
      if (!loginOnly) {
        await copyFile(join(homedir(), '.codex', 'auth.json'), join(dir, 'auth.json'));
        await chmod(join(dir, 'auth.json'), 0o600);
      }
      await writeFile(
        join(dir, 'config.toml'),
        'model = "gpt-6-astra"\nmcp_oauth_credentials_store = "file"\n',
      );
    } else if (!loginOnly) {
      const stored = JSON.parse(
        execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      );
      env.CLAUDE_CODE_OAUTH_TOKEN = stored.claudeAiOauth.accessToken;
    }
    const market = await run(bin, ['plugin', 'marketplace', 'add', marketplace], env);
    const installed = await run(
      bin,
      ['plugin', bin === 'codex' ? 'add' : 'install', `${name}@${name}`],
      env,
    );
    if (market.code || installed.code) throw new Error(bin + ' plugin installation failed');
    const serverName = bin === 'codex' ? name : `plugin:${name}:${name}`;
    const login = await run(
      bin,
      ['mcp', 'login', serverName, ...(bin === 'claude' ? ['--no-browser'] : [])],
      env,
      true,
    );
    if (login.code)
      throw new Error(
        bin + ' bundled OAuth failed: ' + login.output.replace(/https?:\/\/[^\s]+/g, '[URL]'),
      );
    console.log(
      JSON.stringify({ client: bin, bundledNativeLogin: true, serverName, code: login.code }),
    );
    if (loginOnly) continue;

    for (let session = 1; session <= 2; session++) {
      const before = called.length;
      const model = await run(
        bin,
        bin === 'codex'
          ? [
              'exec',
              '--json',
              '--ephemeral',
              '--skip-git-repo-check',
              '--sandbox',
              'read-only',
              prompt,
            ]
          : [
              '-p',
              prompt,
              '--output-format',
              'stream-json',
              '--verbose',
              '--allowedTools',
              'Skill',
              'Read',
              `mcp__plugin_${name}_${name}__project_list`,
              `mcp__plugin_${name}_${name}__project_read`,
            ],
        env,
      );
      const events = model.output.split('\n').flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      const codexCommands = events
        .filter((e) => e.type === 'item.completed' && e.item?.type === 'command_execution')
        .map((e) => e.item.command);
      const claudeUses = events
        .flatMap((e) => e.message?.content ?? [])
        .filter((e) => e.type === 'tool_use');
      const skillRead =
        codexCommands.some((c) => c.includes('skills/research/SKILL.md')) ||
        claudeUses.some(
          (e) =>
            (e.name === 'Skill' && String(e.input?.skill).includes('research')) ||
            (e.name === 'Read' && String(e.input?.file_path).includes('skills/research/SKILL.md')),
        );
      const final =
        events.filter((e) => e.type === 'result').at(-1)?.result ??
        events.filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message').at(-1)
          ?.item.text;
      const evidence = {
        client: bin,
        session,
        code: model.code,
        calls: called.slice(before),
        skillRead,
        toolUses: claudeUses.map((e) => e.name),
        final,
      };
      console.log(JSON.stringify(evidence));
      if (
        model.code ||
        !evidence.calls.includes('project.read') ||
        !skillRead ||
        !String(final).includes(project.name)
      )
        throw new Error('Bundled model acceptance failed for ' + bin + ' session ' + session);
    }
  }
} finally {
  await api.stop();
  await tools.close();
  await state.close();
  await rm(root, { recursive: true, force: true });
}
