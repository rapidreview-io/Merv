import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RunnerControlError } from '@merv/runner/client';
import { diagnostic } from '@merv/runner/diagnostic';

test('real filesystem and copy failures retain a bounded cause without paths', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'runner-diagnostic-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'private-assignment-file');
  const target = join(directory, 'private-assignment-directory');
  writeFileSync(file, 'private data');
  mkdirSync(target);
  assert.throws(
    () => mkdirSync(file),
    (error) => {
      assert.equal(diagnostic(error), 'runner_filesystem_exists');
      return true;
    },
  );
  assert.throws(
    () => cpSync(file, target, { recursive: true }),
    (error) => {
      assert.equal(diagnostic(error), 'runner_copy_file_to_directory');
      return true;
    },
  );
});

test('capacity and permission errors are named but arbitrary diagnostics stay private', () => {
  assert.equal(
    diagnostic({ code: 'ENOSPC', message: 'secret', path: '/secret' }),
    'runner_filesystem_no_space',
  );
  assert.equal(diagnostic({ code: 'EDQUOT' }), 'runner_filesystem_quota');
  assert.equal(diagnostic({ code: 'EACCES' }), 'runner_filesystem_access_denied');
  for (const error of [
    null,
    undefined,
    new Error('secret'),
    { code: 'PRIVATE_secret' },
    { code: '../secret' },
  ])
    assert.equal(diagnostic(error), 'runner_operation_failed');
  assert.equal(diagnostic({ code: 'workspace_foreign_checkout' }), 'workspace_foreign_checkout');
  assert.equal(
    diagnostic(new RunnerControlError('workspace_transfer_lost', 409)),
    'workspace_transfer_lost',
  );
});
