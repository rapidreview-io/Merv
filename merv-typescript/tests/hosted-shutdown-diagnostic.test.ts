import assert from 'node:assert/strict';
import test from 'node:test';
import { shutdownDiagnostic } from '../scripts/hosted-runner/shutdown-diagnostic.js';

test('shutdown status retains a useful fixed code without copying command output', () => {
  const failure = Object.assign(new Error('https://user:secret@example.test/repo'), {
    code: 'workspace_git_timeout',
    detail: 'git fetch: secret working-copy content',
  });
  assert.equal(shutdownDiagnostic(failure), 'workspace_git_timeout');
  assert.equal(
    shutdownDiagnostic({ code: 'assignment_cleanup_failed' }),
    'assignment_cleanup_failed',
  );
});

test('shutdown status does not disclose arbitrary error codes or messages', () => {
  for (const failure of [
    undefined,
    null,
    'secret',
    new Error('secret'),
    { code: 'secret' },
    { code: 42 },
  ])
    assert.equal(shutdownDiagnostic(failure), 'shutdown_operation_failed');
});
