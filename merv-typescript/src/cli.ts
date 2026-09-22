import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from 'cordis';
import { runnerWith, validateRunnerConfig } from '@merv/runner';
import { createApp } from './app.js';
import { uploadArtifact } from './artifact-upload.js';
import { defaultConfigFile, loadConfiguration } from './config.js';
import type {} from '@merv/identity/types';
import { check, MervError, type Credentials, type Role } from '@merv/contracts';

function options(command: string, args: string[]) {
  const result: Record<string, string> = {};
  const allowed = new Set(
    command === 'artifact-upload'
      ? ['url', 'file', 'token-env', 'project', 'title', 'media-type']
      : command === 'code-import'
        ? ['url', 'repository', 'ref', 'token-env', 'project']
        : command === 'code-restore'
          ? ['root', 'project', 'at', 'deployment', 'verify-only', 'overwrite']
          : command === 'runner'
            ? ['config']
            : command === 'serve'
              ? ['dir', 'host', 'port', 'config']
              : command === 'adopt-project'
                ? ['dir', 'project', 'config', 'token-env', 'repair-reason']
                : command === 'init'
                  ? ['dir', 'name']
                  : ['dir', 'name', 'role'],
  );
  /** The only options that stand alone; every other still needs its value. */
  const standalone = new Set(command === 'code-restore' ? ['verify-only', 'overwrite'] : []);
  for (let i = 0; i < args.length; i++) {
    const alone = args[i].startsWith('--') && standalone.has(args[i].slice(2));
    check(
      args[i].startsWith('--') && (alone || (args[i + 1] && !args[i + 1].startsWith('--'))),
      'arguments',
      `Expected --option value, got ${args[i]}`,
    );
    const name = args[i].slice(2);
    check(
      name !== 'config' || ['serve', 'adopt-project', 'runner'].includes(command),
      'arguments',
      '--config is supported only by serve, adopt-project and runner; init and actor use the minimal local state/scope configuration',
    );
    check(allowed.has(name), 'arguments', `Unknown option for ${command}: --${name}`);
    check(!Object.hasOwn(result, name), 'arguments', `Duplicate option: --${name}`);
    result[name] = alone ? 'true' : args[++i];
  }
  return result;
}

