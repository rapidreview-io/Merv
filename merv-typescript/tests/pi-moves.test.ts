import test from 'node:test';
import assert from 'node:assert/strict';
import { moveNotes, moveRefusal, moveTool, type PiMoveContext } from '../packages/pi/src/moves.js';
import { switchMachineInput } from '../packages/pi/src/schema.js';
import { piModelToolName } from '../packages/pi/src/tool-names.js';
import type { PiMachine, PiMove, PiSlot } from '../packages/pi/src/types.js';

const now = Date.parse('2026-09-24T14:30:00.000Z');
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const standard: PiMachine = {
  key: 'standard',
  label: 'Standard',
  vcpu: 0.5,
  memoryGiB: 4,
  diskGB: 8,
  maxHourlyUsd: 0.074,
};
const large: PiMachine = {
  key: 'large',
  label: 'Large',
  vcpu: 2,
  memoryGiB: 8,
  diskGB: 16,
  maxHourlyUsd: 0.22,
};
const slot = (machine: string): PiSlot => ({
  allocationId: `allocation-${machine}`,
  allocationEpoch: 1,
  epoch: 1,
  machine,
  expiresAt: ago(-120),
  workerId: `worker-${machine}`,
  enrolledAt: ago(30),
  readyAt: ago(30),
});
/** An agent move in another conversation that failed long enough ago to trip no hourly rule. */
const move = (minutes: number, fields: Partial<PiMove> = {}): PiMove => ({
  at: ago(minutes),
  by: 'agent',
  from: 'standard',
  to: 'large',
  outcome: 'failed',
  conversationId: 'conversation-2',
  ...fields,
});
function context(
  fields: Partial<PiMoveContext> = {},
  person: Partial<PiMoveContext['person']> = {},
): PiMoveContext {
  return {
    now,
    enabled: true,
    host: {
      id: 'pih_1',
      key: 'user-1:project-1',
      userId: 'user-1',
      status: 'live',
      source: {
        kind: 'actor',
        actorId: 'pi-host',
        projectId: 'host',
        credentialId: 'c',
        expiresAt: null,
      },
      epoch: 1,
      revision: 1,
      current: slot('standard'),
      next: null,
      draining: null,
      idleSince: null,
      createdAt: ago(30),
      ended: null,
    },
    person: {
      key: 'user-1:project-1',
      preferred: 'standard',
      sticky: null,
      choseAt: null,
      moves: [],
      ...person,
    },
    conversationId: 'conversation-1',
    current: standard,
    targets: [large],
    ...fields,
  };
}
const refusal = (fields: Partial<PiMoveContext>, person: Partial<PiMoveContext['person']> = {}) =>
  moveRefusal(context(fields, person), 'large');

test('the agent may move up to a machine the person could choose, without asking', () => {
  const tool = moveTool(context());
  assert.ok(tool);
  assert.equal(piModelToolName(tool.name), 'switch_machine');
  assert.equal(
    tool.description,
    "Move to a bigger machine. You run on Standard (½ vCPU, 4 GiB, 8 GB disk), shared with this person's other conversations. Large has 2 vCPU, 8 GiB, 16 GB disk and costs about 3× as much. Use it only when the machine limits the work (out of memory or disk, far too slow); the model is the same. This answer finishes here; later turns run on Large once ready. Files do not carry over; the conversation does. Say what failed in `reason`.",
  );
  assert.deepEqual(tool.inputSchema, {
    type: 'object',
    properties: {
      machine: { type: 'string', enum: ['large'] },
      reason: { type: 'string', minLength: 10, maxLength: 300 },
    },
    required: ['machine', 'reason'],
    additionalProperties: false,
  });
  // The schema the model sees admits exactly what the service parses.
  assert.ok(switchMachineInput.safeParse({ machine: 'large', reason: 'x'.repeat(10) }).success);
  assert.ok(!switchMachineInput.safeParse({ machine: 'large', reason: 'x'.repeat(9) }).success);
  assert.ok(!switchMachineInput.safeParse({ machine: 'large', reason: 'x'.repeat(301) }).success);
  assert.equal(moveRefusal(context(), 'large'), null);
});

test('switch_machine is not offered while agent moves are switched off', () => {
  assert.equal(moveTool(context({ enabled: false })), null);
  assert.deepEqual(refusal({ enabled: false }), { code: 'machine_unavailable' });
});

test('switch_machine is not offered where the person may not choose another machine', () => {
  // No Sandboxes connection in the project, or less than write: the service passes no targets.
  assert.equal(moveTool(context({ targets: [] })), null);
  assert.deepEqual(refusal({ targets: [] }), { code: 'machine_unavailable' });
  assert.deepEqual(moveRefusal(context(), 'huge'), { code: 'machine_unavailable' });
});

test('the agent only moves up', () => {
  const onLarge = { current: large, targets: [large, standard] };
  assert.equal(moveTool(context(onLarge)), null);
  assert.deepEqual(moveRefusal(context(onLarge), 'standard'), { code: 'machine_unavailable' });
  // More cores with less disk is not bigger.
  const sideways = { ...large, key: 'wide', diskGB: 4 };
  assert.equal(moveTool(context({ targets: [sideways] })), null);
  assert.deepEqual(moveRefusal(context({ targets: [sideways] }), 'wide'), {
    code: 'machine_unavailable',
  });
});

