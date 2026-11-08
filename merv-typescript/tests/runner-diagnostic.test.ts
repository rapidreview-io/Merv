import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RunnerControlError } from '@merv/runner/client';
import { diagnostic } from '@merv/runner/diagnostic';

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
