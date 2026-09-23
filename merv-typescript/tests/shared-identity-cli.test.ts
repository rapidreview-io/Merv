import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT } from 'jose';
import { createApp } from './fixtures/app.js';
import { cliEnv } from './fixtures/state.js';

const exec = promisify(execFile);
const root = new URL('../', import.meta.url).pathname;
const secret = 'synthetic-cli-identity-secret-'.repeat(3);
const identityConfig = {
  supabaseUrl: 'https://identity.example.test',
  mode: 'hs256',
  secretEnv: 'MERV_CLI_TEST_SECRET',
};
async function token(subject: string) {
  return new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('https://identity.example.test/auth/v1')
    .setAudience('authenticated')
    .setSubject(subject)
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(secret));
}
function configuration(directory: string) {
  const path = join(directory, 'config.json');
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  );
  config.plugins.find((entry: { id: string }) => entry.id === 'identity').config = identityConfig;
  writeFileSync(path, JSON.stringify(config));
  return path;
}
/** The CLI opens the same PostgreSQL schema as createApp does for `directory`. */
const environment = (directory: string, bearer?: string) => ({
  PATH: process.env.PATH,
  TMPDIR: process.env.TMPDIR,
  ...cliEnv(directory),
  MERV_CLI_TEST_SECRET: secret,
  ...(bearer ? { MERV_CLI_TEST_BEARER: bearer } : {}),
});

test('local CLI adopts legacy project and explicitly repairs owned membership without exposing JWT or API', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-member-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let app = await createApp({ directory, components: ['state', 'scope'] });
  const legacy = await app.ctx.scope.bootstrap({ projectName: 'Legacy', actorName: 'Operator' });
  await app.stop();
  const path = configuration(directory);
  const first = await token('first-human');
  const args = [
    '--import',
    'tsx',
    'src/cli.ts',
    'adopt-project',
    '--dir',
    directory,
    '--config',
    path,
    '--project',
    legacy.project.id,
    '--token-env',
    'MERV_CLI_TEST_BEARER',
  ];
  const result = await exec(process.execPath, args, {
    cwd: root,
    env: environment(directory, first),
    timeout: 10_000,
  });
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.status, 'adopted');
  assert.equal(receipt.membership.subject, 'first-human');
  assert.equal(receipt.membership.role, 'operator');
  assert.equal((result.stdout + result.stderr).includes(first), false);
  assert.equal((result.stdout + result.stderr).includes(secret), false);
  const replacement = await token('replacement-human');
  await assert.rejects(
    exec(process.execPath, args, {
      cwd: root,
      env: environment(directory, replacement),
      timeout: 10_000,
    }),
    (error) => {
      assert.equal(String(error).includes(replacement), false);
      return true;
    },
  );
  const repaired = await exec(
    process.execPath,
    [...args, '--repair-reason', 'Original account is no longer recoverable'],
    { cwd: root, env: environment(directory, replacement), timeout: 10_000 },
  );
  assert.equal(JSON.parse(repaired.stdout.trim()).membership.subject, 'replacement-human');
  app = await createApp({ directory, components: ['state', 'scope'] });
  try {
    assert.equal(
      (await app.ctx.scope.authenticate(legacy.token)).id,
      legacy.actor.id,
      'Legacy key remains a separate project-bound actor',
    );
    const events = await app.ctx.state.events(legacy.project.id);
    const repair = events.find((event) => event.type === 'membership.repaired');
    assert.ok(repair);
    assert.ok(JSON.stringify(repair.data).includes('Original account is no longer recoverable'));
    assert.equal(JSON.stringify(events).includes(replacement), false);
  } finally {
    await app.stop();
  }
});

test('shared-identity CLI server starts before any local actor initialization and onboards a verified user', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-shared-first-run-'));
  const path = configuration(directory);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'serve', '--dir', directory, '--config', path, '--port', '0'],
    {
      cwd: root,
      env: environment(directory),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '',
    errors = '';
  child.stderr.on('data', (chunk) => {
    errors += chunk.toString();
  });
  const stopped = new Promise<number | null>((resolve) => child.once('close', resolve));
  t.after(async () => {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await stopped;
    clearTimeout(timer);
    rmSync(directory, { recursive: true, force: true });
  });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Shared CLI startup timed out')), 10_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      reject(new Error(`CLI exited ${code}: ${errors}`));
    });
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        try {
          const item = JSON.parse(line);
          if (item.status === 'ready') {
            clearTimeout(timer);
            resolve(item.url);
          }
        } catch {
          /* diagnostics */
        }
      }
    });
  });
  const publicConfig = await (await fetch(url + '/auth/config')).json();
  assert.deepEqual(publicConfig, { enabled: true });
  const bearer = await token('new-human');
  const account = await (
    await fetch(url + '/account', { headers: { authorization: `Bearer ${bearer}` } })
  ).json();
  assert.deepEqual(account.projects, []);
  const created = await fetch(url + '/projects', {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'First shared project', requestId: 'initial-onboarding' }),
  });
  assert.equal(created.status, 200, await created.clone().text());
  assert.ok((await created.json()).project.id);
  assert.equal(
    output.includes(bearer) ||
      errors.includes(bearer) ||
      output.includes(secret) ||
      errors.includes(secret),
    false,
  );
});