async function runMachine(configPath: string) {
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    // JSON parser excerpts and filesystem errors must not echo configuration contents.
    throw new MervError('invalid_runner_config', 'Runner configuration must be readable JSON');
  }
  const parsed = validateRunnerConfig(input);
  const base = dirname(configPath);
  const config = {
    ...parsed,
    directory: resolve(base, parsed.directory),
    ...(parsed.workspace && 'repository' in parsed.workspace
      ? {
          workspace: {
            ...parsed.workspace,
            repository: resolve(base, parsed.workspace.repository),
          },
        }
      : {}),
    profiles: parsed.profiles.map((profile) => ({
      ...profile,
      executable: profile.executable.includes('/')
        ? resolve(base, profile.executable)
        : profile.executable,
    })),
  };
  // A fixed, single-provider composition has no server services or configuration
  // substitution. In particular, command argv remains literal JSON data.
  const ctx = new Context();
  let stopping: Promise<void> | undefined;
  const dispose = () => (stopping ??= ctx.fiber.dispose());
  const stop = () => {
    void dispose().then(
      () => process.exit(0),
      () => {
        console.error(
          JSON.stringify({ error: 'runner_shutdown_failed', message: 'Runner shutdown failed' }),
        );
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const drivers =
      parsed.workspaceDrivers?.length === 0
        ? []
        : [(await import('@merv/code/driver/index')).codeWorkspaceDriver];
    const fiber = ctx.plugin(runnerWith(drivers), config);
    await fiber.await();
    if (stopping) return;
    const runner = ctx.get('runner');
    check(runner, 'runner_unavailable', 'Runner provider failed to start', 503);
    console.log(
      JSON.stringify({
        status: 'ready',
        mode: 'runner',
        directory: config.directory,
        runner: runner.snapshot(),
        plugins: [{ id: 'runner', name: '@merv/runner', state: 'active' }],
      }),
    );
  } catch (error) {
    await dispose();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    throw error;
  }
}

async function main() {
  const command = process.argv[2] ?? 'help';
  if (command === 'help' || command === '--help') {
    console.log(`Merv TypeScript — durable tasks, evidence, independent review

  npm run init -- --name "My project" [--dir .merv]
  npm run cli -- actor --name Producer --role producer [--dir .merv]
  npm run cli -- actor --name Reviewer --role reviewer [--dir .merv]
  npm run cli -- adopt-project --project ID --config PATH --token-env ENV_NAME [--dir .merv] [--repair-reason TEXT]
  npm run cli -- runner --config PATH
  npm run cli -- artifact-upload --url URL --file PATH --token-env ENV_NAME [--project ID] [--title TEXT] [--media-type TYPE]
  npm run cli -- code-import --url URL --repository PATH --ref REF --token-env ENV_NAME [--project ID]
  npm run cli -- code-restore [--verify-only] [--root PATH] [--project ID] [--at STAMP] [--deployment NAME] [--overwrite]
  npm start -- [--dir .merv] [--config PATH] [--port 3081] [--host 127.0.0.1]

init writes the local operator credential to credentials.json (mode 0600).
actor writes its credential to credentials/<actor-id>.json (mode 0600).
serve loads config/default.json unless --config names another Cordis plugin configuration;
--host and --port override its placeholders. The browser UI is served at <url>/ui when built.
serve requires local initialization or an enabled shared identity provider.
adopt-project verifies a human JWT from the named environment variable and grants the
local host administrator's selected account ownership of a legacy project. It loads
only state/scope/identity. --repair-reason explicitly permits audited repair of an
already owned project; this authority is never exposed through HTTP or agent tools.
Server endpoints: /health, /auth/config, /account, /account/keys, /projects, /tools, /tools/<name>, /mcp, /ui.
Human owners manage machine keys through /account/keys or the UI. Tool endpoints
require a bearer; shared users and account keys explicitly select a project.
runner loads a machine-only Cordis composition from a runner JSON configuration.
Its credentialEnv names an existing environment variable; never put a bearer in JSON.
Its directory and executable paths containing '/' resolve relative to that config.
Bare executable names use PATH; command arguments remain literal and run from the
assigned workspace. SIGINT/SIGTERM stops owned workers and releases their leases.
artifact-upload reads a local file (up to 2 MB) and calls artifact.create through MCP.
It prints only the artifact receipt; file/base64 contents never pass through the agent prompt.
code-import brings one branch or tag of a local Git repository into the repository the server
keeps for a project, as a project administrator. It cuts a bundle that leaves out what the
server already holds, sends it in parts and waits for admission; the local repository is only
read. It prints the operation, with findings when the history was refused. A history larger
than one transfer (512 MiB) is imported oldest first, one ref at a time.
code-restore reads the verified copies the server writes to object storage. It takes the
bucket, endpoint, credentials and prefix from MERV_BLOB_*, and the deployment segment from
MERV_TS_DB_SCHEMA unless --deployment names another. --verify-only downloads each object,
checks it against its manifest and asks Git to verify each bundle, writing nothing: it is the
drill, and it is safe to run against a live deployment. Without it, --root names where
repositories are written; the command takes the writer lock, so a running server refuses it
with code_repository_locked. A repository already in that root that holds refs the copy does
not is refused rather than rewound; --overwrite forces the copy over it and destroys whatever
was admitted since. The database copy is only verified, never applied: restore it
with the database's own tool before starting the server.`);
    return;
  }
  check(
    [
      'init',
      'actor',
      'serve',
      'adopt-project',
      'runner',
      'artifact-upload',
      'code-import',
      'code-restore',
    ].includes(command),
    'arguments',
    `Unknown command: ${command}`,
  );
  const args = options(command, process.argv.slice(3)),
    directory = resolve(args.dir ?? '.merv'),
    credentialPath = join(directory, 'credentials.json');
  if (command === 'artifact-upload') {
    check(
      args.url &&
        args.file &&
        args['token-env'] &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(args['token-env']),
      'arguments',
      'artifact-upload requires --url URL --file PATH --token-env ENV_NAME',
    );
    const token = process.env[args['token-env']];
    check(token, 'arguments', 'The named credential environment variable is empty');
    console.log(
      JSON.stringify(
        await uploadArtifact({
          url: args.url,
          file: resolve(args.file),
          token,
          projectId: args.project,
          title: args.title,
          mediaType: args['media-type'],
        }),
      ),
    );
    return;
  }
  if (command === 'code-import') {
    const { importRepository } = await import('./code-import.js');
    check(
      args.url &&
        args.repository &&
        args.ref &&
        args['token-env'] &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(args['token-env']),
      'arguments',
      'code-import requires --url URL --repository PATH --ref REF --token-env ENV_NAME',
    );
    const token = process.env[args['token-env']];
    check(token, 'arguments', 'The named credential environment variable is empty');
    const operation = await importRepository({
      url: args.url,
      repository: resolve(args.repository),
      ref: args.ref,
      token,
      projectId: args.project,
    });
    console.log(JSON.stringify(operation));
    if (operation.status !== 'completed') process.exitCode = 1;
    return;
  }
  if (command === 'code-restore') {
    const { restoreCode } = await import('./code-restore.js');
    const { S3BackupStore } = await import('@merv/code/store/backup');
    const environment = (name: string) => {
      const value = process.env[name]?.trim();
      check(value, 'arguments', `code-restore needs ${name} in the environment`);
      return value;
    };
    const verifyOnly = args['verify-only'] === 'true';
    check(
      verifyOnly || args.root,
      'arguments',
      'code-restore writes into --root PATH, or checks the copies with --verify-only',
    );
    const store = new S3BackupStore({
      bucket: environment('MERV_BLOB_BUCKET'),
      endpoint: environment('MERV_BLOB_ENDPOINT_URL'),
      accessKeyId: environment('MERV_BLOB_ACCESS_KEY_ID'),
      secretAccessKey: environment('MERV_BLOB_SECRET_ACCESS_KEY'),
      region: process.env.MERV_BLOB_REGION,
      prefix: process.env.MERV_BLOB_PREFIX,
    });
    try {
      const report = await restoreCode({
        store,
        deployment: args.deployment ?? environment('MERV_TS_DB_SCHEMA'),
        ...(args.root ? { root: resolve(args.root) } : {}),
        ...(args.project ? { projectId: args.project } : {}),
        ...(args.at ? { at: args.at } : {}),
        ...(args.overwrite === 'true' ? { overwrite: true } : {}),
        verifyOnly,
      });
      console.log(JSON.stringify(report));
      if (report.problems.length) process.exitCode = 1;
    } finally {
      await store.close();
    }
    return;
  }
  if (command === 'runner') {
    check(args.config, 'arguments', 'runner requires --config PATH');
    await runMachine(resolve(args.config));
    return;
  }
  if (command === 'serve') {
    const port = args.port === undefined ? undefined : Number(args.port);
    check(
      port === undefined || (Number.isInteger(port) && port >= 0 && port <= 65535),
      'arguments',
      'Port must be 0–65535',
    );
    const app = await createApp({
      directory,
      configFile: args.config ? resolve(args.config) : defaultConfigFile,
      ...(port !== undefined ? { port } : {}),
      ...(args.host !== undefined ? { host: args.host } : {}),
    });
    // A signal that lands right after the ready line must find its handler already in place.
    const stop = () => {
      void app.stop().then(
        () => process.exit(0),
        (error) => {
          console.error(error);
          process.exit(1);
        },
      );
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      check(
        existsSync(credentialPath) || app.ctx.get('identity')?.configuration().enabled,
        'not_initialized',
        'Run npm run init first or configure shared identity',
      );
      const api = app.ctx.get('api');
      check(
        api && typeof api.url === 'string' && api.url.length > 0,
        'api_unavailable',
        'serve requires a configured, active API service',
        503,
      );
      console.log(
        JSON.stringify({
          status: 'ready',
          url: api.url,
          mcp: `${api.url}/mcp`,
          directory,
          plugins: app.status().map(({ id, name, state, required, missingDependencies }) => ({
            id,
            name,
            state,
            required,
            missingDependencies,
          })),
        }),
      );
    } catch (error) {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      await app.stop();
      throw error;
    }
    return;
  }
  if (command === 'adopt-project') {
    check(
      args.project && args.config && args['token-env'],
      'arguments',
      'adopt-project requires --project, --config and --token-env',
    );
    check(
      /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(args['token-env']),
      'arguments',
      'Invalid token environment variable name',
    );
    const bearer = process.env[args['token-env']];
    check(
      bearer,
      'missing_credential',
      'The named environment variable must contain a human access token',
    );
    const configuration = loadConfiguration({ directory, configFile: resolve(args.config) });
    const ids = ['state', 'scope', 'identity'];
    const plugins = configuration.entries.filter((entry) => ids.includes(entry.id));
    check(
      ids.every((id) => plugins.some((entry) => entry.id === id && !entry.disabled)),
      'invalid_config',
      'Local membership migration requires active state, scope and identity entries',
    );
    const app = await createApp({
      directory,
      config: {
        plugins: plugins.map((entry) => ({
          ...entry,
          name: entry.name.startsWith('.')
            ? fileURLToPath(new URL(entry.name, configuration.baseUrl))
            : entry.name,
        })),
      },
    });
    try {
      const identity = await app.ctx.identity.verify(bearer);
      const principal = await app.ctx.scope.acceptVerifiedIdentity(identity);
      const membership = await app.ctx.scope.adoptProject(
        principal,
        args.project,
        args['repair-reason'] === undefined ? undefined : { repairReason: args['repair-reason'] },
      );
      console.log(JSON.stringify({ status: 'adopted', membership }));
    } finally {
      await app.stop();
    }
    return;
  }
  const app = await createApp({ directory, components: ['state', 'scope'] });
  try {
    if (command === 'init') {
      check(
        !existsSync(credentialPath),
        'already_initialized',
        'This directory already has operator credentials',
      );
      const credentials = await app.ctx.scope.bootstrap({
        projectName: args.name ?? 'Merv project',
        actorName: 'Local operator',
      });
      writeFileSync(credentialPath, JSON.stringify(credentials, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      console.log(
        JSON.stringify({ project: credentials.project, actor: credentials.actor, credentialPath }),
      );
    } else {
      const operator = JSON.parse(readFileSync(credentialPath, 'utf8')) as Credentials;
      const identity = await app.ctx.scope.authenticate(operator.token);
      const credential = await app.ctx.scope.issueActor(
        {
          actorId: identity.id,
          projectId: identity.projectId,
          credentialId: identity.credential.id,
        },
        { name: args.name ?? '', role: args.role as Role },
      );
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(directory, 'credentials'), { recursive: true, mode: 0o700 });
      const actorPath = join(directory, 'credentials', `${credential.actor.id}.json`);
      writeFileSync(
        actorPath,
        JSON.stringify({ project: operator.project, ...credential }, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
      console.log(JSON.stringify({ actor: credential.actor, credentialPath: actorPath }));
    }
  } finally {
    await app.stop();
  }
}
main().catch((error) => {
  console.error(JSON.stringify({ error: error.code ?? 'error', message: error.message }));
  process.exitCode = 1;
});
