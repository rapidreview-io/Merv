import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createApp } from './app.js';
import { check, type Credentials, type Role } from '@merv/contracts';

function options(command: string, args: string[]) {
  const result: Record<string, string> = {};
  const allowed = new Set(
    command === 'serve'
      ? ['dir', 'host', 'port', 'config']
      : command === 'init'
        ? ['dir', 'name']
        : ['dir', 'name', 'role'],
  );
  for (let i = 0; i < args.length; i++) {
    check(
      args[i].startsWith('--') && args[i + 1] && !args[i + 1].startsWith('--'),
      'arguments',
      `Expected --option value, got ${args[i]}`,
    );
    const name = args[i].slice(2);
    check(
      name !== 'config' || command === 'serve',
      'arguments',
      '--config is supported only by serve; init and actor use the minimal local state/scope configuration',
    );
    check(allowed.has(name), 'arguments', `Unknown option for ${command}: --${name}`);
    check(!Object.hasOwn(result, name), 'arguments', `Duplicate option: --${name}`);
    result[name] = args[++i];
  }
  return result;
}
async function main() {
  const command = process.argv[2] ?? 'help';
  if (command === 'help' || command === '--help') {
    console.log(`Merv TypeScript — durable tasks, evidence, independent review

  npm run init -- --name "My project" [--dir .merv]
  npm run cli -- actor --name Producer --role producer [--dir .merv]
  npm run cli -- actor --name Reviewer --role reviewer [--dir .merv]
  npm start -- [--dir .merv] [--config PATH] [--port 3081] [--host 127.0.0.1]

init writes the local operator credential to credentials.json (mode 0600).
actor writes its credential to credentials/<actor-id>.json (mode 0600).
serve --config loads a Cordis plugin configuration; --host and --port override its placeholders.
--config is supported only by serve. The configuration must provide an active API service.
Server endpoints: /health, /tools, /tools/<name>, /mcp.
All tool endpoints require Authorization: Bearer <actor token>.`);
    return;
  }
  check(['init', 'actor', 'serve'].includes(command), 'arguments', `Unknown command: ${command}`);
  const args = options(command, process.argv.slice(3)),
    directory = resolve(args.dir ?? '.merv'),
    credentialPath = join(directory, 'credentials.json');
  if (command === 'serve') {
    const port = args.port === undefined ? undefined : Number(args.port);
    check(
      port === undefined || (Number.isInteger(port) && port >= 0 && port <= 65535),
      'arguments',
      'Port must be 0–65535',
    );
    check(existsSync(credentialPath), 'not_initialized', 'Run npm run init first');
    const app = await createApp({
      directory,
      ...(args.config ? { configFile: resolve(args.config) } : { api: true }),
      ...(port !== undefined ? { port } : {}),
      ...(args.host !== undefined ? { host: args.host } : {}),
    });
    try {
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
      await app.stop();
      throw error;
    }
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
      const credentials = app.ctx.scope.bootstrap({
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
      const identity = app.ctx.scope.authenticate(operator.token);
      const credential = app.ctx.scope.issueActor(
        { actorId: identity.id, projectId: identity.projectId },
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
