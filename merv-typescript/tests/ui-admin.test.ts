import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openState } from './fixtures/state.js';
import { adminOverview, adminHttp } from '../packages/ui/src/admin.js';

test('admin snapshot combines customers, preserves terminal rows and excludes expired leases and private fields', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merv-admin-'));
  const state = await openState(dir);
  t.after(async () => {
    await state.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await state.transaction(async (tx) => {
    for (const statement of `CREATE TABLE projects(id TEXT,name TEXT);CREATE TABLE actors(id TEXT,name TEXT);
  CREATE TABLE wf_instances(id TEXT,state TEXT,updated_at TEXT);
  CREATE TABLE experiments(id TEXT,project_id TEXT,name TEXT,owner_id TEXT,attempt_index BIGINT,created_at TEXT);
  CREATE TABLE customer_experiments(id TEXT,project_id TEXT,title TEXT,email TEXT,attempts BIGINT,payment_id TEXT,created_at TEXT);
  CREATE TABLE customer_experiment_requests(id TEXT,data_json TEXT);
  CREATE TABLE worker_sessions(instance_id TEXT,status TEXT,session_json TEXT);`
      .split(';')
      .filter((s) => s.trim()))
      await tx.run(statement);
    await tx.run("INSERT INTO projects VALUES ('p1','Customer A'),('p2','Customer B')");
    await tx.run("INSERT INTO actors VALUES ('a1','Owner A')");
    await tx.run(
      "INSERT INTO wf_instances VALUES ('e1','running','2026-10-14T01:00:00Z'),('e2','complete','2026-10-14T02:00:00Z')",
    );
    await tx.run(
      "INSERT INTO experiments VALUES ('e1','p1','Ordinary experiment','a1',1,'2026-10-13T01:00:00Z')",
    );
    await tx.run(
      "INSERT INTO customer_experiments VALUES ('e2','p2','Standalone experiment','customer@example.com',2,'private-payment-id','2026-10-13T02:00:00Z')",
    );
    await tx.run(
      'INSERT INTO customer_experiment_requests VALUES (?,?)',
      'ce_test',
      JSON.stringify({
        experimentId: 'e2',
        clientRequest: 'private-idempotency-secret',
        checkout: { url: 'private-checkout-url' },
      }),
    );
    await tx.run(
      'INSERT INTO worker_sessions VALUES (?,?,?)',
      'e1',
      'active',
      JSON.stringify({
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        token: 'private-session-token',
      }),
    );
    await tx.run(
      'INSERT INTO worker_sessions VALUES (?,?,?)',
      'e2',
      'active',
      JSON.stringify({ expiresAt: new Date(Date.now() - 60000).toISOString() }),
    );
  });
  const result = await adminOverview(state);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.unavailable, []);
  assert.equal(result.rows[0]!.source, 'project');
  assert.equal(result.rows[0]!.sessions, 1);
  assert.equal(result.rows[0]!.activity, 'Agent working');
  assert.equal(result.rows[1]!.source, 'standalone');
  assert.equal(result.rows[1]!.sessions, 0);
  assert.equal(result.rows[1]!.paid, true);
  assert.equal(result.rows[1]!.requestId, 'ce_test');
  assert.ok(!JSON.stringify(result).includes('private-'));
  let touched = false;
  const handler = adminHttp(
    {
      read: () => {
        touched = true;
      },
    } as never,
    [{ issuer: 'issuer', subject: 'admin' }],
  );
  await assert.rejects(
    () =>
      handler(
        { method: 'GET' } as never,
        {} as never,
        {
          principal: { kind: 'user', user: { issuer: 'issuer', subject: 'other' } },
          url: new URL('https://test/admin/experiments'),
        } as never,
      ) as Promise<unknown>,
  );
  assert.equal(touched, false);
});
