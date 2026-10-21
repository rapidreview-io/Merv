/** Disposable real Task/Workflow services and installed plugins for interactive permission
 * checks. Consent is synthetic. No dispatcher, cloud machine or production endpoint.
 * Stop with SIGTERM after closing native clients; schema and private directories are removed. */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, copyFile, chmod } from 'node:fs/promises';
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
import { ArtifactStore } from '@merv/artifacts';
import { DiskBlobs } from '@merv/blobs';
import { RecipeContextBuilder } from '@merv/context-builder';
import { PaperService } from '@merv/paper';
import { ReviewService } from '@merv/reviews';
import { TaskService } from '@merv/tasks';
import { WorkflowsService } from '@merv/workflows';
import { taskToolsPlugin } from '@merv/tasks/tools';
import { workflowToolsPlugin } from '@merv/workflows/tools';
import { managedServices } from '../tests/fixtures/managed-services.js';

if (process.env.MERV_ALLOW_MODEL_TESTS !== '1')
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
const owner = await scope.members.caller(person, project.id);
const artifacts = await createService(
  new ArtifactStore(state, scope, new DiskBlobs(join(root, 'blobs'))),
);
const workflows = await createService(new WorkflowsService(state, scope));
const reviews = await createService(new ReviewService(state, scope, artifacts));
const builder = await createService(new RecipeContextBuilder(state, scope, artifacts));
const paper = await createService(new PaperService(state, scope, artifacts));
const managed = await managedServices({ state, scope, artifacts, workflows, reviews }, root, owner);
const tasks = await createService(
  new TaskService(state, scope, artifacts, workflows, reviews, builder, managed.code, paper),
);
context.provide('tasks', tasks);
context.provide('workflows', workflows);
await context.plugin(taskToolsPlugin);
await context.plugin(workflowToolsPlugin);
await paper.patch(owner, {
  kind: 'problem',
  expectedRevision: 0,
  requestId: 'fixture-problem',
  changes: ['problem', 'scope', 'goals', 'constraints'].map((id) => ({
    id,
    content:
      'Disposable native-client permission test: create and read harmless task records only. No dispatch, workers, machines or production.',
  })),
});
const invoke = tools.invoke.bind(tools);
tools.invoke = async (...args) => {
  const result = await invoke(...args);
  if (args[0] === 'task.write' || args[0] === 'task.read') {
    console.log(JSON.stringify({ nativeTool: args[0], input: args[2] }));
    await writeFile(
      join(root, 'task-records.json'),
      JSON.stringify(
        (await tasks.list(owner)).map((t) => ({
          id: t.id,
          title: t.title,
          goal: t.goal,
          state: t.workflow.state,
        })),
      ),
    );
  }
  return result;
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
api.oauth({
  metadataUrl: `${origin}/.well-known/oauth-protected-resource/mcp`,
  authenticate: (t) => oauth.authenticate(t),
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
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(bin === 'codex' ? { CODEX_HOME: dir } : { CLAUDE_CONFIG_DIR: dir }),
      BROWSER: 'true',
      DISABLE_AUTOUPDATER: '1',
    };
    if (bin === 'codex') {
      await copyFile(join(homedir(), '.codex', 'auth.json'), join(dir, 'auth.json'));
      await chmod(join(dir, 'auth.json'), 0o600);
      await writeFile(
        join(dir, 'config.toml'),
        'model = "gpt-6-astra"\nmcp_oauth_credentials_store = "file"\n',
      );
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
  }
  await writeFile(
    join(root, 'fixture.json'),
    JSON.stringify({ root, name, projectId: project.id, pid: process.pid }),
  );
  console.log(JSON.stringify({ ready: true, root, name, projectId: project.id }));
  await new Promise<void>((resolve) => {
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
  });
} finally {
  await api.stop();
  await tools.close();
  await managed.close();
  await paper.close();
  await builder.close();
  await reviews.close();
  await workflows.close();
  await state.close();
  await rm(root, { recursive: true, force: true });
}