test('one move at a time: a move under way or a machine still draining refuses another', () => {
  const host = context().host;
  const next = {
    ...slot('large'),
    by: 'agent' as const,
    reason: 'out of memory',
    conversationId: 'conversation-1',
    readyBy: ago(-2),
  };
  assert.deepEqual(refusal({ host: { ...host, next } }), { code: 'move_in_progress' });
  assert.equal(moveTool(context({ host: { ...host, next } })), null);
  assert.deepEqual(refusal({ host: { ...host, draining: slot('standard') } }), {
    code: 'move_in_progress',
  });
});

test('one agent move per conversation per hour, so at most one per answer', () => {
  const moves = [move(20, { conversationId: 'conversation-1' })];
  assert.deepEqual(refusal({}, { moves }), { code: 'move_limit', retryAfterSeconds: 40 * 60 });
  assert.equal(moveTool(context({}, { moves })), null);
  assert.equal(refusal({ conversationId: 'conversation-2' }, { moves: [move(61)] }), null);
  assert.equal(refusal({}, { moves: [move(20)] }), null, "another conversation's move");
});

test('at most three agent moves a day, and the longest wait is the one reported', () => {
  const moves = [move(23 * 60), move(12 * 60), move(2 * 60)];
  assert.deepEqual(refusal({}, { moves }), { code: 'move_limit', retryAfterSeconds: 60 * 60 });
  assert.equal(refusal({}, { moves: moves.slice(1) }), null);
  assert.equal(refusal({}, { moves: [move(25 * 60), ...moves.slice(1)] }), null);
  assert.equal(
    refusal({}, { moves: moves.map((entry) => ({ ...entry, by: 'person' as const })) }),
    null,
    "the person's own moves do not count",
  );
  const later = [move(23 * 60 + 50), move(12 * 60), move(40, { conversationId: 'conversation-1' })];
  assert.deepEqual(refusal({}, { moves: later }), {
    code: 'move_limit',
    retryAfterSeconds: 20 * 60,
  });
});

test('ten minutes on a machine between moves; a deadline rollover is not a move', () => {
  const moved = move(4, { by: 'person', from: 'large', to: 'standard', outcome: 'moved' });
  const rollover = move(2, { by: 'deadline', from: 'standard', to: 'standard', outcome: 'moved' });
  assert.deepEqual(refusal({}, { moves: [moved, rollover] }), {
    code: 'move_limit',
    retryAfterSeconds: 6 * 60,
  });
  assert.equal(refusal({}, { moves: [{ ...moved, at: ago(11) }, rollover] }), null);
});

test('hidden for an hour after the person picks a smaller machine', () => {
  const picked = { preferred: 'standard', choseAt: ago(20) };
  assert.deepEqual(refusal({}, picked), { code: 'move_limit', retryAfterSeconds: 40 * 60 });
  assert.equal(moveTool(context({}, picked)), null);
  assert.equal(refusal({}, { ...picked, choseAt: ago(61) }), null);
  assert.equal(refusal({}, { preferred: 'large', choseAt: ago(20) }), null, 'the person chose it');
});

test('hidden for an hour after two failed moves', () => {
  const failed = [move(50, { by: 'person' }), move(30, { by: 'deadline', to: 'standard' })];
  assert.deepEqual(refusal({}, { moves: failed }), {
    code: 'move_limit',
    retryAfterSeconds: 10 * 60,
  });
  assert.equal(moveTool(context({}, { moves: failed })), null);
  assert.equal(refusal({}, { moves: failed.slice(1) }), null);
});

test('notes tell a turn its machine, a move under way, and a recent move that did not happen', () => {
  assert.deepEqual(moveNotes(context()), ['Machine: Standard (½ vCPU, 4 GiB, 8 GB disk).']);
  const moved = move(27, { outcome: 'moved', conversationId: 'conversation-1' });
  assert.deepEqual(moveNotes(context({ current: large, targets: [large] }, { moves: [moved] })), [
    'Machine: Large (2 vCPU, 8 GiB, 16 GB disk) since 14:03 UTC.',
  ]);
  assert.deepEqual(moveNotes(context({}, { moves: [move(5, { reason: 'no free machine' })] })), [
    'Machine: Standard (½ vCPU, 4 GiB, 8 GB disk).',
    'The move to Large failed (no free machine); still on Standard.',
  ]);
  assert.equal(
    moveNotes(context({}, { moves: [move(5, { outcome: 'cancelled' })] })).at(-1),
    'The move to Large was cancelled; still on Standard.',
  );
  assert.equal(
    moveNotes(context({}, { moves: [move(61)] })).length,
    1,
    'an old failure is dropped',
  );
  const host = context().host;
  const next = {
    ...slot('large'),
    by: 'person' as const,
    reason: '',
    conversationId: null,
    readyBy: ago(-2),
  };
  assert.equal(
    moveNotes(context({ host: { ...host, next } })).at(-1),
    'A move to Large is starting; this answer stays here.',
  );
  const long = moveNotes(context({}, { moves: [move(5, { reason: 'x'.repeat(400) })] }));
  assert.ok(long.every((note) => note.length <= 300));
});
