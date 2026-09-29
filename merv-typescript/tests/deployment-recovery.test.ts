import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const cwd = fileURLToPath(new URL('../', import.meta.url));
const options = { skip: !process.env.MERV_TEST_POSTGRES_URL, timeout: 300_000 };
const childEnv = { ...process.env };
// A separate test process must emit its own report, not use the parent's IPC test mode.
delete childEnv.NODE_TEST_CONTEXT;

test('deployment snapshots restore real PostgreSQL and Git through failures', options, async () => {
  const result = await run('python3', ['deploy/recovery-snapshot.test.py'], {
    cwd,
    timeout: 290_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.match(result.stderr, /\bOK\b/);
});

test('restored Code journals recover and accept another checkpoint', options, async () => {
  const result = await run(
    process.execPath,
    ['--import', 'tsx', '--test', 'deploy/recovery-journal-fixture.mjs'],
    { cwd, env: childEnv, timeout: 290_000, maxBuffer: 2 * 1024 * 1024 },
  );
  assert.match(result.stdout, /# fail 0\b/);
});
