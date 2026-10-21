import assert from 'node:assert/strict';
import test from 'node:test';
import { CodeGitRemote } from '@merv/code/store/http';
import { bootMaintenance } from '@merv/contracts/maintenance';
import { writerFixture } from './code-writers.js';
import { SandboxesPeople } from '../../packages/sandboxes/src/people.js';

test('native startup preserves prepared journal while fenced; normal startup and explicit recovery settle it', async (t) => {
  const f = await writerFixture(t);
  const remote = new CodeGitRemote(f.state, f.scope, f.core.repositories, f.core.writers);
  await remote.initialize();
  await f.state.transaction((tx) =>
    tx.run(
      "INSERT INTO code_git_pushes(id,project_id,payload_json,status,created_at) VALUES(?,?,?,'prepared',?)",
      'startup-push',
      f.admin.projectId,
      JSON.stringify({
        projectId: f.admin.projectId,
        actorId: f.admin.actorId,
        updates: [{ old: '0'.repeat(40), next: f.root, ref: 'refs/heads/unreceived' }],
      }),
      new Date().toISOString(),
    ),
  );
  const row = () =>
    f.state.read((sql) =>
      sql.get<{ status: string; outcome_json: string | null }>(
        'SELECT * FROM code_git_pushes WHERE id=?',
        'startup-push',
      ),
    );
  const before = await row();
  await remote.initialize();
  if (bootMaintenance.active) assert.deepEqual(await row(), before);
  else assert.equal((await row())!.status, 'rejected');
  // The operator's explicit reconciliation remains usable; only initialize's automatic call is gated.
  await remote.recover();
  assert.equal((await row())!.status, 'rejected');
});

test('people backfill and sign-in notifications pause; normal startup and explicit operator effects remain usable', async () => {
  const calls: string[] = [];
  const person = { issuer: 'issuer', subject: 'subject' };
  const people = new SandboxesPeople(
    {
      auth: {
        persons: {
          byIdentity: async () => null,
          ensureIdentity: async () => {
            calls.push('identity');
            return { id: 'person', home_namespace: 'home', created_at: '2026-10-21T00:00:00Z' };
          },
        },
      },
      accounts: {
        namespace: async () => ({ account_id: 'acct' }),
        linked: async () => ({ account_id: 'acct' }),
      },
      providers: {
        instances: async () => {
          calls.push('providers');
        },
        connections: {
          list: async () => [{ id: 'conn', plugin: 'test' }],
          listEntitlements: async () => [],
          setEntitlement: async () => {
            calls.push('entitlement');
          },
        },
      },
      billing: {
        credits: {
          report: async () => ({ grants: [] }),
          grant: async () => {
            calls.push('credits');
          },
        },
      },
      db: {},
      clock: {},
    } as any,
    { test: '5' },
  );
  const effects = ['identity', 'providers', 'credits', 'entitlement'];
  try {
    people.backfill({
      directory: async () => ({ people: [person] }),
      projectOwners: async () => [],
    } as any);
    await people.settled();
    assert.deepEqual(calls, bootMaintenance.active ? [] : effects);
    calls.length = 0;
    people.signedIn(person);
    await people.settled();
    assert.deepEqual(calls, bootMaintenance.active ? [] : effects);
    calls.length = 0;
    await people.ensure(person);
    assert.deepEqual(calls, effects);
    calls.length = 0;
    people.adminChanged('explicit-operator-project', person);
    await people.settled();
    assert.deepEqual(calls, effects);
  } finally {
    await people.close();
  }
});
