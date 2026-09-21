import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { createService, type Migration, type SqlValue } from '@merv/contracts';
import { PostgresState, SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { CodeUnitService } from '@merv/code/units';
import { backends, optional, type Backend } from './fixtures/code-store.js';

const postgresUrl = process.env.MERV_TEST_POSTGRES_URL;
const oid = (char: string) => char.repeat(40);

async function fixture(t: TestContext, backend: Backend) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-code-migration-'));
  const schema = `code_migration_${randomUUID().replaceAll('-', '')}`;
  const state =
    backend === 'sqlite'
      ? new SqliteState(join(directory, 'state.sqlite'))
      : await PostgresState.open({ connectionString: postgresUrl!, schema });
  const scope = await createService(new ProjectScope(state));
  const workflows = await createService(new WorkflowsService(state, scope));
  t.after(async () => {
    workflows.close();
    await state.close();
    rmSync(directory, { recursive: true, force: true });
    if (backend === 'sqlite') return;
    const pool = new Pool({ connectionString: postgresUrl });
    try {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
  });
  const migrate = state.migrate.bind(state);
  /** Code's unit storage as a release applied it: up to and including `version`. */
  const upTo = async (version: number) => {
    state.migrate = async (component: string, migrations: Migration[]) =>
      await migrate(
        component,
        migrations.filter((migration) => migration.version <= version),
      );
    try {
      await new CodeUnitService(state, scope, workflows, {
        capture: async () => assert.fail('a migration reads no capture'),
      }).initialize();
    } finally {
      state.migrate = migrate;
    }
  };
  const run = async (sql: string, ...params: SqlValue[]) =>
    await state.transaction(async (tx) => await tx.run(sql, ...params));
  const get = async <T>(sql: string, ...params: SqlValue[]) =>
    await state.read(async (reader) => await reader.get<T>(sql, ...params));
  return { upTo, run, get };
}

for (const backend of backends)
  test(
    `${backend}: the repository, writer and journal columns are added to populated unit storage, with their guards`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      // SQLite says which guard refused; PostgreSQL's words never leave the state store.
      const refused = (pattern: RegExp) => (backend === 'sqlite' ? pattern : { code: /^state_/ });
      await f.upTo(1);
      await f.run(
        "INSERT INTO code_projects (project_id,mode,repository_id,binding_json,main_json,limits_json,warnings_json,updated_at) VALUES ('p','local','r','{}','{}','{}','[]','t')",
      );
      await f.run(
        "INSERT INTO code_units (project_id,unit_id,workflow,version,declared_at) VALUES ('p','u','task',5,'t')",
      );
      await f.run(
        "INSERT INTO code_operations (id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at) VALUES ('bind','p','actor:a','one','local_bind','h','{}','completed','{}','t','t')",
      );
      await f.upTo(2);
      // A second start applies nothing twice.
      await f.upTo(2);

      // What was there reads as a unit nobody writes and a project that is not hosted.
      const unit = await f.get<Record<string, unknown>>(
        "SELECT generation,writer_state,writer_session_id,head_oid,mirrored_oid,quarantine_operation_id FROM code_units WHERE unit_id='u'",
      );
      assert.deepEqual(
        { ...unit, generation: Number(unit!.generation) },
        {
          generation: 0,
          writer_state: 'idle',
          writer_session_id: null,
          head_oid: null,
          mirrored_oid: null,
          quarantine_operation_id: null,
        },
      );
      const bound = await f.get<Record<string, unknown>>(
        "SELECT phase,unit_id,attempts,progress_json FROM code_operations WHERE id='bind'",
      );
      assert.deepEqual(
        { ...bound, attempts: Number(bound!.attempts) },
        { phase: null, unit_id: null, attempts: 0, progress_json: null },
      );
      assert.equal(
        (await f.get<{ store_json: null }>(
          "SELECT store_json FROM code_projects WHERE project_id='p'",
        ))!.store_json,
        null,
      );

      // The repository of a project is recorded once.
      await f.run("UPDATE code_projects SET store_json='{\"format\":1}' WHERE project_id='p'");
      await f.run('UPDATE code_projects SET main_json=\'{"oid":"x"}\' WHERE project_id=\'p\'');
      await assert.rejects(
        f.run("UPDATE code_projects SET store_json='{\"format\":2}' WHERE project_id='p'"),
        refused(/recorded once/),
      );
      await assert.rejects(
        f.run("UPDATE code_projects SET store_json=NULL WHERE project_id='p'"),
        refused(/recorded once/),
      );

      // A generation only ever advances by one, and states are a closed set.
      await assert.rejects(
        f.run("UPDATE code_units SET generation=2 WHERE unit_id='u'"),
        refused(/advances by one/),
      );
      await f.run(
        "UPDATE code_units SET generation=1,writer_state='reserved',writer_session_id='s1',writer_lease_id='l1' WHERE unit_id='u'",
      );
      await assert.rejects(
        f.run("UPDATE code_units SET generation=0 WHERE unit_id='u'"),
        refused(/advances by one/),
      );
      await assert.rejects(f.run("UPDATE code_units SET writer_state='writing' WHERE unit_id='u'"));
      await f.run(
        `UPDATE code_units SET writer_state='active',head_oid='${oid('b')}' WHERE unit_id='u'`,
      );

      // One open operation of a kind per unit, and any number that belong to no unit.
      const operation = (id: string, unit: string | null, kind: string, phase: string) =>
        f.run(
          'INSERT INTO code_operations (id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,created_at,unit_id,generation,phase,progress_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          id,
          'p',
          'session:s1',
          id,
          kind,
          'h',
          '{}',
          'prepared',
          't',
          unit,
          unit ? 1 : null,
          phase,
          '{"received":0}',
          't',
        );
      await operation('up1', 'u', 'upload', 'receiving');
      await assert.rejects(operation('up2', 'u', 'upload', 'receiving'));
      await operation('mirror1', 'u', 'mirror-work', 'queued');
      await operation('import1', null, 'import', 'receiving');
      await operation('import2', null, 'import', 'receiving');

      // While a transfer is only receiving, an operator may still fence the unit…
      await f.run("UPDATE code_units SET writer_state='closed' WHERE unit_id='u'");
      // …but once it is admitted its ref operation is unresolved, and no successor may pass it.
      await f.run("UPDATE code_operations SET phase='admitting' WHERE id='up1'");
      for (const phase of ['admitting', 'objects_durable', 'refs_applied']) {
        await f.run('UPDATE code_operations SET phase=? WHERE id=?', phase, 'up1');
        await assert.rejects(
          f.run("UPDATE code_units SET generation=2,writer_state='reserved' WHERE unit_id='u'"),
          refused(/unresolved/),
        );
      }
      // Anything but the generation may still change: the head advances under that operation.
      await f.run(
        `UPDATE code_units SET head_oid='${oid('c')}',head_operation_id='up1' WHERE unit_id='u'`,
      );
      await f.run(
        "UPDATE code_operations SET status='completed',result_json='{}',completed_at='t' WHERE id='up1'",
      );
      await f.run("UPDATE code_units SET generation=2,writer_state='reserved' WHERE unit_id='u'");
      await operation('up2', 'u', 'upload', 'receiving');

      // A finished operation stays as it ended, whatever was added to the row since.
      await assert.rejects(
        f.run("UPDATE code_operations SET phase='receiving' WHERE id='up1'"),
        refused(/finished Code operation is immutable/),
      );
      await assert.rejects(
        f.run("UPDATE code_operations SET detail_json='{}' WHERE id='bind'"),
        refused(/finished Code operation is immutable/),
      );
      await assert.rejects(
        f.run("UPDATE code_operations SET payload_json='{\"x\":1}' WHERE id='up2'"),
        refused(/identity is immutable/),
      );
      // Findings are written in the update that fails the row.
      await f.run(
        "UPDATE code_operations SET status='failed',error='code_capture_quarantined',detail_json='{\"findings\":[]}',completed_at='t' WHERE id='up2'",
      );
      await assert.rejects(
        f.run("DELETE FROM code_operations WHERE id='up2'"),
        refused(/retained/),
      );
    },
  );
