#!/usr/bin/env node
/**
 * One command for the board as command centre: `npm run demo:command-center`.
 * Makes a throwaway workspace, starts the seeded server with the Agent and the experiment, and dials
 * the connector out to it. Real `claude` and `codex` run only inside that throwaway directory, under
 * whatever login they already hold here. Needs a local Postgres (MERV_DB_URL, default the local one).
 * `--no-connector` leaves the machine offline, to see what a phone sees.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.PORT ?? '3210';
const url = `http://127.0.0.1:${port}`;
const database = process.env.MERV_DB_URL ?? 'postgres://127.0.0.1:5432/merv_command_center';
if (!process.env.MERV_DB_URL) spawnSync('createdb', ['-h', '127.0.0.1', 'merv_command_center']);

const workspace = mkdtempSync(join(tmpdir(), 'board-workspace-'));
const steps = 40;
const loss = Array.from({ length: steps }, (_, step) => {
  const value = step < 22 ? 2.4 * Math.exp(-step / 6) + 0.31 : 0.31 + 0.005 * Math.sin(step);
  return `${step * 100},${value.toFixed(4)}`;
});
writeFileSync(join(workspace, 'loss.csv'), `step,loss\n${loss.join('\n')}\n`);
writeFileSync(join(workspace, 'package.json'), `${JSON.stringify({ name: 'loss-glance', type: 'module', private: true }, null, 2)}\n`);
const git = (...args) => spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
git('init', '-q');
git('add', '.');
git('-c', 'user.name=demo', '-c', 'user.email=demo@localhost', 'commit', '-qm', 'A training log');

if (!existsSync(join(root, 'packages/ui/dist/index.html')) || process.argv.includes('--build-ui'))
  spawnSync('npm', ['run', 'build:ui'], { cwd: root, stdio: 'inherit' });
if (!existsSync(join(root, 'packages/board/dist/renderer.js')))
  spawnSync('npm', ['run', 'build:board-renderer'], { cwd: root, stdio: 'inherit' });

const server = spawn('node', ['--import', 'tsx', 'scripts/ui-demo.ts', '--agent', '--command'], {
  cwd: root,
  env: { ...process.env, PORT: port, MERV_DB_URL: database, BOARD_WORKSPACE: workspace },
  stdio: ['pipe', 'pipe', 'inherit'],
});
let held = '';
let connector;
const lines = createInterface({ input: server.stdout });
const report = (operator, board) => {
  console.log(`\nBoard    ${url}/ui/boards/${board ?? ''}`);
  console.log(`Sign in  paste the operator token below into the page`);
  console.log(`         ${operator}`);
  console.log(`Worksp.  ${workspace}`);
  console.log(`Ask Pi   "Distil this board into tasks with measurable checks."\n`);
};
let board;
lines.on('line', (line) => {
  held += `${line}\n`;
  const boardLine = /"commandCenterBoard":"([^"]+)"/.exec(line);
  if (boardLine) board = boardLine[1];
  if (!line.startsWith('}') || !held.includes('"status": "ready"')) return;
  const start = held.lastIndexOf('\n{', held.indexOf('"status": "ready"'));
  const ready = JSON.parse(held.slice(start + 1));
  const operator = ready.tokens.operator;
  report(operator, board);
  writeFileSync(join(workspace, '..', `board-demo-${port}.json`), JSON.stringify({ url, operator, board, workspace }));
  if (process.argv.includes('--no-connector')) return;
  connector = spawn(
    'node',
    [join(root, '../clients/board-connect/connect.mjs'), '--server', url, '--key', operator, '--workspace', workspace, '--name', 'Mac', '--trust-checks'],
    { stdio: 'inherit' },
  );
});
const stop = () => {
  connector?.kill();
  server.stdin.write('quit\n');
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('close', () => process.exit(0));
