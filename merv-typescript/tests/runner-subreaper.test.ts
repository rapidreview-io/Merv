/**
 * The owner's Linux subreaper (packages/runner/src/supervisor.mjs), run as Python runs it on a
 * host: a stand-in `ctypes` lets its prctl succeed anywhere, and a `sitecustomize` makes the
 * interpreter older, or sends a signal while the owner is being forked.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const supervisor = readFileSync(
  new URL('../packages/runner/src/supervisor.mjs', import.meta.url),
  'utf8',
);
const SUBREAPER = /const SUBREAPER = `([^`]*)`;/.exec(supervisor)![1]!;
const python = ['/usr/bin/python3', 'python3'].find(
  (candidate) => spawnSync(candidate, ['-c', 'pass']).status === 0,
);

function run(t: TestContext, owner: string, site = '') {
  const directory = mkdtempSync(join(tmpdir(), 'merv-subreaper-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    join(directory, 'ctypes.py'),
    'class CDLL:\n    def __init__(self, name): pass\n    def prctl(self, *args): return 0\n',
  );
  writeFileSync(join(directory, 'sitecustomize.py'), `import os, signal\n${site}\n`);
  return spawnSync(python!, ['-c', SUBREAPER, '/bin/sh', '-c', owner], {
    env: { PATH: '/usr/bin:/bin', PYTHONPATH: directory },
    encoding: 'utf8',
    timeout: 20_000,
  });
}

const skip = !python && 'no python3';

test(
  'the subreaper exits as its owner did on a Python without waitstatus_to_exitcode',
  { skip },
  (t) => {
    const result = run(t, 'exit 7', 'del os.waitstatus_to_exitcode');
    assert.equal(result.stderr, '');
    assert.equal(result.status, 7);
  },
);

test('an owner killed outright leaves the subreaper killed the same way', { skip }, (t) => {
  const result = run(t, 'kill -KILL $$');
  assert.equal(result.stderr, '');
  assert.equal(result.signal, 'SIGKILL');
});

test(
  'a stop that arrives while the owner is being forked still reaches the owner',
  { skip },
  (t) => {
    // The owner would sleep and exit 0; only the forwarded SIGTERM ends it otherwise.
    const result = run(
      t,
      'sleep 3',
      'fork = os.fork\ndef early():\n    os.kill(os.getpid(), signal.SIGTERM)\n    return fork()\nos.fork = early',
    );
    assert.equal(result.stderr, '');
    assert.equal(result.signal, 'SIGTERM');
  },
);
