import assert from 'node:assert/strict';
import test from 'node:test';

import { sessionOutcome } from './agentSessionOutcome.js';

test('an offer that expired before an agent attached is not presented as interrupted', () => {
  assert.deepEqual(
    sessionOutcome({ status: 'expired', close_reason: 'lease_expired', activated_at: null }),
    { label: 'Not started', tone: 'quiet' },
  );
});

test('a running agent whose lease expires is presented as a lost connection', () => {
  assert.deepEqual(
    sessionOutcome({
      status: 'expired',
      close_reason: 'lease_expired',
      activated_at: '2026-08-15T12:00:00Z',
    }),
    { label: 'Connection lost', tone: 'error' },
  );
});

test('launch and process failures use specific labels', () => {
  assert.deepEqual(
    sessionOutcome({ status: 'released', close_reason: 'launch_failed' }),
    { label: 'Could not start', tone: 'error' },
  );
  assert.deepEqual(
    sessionOutcome({ status: 'released', close_reason: 'host_process_crash_loop' }),
    { label: 'Agent crashed', tone: 'error' },
  );
});

test('a user-stopped session is presented as stopped', () => {
  assert.deepEqual(
    sessionOutcome({ status: 'released', close_reason: 'dispatch_halted' }),
    { label: 'Stopped', tone: 'quiet' },
  );
  assert.deepEqual(
    sessionOutcome({ status: 'expired', close_reason: 'halted_by_user' }),
    { label: 'Stopped', tone: 'quiet' },
  );
});
