import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { nativeAdmissionSnapshot } from '@merv/fleet/native-admission';
import { migration, migrationV3, modelMigrations } from '@merv/fleet/schema';
import { openState } from './fixtures/state.js';

async function fixture(t: TestContext) {
  const state = await openState();
  t.after(() => state.close());
  await state.transaction(async (tx) => {
    await tx.run('CREATE TABLE projects(id TEXT PRIMARY KEY)');
    await tx.run("INSERT INTO projects VALUES('project'),('other')");
  });
  await state.migrate('fleet', [migration]);
  const insert = (id: string, project = 'project', owner = 'work:target', kind = 'workflow') =>
    state.transaction((tx) =>
      tx.run(
        `INSERT INTO fleet_allocations(id,project_id,source_hash,request_id,input_hash,phase,created_at,data_json)
       VALUES(?,?,'source-digest',?,'input-digest','released','2026-10-20T00:00:00Z',?)`,
        id,
        project,
        id,
        JSON.stringify({
          owner: { kind, id: owner },
          epoch: 1,
          intent: 'stop',
          createdAt: '2026-10-20T00:00:00Z',
          updatedAt: '2026-10-20T01:00:00Z',
          runtime: { state: 'stopped' },
          source: { credential: 'secret-never-in-plan' },
          bootstrap: 'secret-never-in-plan',
        }),
      ),
    );
  const read = (ids = ['target']) =>
    state.snapshotTransaction((sql) => nativeAdmissionSnapshot(sql, 'project', ids));
  return { state, insert, read };
}

test('Fleet admission snapshot reads old schema without migration tables and omits secret-bearing allocation fields', async (t) => {
  const f = await fixture(t);
  await f.insert('own');
  await f.insert('other-unit', 'project', 'work:unrelated');
  await f.insert('other-project', 'other');
  const snapshot = await f.read();
  assert.deepEqual(
    snapshot.allocations.map((row) => row.id),
    ['own'],
  );
  assert.equal(snapshot.allocations[0]!.owner_id, 'work:target');
  assert.equal(snapshot.allocations[0]!.had_runtime, true);
  assert.equal(snapshot.shared.allocations.count, 3);
  assert.equal(snapshot.present.fleet_workflow_retry_grants, false);
  assert.deepEqual(snapshot.grants, []);
  assert.deepEqual(snapshot.claims, []);
  assert.equal(JSON.stringify(snapshot).includes('secret-never-in-plan'), false);
  assert.deepEqual(await f.read(['target', 'target']), snapshot);
  assert.equal(
    (await f.state.read((sql) =>
      sql.get<{ name: string | null }>(
        "SELECT to_regclass('wf_protocol_migrations')::text AS name",
      ),
    ))!.name,
    null,
    'reading the old DB never installs a migration ledger',
  );
});

test('snapshot changes with retained claims, retry grants and shared holds or allocation outcomes', async (t) => {
  const f = await fixture(t);
  await f.insert('own');
  await f.insert('pi-rental', 'other', 'conversation', 'pi');
  await f.state.migrate('fleet_workflow', modelMigrations);
  await f.state.transaction(async (tx) => {
    await tx.run(migrationV3.sql);
    await tx.run(`CREATE TABLE session_managed_assignments(allocation_id TEXT,ordinal BIGINT,
      session_id TEXT,bound_at TEXT,release_ack_at TEXT,settled_at TEXT)`);
    await tx.run(`INSERT INTO session_managed_assignments VALUES
      ('own',1,'claimed-session','2026-10-20T00:00:01Z',NULL,'2026-10-20T01:00:00Z')`);
    await tx.run(`INSERT INTO fleet_workflow_retry_grants(project_id,instance_id,expected_revision,
      prior_allocations,request_id,input_hash,reason,actor_id,created_at)
      VALUES('project','target',12,2,'retry','hash','operator reason','operator','2026-10-20T01:00:00Z')`);
  });
  const before = await f.read();
  assert.equal(before.claims.length, 1);
  assert.equal(before.claims[0]!.session_id, 'claimed-session');
  assert.equal(before.grants.length, 1);
  assert.equal(before.grants[0]!.expected_revision, 12, 'snapshot preserves original revisions');
  await f.state.transaction((tx) =>
    tx.run("INSERT INTO fleet_holds VALUES('release','2026-10-22T00:00:00Z')"),
  );
  const held = await f.read();
  assert.notEqual(held.shared.fleet_holds.hash, before.shared.fleet_holds.hash);
  assert.deepEqual(held.allocations, before.allocations);
  await f.state.transaction((tx) =>
    tx.run(`UPDATE fleet_allocations SET
    data_json=jsonb_set(data_json::jsonb,'{updatedAt}','"2026-10-21T00:00:00Z"')::text WHERE id='pi-rental'`),
  );
  const changed = await f.read();
  assert.notEqual(
    changed.shared.allocations.hash,
    held.shared.allocations.hash,
    'shared machine admission reflects other owners too',
  );
  assert.deepEqual(changed.allocations, held.allocations);
  await f.state.transaction((tx) =>
    tx.run(
      "UPDATE session_managed_assignments SET release_ack_at='2026-10-21T00:00:00Z' WHERE allocation_id='own'",
    ),
  );
  assert.notDeepEqual((await f.read()).claims, changed.claims);
});
