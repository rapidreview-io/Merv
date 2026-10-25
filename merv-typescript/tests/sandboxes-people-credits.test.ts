/**
 * New-person credits: a one-time grant per provider, or a monthly schedule from the 1st of the
 * month the person joined, each grant expiring at the next. A credit held already is left as it
 * is, so a schedule an operator paused stays paused.
 */
import { Instant } from '@sandboxes/kernel';
import assert from 'node:assert/strict';
import test from 'node:test';
import { SandboxesPeople, type NewPersonCredits } from '../packages/sandboxes/src/people.js';

function people(credits: NewPersonCredits, held: string[] = []) {
  const writes: { kind: string; input: Record<string, unknown> }[] = [];
  const person = {
    id: 'per_1',
    home_namespace: 'person-1',
    created_at: Instant.parseIso('2026-10-18T20:03:43.224Z'),
  };
  const sbx = {
    auth: { persons: { byIdentity: async () => person, ensureIdentity: async () => person } },
    accounts: { namespace: async () => ({ account_id: 'acct_1' }) },
    providers: {
      instances: async () => [],
      connections: {
        list: async () => [
          { id: 'lambda', plugin: 'lambda' },
          { id: 'modal', plugin: 'modal' },
        ],
        listEntitlements: async () => [],
        setEntitlement: async (input: Record<string, unknown>) =>
          void writes.push({ kind: 'access', input }),
      },
    },
    billing: {
      credits: {
        report: async () => ({
          grants: held.filter((id) => id.startsWith('welcome:')).map((id) => ({ id })),
          schedules: held.filter((id) => id.startsWith('monthly:')).map((id) => ({ id })),
        }),
        grant: async (input: Record<string, unknown>) => void writes.push({ kind: 'grant', input }),
        setSchedule: async (input: Record<string, unknown>) =>
          void writes.push({ kind: 'schedule', input }),
      },
    },
    db: {},
    clock: {},
  };
  return { people: new SandboxesPeople(sbx as never, credits), writes };
}
const someone = { issuer: 'https://auth.example', subject: 'user-1', label: 'Someone' };

test('a monthly credit is a schedule from the 1st of the joining month; a string is granted once', async () => {
  const { people: bridge, writes } = people({ lambda: '100', modal: { monthly: '100' } });
  await bridge.ensure(someone);
  const grant = writes.find((write) => write.kind === 'grant')!.input;
  assert.match(String(grant.id), /^welcome:lambda:[0-9a-f]{40}$/);
  assert.equal(String(grant.amount), '100');
  const schedule = writes.find((write) => write.kind === 'schedule')!.input;
  assert.equal(schedule.id, String(grant.id).replace('welcome:lambda:', 'monthly:modal:'));
  assert.equal(schedule.provider, 'modal');
  assert.equal(String(schedule.amount), '100');
  assert.ok((schedule.startsAt as Instant).equals(Instant.parseIso('2026-10-01T00:00:00Z')));
  assert.equal(schedule.cadence, 'monthly');
  assert.equal(schedule.validityPeriods, 1);
  assert.equal(schedule.enabled, true);
  // Each credit gives the account access to that provider's operator connection.
  assert.deepEqual(
    writes.filter((write) => write.kind === 'access').map((write) => write.input.connectionId),
    ['lambda', 'modal'],
  );
});

test('a schedule held already, paused or not, is not written again', async () => {
  const first = people({ modal: { monthly: '100' } });
  await first.people.ensure(someone);
  const id = String(first.writes.find((write) => write.kind === 'schedule')!.input.id);
  const again = people({ modal: { monthly: '100' } }, [id]);
  await again.people.ensure(someone);
  assert.deepEqual(
    again.writes.filter((write) => write.kind !== 'access'),
    [],
  );
});
