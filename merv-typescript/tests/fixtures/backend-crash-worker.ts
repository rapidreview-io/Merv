/** Real State/DomainEvents process; all crash hooks live in this test fixture. */
import assert from 'node:assert/strict';
import { createService, type Transaction } from '@merv/contracts';
import { DurableEvents } from '@merv/domain-events';
import { PostgresState } from '@merv/state';
import { processBarrier, processResult } from './process-barrier.js';

export type CrashPoint = 'before-commit' | 'after-commit' | 'none';
export type CrashRole = 'publish' | 'consume';
export type CrashEvidence = {
  role: CrashRole;
  point: CrashPoint;
  pid: number;
  backendPid: number;
  eventId: number;
  records: number;
  effects: number;
  cursor: number;
};
export type CrashResult = { published: number[]; handled: number[] };

const [schema, role, point] = process.argv.slice(2) as [string, CrashRole, CrashPoint];
assert.match(schema, /^t_[a-z0-9_]+$/);
assert.ok(['publish', 'consume'].includes(role));
assert.ok(['before-commit', 'after-commit', 'none'].includes(point));
// A parent killed by a test-runner timeout must not leave a paused orphan behind.
const exitIfOrphaned = () => process.exit(1);
process.on('disconnect', exitIfOrphaned);
const watchdog = setTimeout(() => {
  console.error('Backend crash worker exceeded its lifetime');
  process.exit(1);
}, 20_000);

const state = await PostgresState.open({
  connectionString: process.env.MERV_TEST_POSTGRES_URL!,
  schema,
  maxConnections: 1,
  readConnections: 1,
  connectionTimeoutMs: 5000,
  statementTimeoutMs: 5000,
  lockTimeoutMs: 5000,
});
let events: DurableEvents | undefined;
let evidence: CrashEvidence | undefined;
const result: CrashResult = { published: [], handled: [] };

async function staged(tx: Transaction, eventId: number) {
  const own = (await tx.get<Pick<CrashEvidence, 'backendPid' | 'records' | 'effects' | 'cursor'>>(`
    SELECT pg_backend_pid() AS "backendPid",
      (SELECT count(*) FROM publisher_rows) AS records,
      (SELECT count(*) FROM local_effects) AS effects,
      COALESCE((SELECT cursor FROM event_consumers WHERE id='worker'), 0) AS cursor
  `))!;
  evidence = { role, point, pid: process.pid, eventId, ...own };
  if (point === 'before-commit') await processBarrier(evidence);
}

try {
  if (role === 'consume') {
    events = await createService(new DurableEvents(state));
    // Only scheduling is controlled. Production delivery SQL and transactions are untouched.
    Object.defineProperty(events, 'scheduleWake', { value: () => {} });
    await events.drain();
    await events.subscribe({
      id: 'worker',
      types: ['probe.wanted'],
      from: 'beginning',
      async handle(event, tx) {
        result.handled.push(event.id);
        await tx.run('INSERT INTO local_effects VALUES(?)', event.id);
        await staged(tx, event.id);
      },
    });
  }
  // Pause after the real transaction (including COMMIT) but before its caller sees success.
  // Registration above is excluded; only a transaction that actually staged work can pause.
  const transaction = state.transaction.bind(state);
  state.transaction = async <T>(fn: (tx: Transaction) => T | Promise<T>): Promise<T> => {
    const value = await transaction(fn);
    if (point === 'after-commit' && evidence) {
      const committed = evidence;
      evidence = undefined;
      await processBarrier(committed);
    }
    return value;
  };
  if (role === 'publish') {
    await state.transaction(async (tx) => {
      const event = await state.appendEvent(tx, {
        projectId: 'p',
        actorId: 'a',
        subjectId: 's',
        type: 'probe.wanted',
        data: {},
      });
      await tx.run('INSERT INTO publisher_rows VALUES(?)', event.id);
      await staged(tx, event.id);
      result.published.push(event.id);
    });
  } else {
    await events!.drain();
  }
} finally {
  await events?.close();
  await state.close();
  clearTimeout(watchdog);
}
// Intentional disconnect after a successful operation must not trigger orphan cleanup.
process.off('disconnect', exitIfOrphaned);
await processResult(result);
