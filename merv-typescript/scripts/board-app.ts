import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { boardModel } from './board-app-model.js';

/**
 * The board app on this computer, in one command: `npm run board`. It finds or starts a private
 * PostgreSQL in BOARD_HOME (~/.merv/board), builds what is not built, and serves one person with no
 * sign-in. With no MERV_PI_MODEL_API_KEY, or with --scripted, Pi is a scripted model and nothing
 * leaves this computer. --build builds the page again; PORT moves it from 3090.
 */
const home = process.env.BOARD_HOME ?? join(homedir(), '.merv', 'board');
const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT ?? 3090);
const run = (cwd: string, command: string, ...args: string[]) =>
  execFileSync(command, args, { cwd: join(root, cwd), stdio: ['ignore', 'ignore', 'inherit'] });

/** The folder of a PostgreSQL server, not only its clients: Homebrew's libpq has `initdb` alone. */
const serverBin = () =>
  [
    ...(process.env.PATH ?? '').split(':'),
    '/opt/homebrew/opt/postgresql@17/bin',
    '/opt/homebrew/opt/postgresql@16/bin',
    '/usr/local/opt/postgresql@17/bin',
    '/usr/lib/postgresql/17/bin',
    '/usr/lib/postgresql/16/bin',
  ].find((folder) => existsSync(join(folder, 'postgres')));

function database() {
  if (process.env.MERV_DB_URL) return;
  const dbPort = process.env.BOARD_DB_PORT ?? '55490';
  process.env.MERV_DB_URL = `postgresql://board:board@127.0.0.1:${dbPort}/board`;
  const bin = serverBin();
  if (!bin) {
    const name = `merv-board-pg-${dbPort}`;
    const docker = (...args: string[]) =>
      execFileSync('docker', args, { stdio: ['ignore', 'ignore', 'ignore'] });
    try {
      docker('start', name);
    } catch {
      docker(
        'run',
        '-d',
        '--name',
        name,
        '-p',
        `127.0.0.1:${dbPort}:5432`,
        '-e',
        'POSTGRES_USER=board',
        '-e',
        'POSTGRES_PASSWORD=board',
        '-e',
        'POSTGRES_DB=board',
        'postgres:17',
      );
    }
    return;
  }
  const data = join(home, 'pg');
  // A socket path in a deep folder is past the limit macOS sets.
  const socket = `/tmp/board-pg-${dbPort}`;
  mkdirSync(socket, { recursive: true });
  const pg = (command: string, ...args: string[]) =>
    execFileSync(join(bin, command), args, {
      env: { ...process.env, LC_ALL: 'en_US.UTF-8' },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  if (!existsSync(join(data, 'PG_VERSION'))) {
    mkdirSync(home, { recursive: true });
    pg('initdb', '-D', data, '-U', 'board', '--auth=trust', '-E', 'UTF8');
  }
  try {
    pg('pg_ctl', '-D', data, 'status');
  } catch {
    const options = `-p ${dbPort} -c listen_addresses=127.0.0.1 -c unix_socket_directories=${socket}`;
    pg('pg_ctl', '-D', data, '-w', '-l', join(home, 'pg.log'), '-o', options, 'start');
  }
  try {
    pg('createdb', '-h', '127.0.0.1', '-p', dbPort, '-U', 'board', 'board');
  } catch {
    // It is there from an earlier run.
  }
}

async function main() {
  database();
  if (
    process.argv.includes('--build') ||
    !existsSync(join(root, 'packages/ui/dist-board/index.html'))
  )
    run('packages/ui', 'npx', 'vite', 'build', '--config', 'vite.board.config.ts');
  if (!existsSync(join(root, 'packages/board/dist/fonts.json')))
    run('.', 'node', 'scripts/build-board-renderer.mjs');
  const scripted = process.argv.includes('--scripted') || !process.env.MERV_PI_MODEL_API_KEY;
  if (scripted) process.env.MERV_PI_MODEL_API_KEY = 'scripted';
  const app = await createApp({
    directory: join(home, 'data'),
    configFile: join(root, 'config/board.json'),
    port,
  });
  if (scripted) app.ctx.boardApp.machines.fetchImpl = boardModel;
  console.log(`${app.ctx.api.url}/ui/${scripted ? '   (scripted Pi: no model key)' : ''}`);
  const stop = () => void app.stop().then(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
