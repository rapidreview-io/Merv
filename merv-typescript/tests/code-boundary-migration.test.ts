import assert from 'node:assert/strict';
import test from 'node:test';
import { createService } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { CodeService } from '@merv/code/service';
import { postgresMigrations } from '@merv/code-work/legacy-units.postgres';
import { migrateBases } from '@merv/code-work/base-schema';
import { migratePublications } from '@merv/code-work/publications-schema';
import { initializeWorkRecords } from '@merv/code-work/work-schema';
import { initializeWorkHolds } from '@merv/code-work/repository-holds';
import { restoreLegacyCompatibility } from '@merv/code-work/compatibility';
import { openState } from './fixtures/state.js';

test('legacy upgrade retains writer ownership and research history, rolls back on failure, and survives restart', async (t) => {
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  const boot = await scope.bootstrap({ projectName: 'Legacy code', actorName: 'Owner' });
  const caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  await state.migrate(
    'code_units',
    Object.entries(postgresMigrations).map(([version, sql]) => ({ version: Number(version), sql })),
  );
  await migrateBases(state);
  await migratePublications(state);
  const commit = 'a'.repeat(40),
    reviewed = 'b'.repeat(40),
    at = '2026-10-01T00:00:00.000Z';
  await state.transaction(async (tx) => {
    await tx.run(
      "INSERT INTO code_projects(project_id,mode,repository_id,binding_json,main_json,limits_json,warnings_json,updated_at) VALUES (?,'local','repo','{}',?,'{}','[]',?)",
      caller.projectId,
      JSON.stringify({ oid: commit }),
      at,
    );
    await tx.run(
      'INSERT INTO code_units(project_id,unit_id,workflow,version,declared_at,base_json,base_hash,base_lease_id,based_at,generation,writer_state,writer_session_id,writer_lease_id,writer_changed_at,head_oid,acceptance_json,acceptance_hash,accepted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      caller.projectId,
      'unit',
      'experiment',
      8,
      at,
      JSON.stringify({ reference: commit }),
      'pin-hash',
      'lease',
      at,
      3,
      'active',
      'session',
      'lease',
      at,
      commit,
      JSON.stringify({ code: { commit }, storage: 'code', receipt: 'old-receipt' }),
      'acceptance-hash',
      at,
    );
    await tx.run(
      'INSERT INTO code_review_acceptances(project_id,unit_id,review_id,acceptance_json,accepted_at) VALUES (?,?,?,?,?)',
      caller.projectId,
      'unit',
      'review',
      JSON.stringify({ code: { commit: reviewed }, storage: 'legacy-local' }),
      at,
    );
    await tx.run(
      "INSERT INTO code_bases(project_id,base_key,members_json,left_key,right_key,engine,state,created_at,updated_at) VALUES (?,'unresolved','[]',?,?,'git','queued',?,?)",
      caller.projectId,
      commit,
      reviewed,
      at,
      at,
    );
    await tx.run(
      "INSERT INTO code_publications(proposal_id,project_id,record_json,binding_json) VALUES ('publication',?,'{}','null')",
      caller.projectId,
    );
    await tx.run(
      "INSERT INTO code_operations(id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,created_at,unit_id,phase,progress_json,updated_at) VALUES ('pending-retention',?,'system:code','accept-ref:unit','accept-ref','original-hash',?,'prepared',?,'unit','objects_durable',?,?)",
      caller.projectId,
      JSON.stringify({
        format: 1,
        source: 'accept-ref',
        actorId: caller.actorId,
        unitId: 'unit',
        tip: commit,
      }),
      at,
      JSON.stringify({
        received: 0,
        expectedOld: null,
        target: commit,
        receiptRef: 'refs/merv/accepted/unit',
      }),
      at,
    );
  });
  const legacy = () =>
    state.read(async (sql) => ({
      units: await sql.all('SELECT * FROM code_units ORDER BY unit_id'),
      reviews: await sql.all('SELECT * FROM code_review_acceptances ORDER BY review_id'),
      journals: await sql.all('SELECT * FROM code_operations ORDER BY id'),
      migrations: await sql.all(
        "SELECT * FROM component_migrations WHERE component IN ('code_units','code_bases','code_publications') ORDER BY component,version",
      ),
    }));
  const before = await legacy();
  let code = await createService(new CodeService(state, scope, {}));
  t.after(async () => {
    await code.close();
    await state.close();
  });
  const holds = () =>
    state.read((sql) =>
      sql.all<{ hold_key: string }>(
        'SELECT hold_key FROM code_repository_holds WHERE project_id=? ORDER BY hold_key',
        caller.projectId,
      ),
    );
  assert.deepEqual(await holds(), [{ hold_key: 'code-storage-upgrade' }]);
  await assert.rejects(
    state.transaction((tx) =>
      code.writers.reserveWriter(caller, { unitId: 'unit', leaseId: 'new' }, tx),
    ),
    { code: 'code_storage_upgrade_required' },
  );
  await initializeWorkRecords(state);
  await initializeWorkHolds(state);
  const retain = code.units.retainHistoricalCommit.bind(code.units);
  let count = 0;
  const failure = t.mock.method(
    code.units,
    'retainHistoricalCommit',
    async (...args: Parameters<typeof retain>) => {
      if (++count === 2) throw new Error('interrupted migration');
      return retain(...args);
    },
  );
  await assert.rejects(restoreLegacyCompatibility(state, code.units), /interrupted migration/);
  failure.mock.restore();
  assert.deepEqual(await holds(), [{ hold_key: 'code-storage-upgrade' }]);
  assert.deepEqual(await state.read((sql) => sql.all('SELECT * FROM code_workspaces')), []);
  assert.deepEqual(await state.read((sql) => sql.all('SELECT * FROM code_retained_commits')), []);
  await restoreLegacyCompatibility(state, code.units);
  assert.deepEqual(await legacy(), before);
  assert.deepEqual(
    (await holds()).map((row) => row.hold_key),
    ['research:base:unresolved', 'research:publication:publication'],
  );
  const writer = await state.read((sql) => code.writers.row(sql, caller.projectId, 'unit'));
  assert.equal(Number(writer?.generation), 3);
  assert.equal(writer?.writer_state, 'active');
  assert.equal(writer?.writer_session_id, 'session');
  assert.equal(writer?.writer_lease_id, 'lease');
  assert.equal(writer?.head_oid, commit);
  const retained = await state.read((sql) =>
    sql.all<{ commit_oid: string }>(
      'SELECT DISTINCT commit_oid FROM code_retained_commits ORDER BY commit_oid',
    ),
  );
  assert.deepEqual(
    retained.map((row) => row.commit_oid),
    [commit, reviewed],
  );
  await code.close();
  code = await createService(new CodeService(state, scope, {}));
  await restoreLegacyCompatibility(state, code.units);
  assert.deepEqual(await legacy(), before);
  assert.deepEqual(
    await state.read((sql) => code.writers.row(sql, caller.projectId, 'unit')),
    writer,
  );
  assert.ok(!(await holds()).some((row) => row.hold_key === 'code-storage-upgrade'));
});
