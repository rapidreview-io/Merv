import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService, type SqlValue } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { CodeUnitService } from '@merv/code-work/units';
import { CodeWriterService } from '@merv/code/writers';
import { CodeUnitStore } from '@merv/code/units';
import { openState } from './fixtures/state.js';
import { legacyCodeUnitsMigrations } from './fixtures/legacy-code-units.js';

const oid = (char: string) => char.repeat(40);

async function fixture(t: TestContext, legacy = true) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-code-migration-'));
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  const workflows = await createService(new WorkflowsService(state, scope));
  t.after(async () => {
    workflows.close();
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const initialize = async () => {
    // Seed the exact schema production holds (the retired `code_units` at v4): its repository
    // and journal guards must survive the upgrade, and its writer columns must not.
    if (legacy) await state.migrate('code_units', legacyCodeUnitsMigrations);
    const writers = new CodeWriterService(state, scope, 900);
    await new CodeUnitService(
      state,
      scope,
      workflows,
      { capture: async () => assert.fail('a migration reads no capture') },
      writers,
      await createService(new CodeUnitStore(state, scope, writers)),
      { contributors: async () => assert.fail('a migration reads no contributors') },
      { get: async () => assert.fail('a migration reads no review') },
    ).initialize();
  };
  const run = async (sql: string, ...params: SqlValue[]) =>
    await state.transaction(async (tx) => await tx.run(sql, ...params));
  const get = async <T>(sql: string, ...params: SqlValue[]) =>
    await state.read(async (reader) => await reader.get<T>(sql, ...params));
  return { initialize, run, get };
}

test('published legacy storage keeps its repository and journal guards after upgrade', async (t) => {
  const f = await fixture(t);
  // PostgreSQL's words never leave the state store, so every guard refuses alike; the comment
  // beside each use names the guard.
  const refused = { code: 'state_constraint' };
  await f.initialize();
  await f.run(
    "INSERT INTO code_projects (project_id,mode,repository_id,binding_json,main_json,limits_json,warnings_json,updated_at) VALUES ('p','local','r','{}','{}','{}','[]','t')",
  );
  await f.run(
    "INSERT INTO code_units (project_id,unit_id,workflow,version,declared_at) VALUES ('p','u','task',5,'t')",
  );
  await f.run(
    "INSERT INTO code_operations (id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at) VALUES ('bind','p','actor:a','one','local_bind','h','{}','completed','{}','t','t')",
  );
  // A second start applies nothing twice.
  await f.initialize();

  // The retired writer columns and their generation guard are gone; Code's workspaces own them.
  assert.equal(
    await f.get(
      "SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='code_units' AND column_name IN ('generation','writer_state','head_oid','mirrored_oid','quarantine_operation_id')",
    ),
    undefined,
  );
  // A new binding is not yet hosted.
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
    refused /* recorded once */,
  );
  await assert.rejects(
    f.run("UPDATE code_projects SET store_json=NULL WHERE project_id='p'"),
    refused /* recorded once */,
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

  // Once a transfer finishes, another of its kind may open for the unit.
  await f.run(
    "UPDATE code_operations SET status='completed',result_json='{}',completed_at='t' WHERE id='up1'",
  );
  await operation('up2', 'u', 'upload', 'receiving');

  // A finished operation stays as it ended, whatever was added to the row since.
  await assert.rejects(
    f.run("UPDATE code_operations SET phase='receiving' WHERE id='up1'"),
    refused /* finished Code operation is immutable */,
  );
  await assert.rejects(
    f.run("UPDATE code_operations SET detail_json='{}' WHERE id='bind'"),
    refused /* finished Code operation is immutable */,
  );
  await assert.rejects(
    f.run("UPDATE code_operations SET payload_json='{\"x\":1}' WHERE id='up2'"),
    refused /* identity is immutable */,
  );
  // Findings are written in the update that fails the row.
  await f.run(
    "UPDATE code_operations SET status='failed',error='code_capture_quarantined',detail_json='{\"findings\":[]}',completed_at='t' WHERE id='up2'",
  );
  await assert.rejects(f.run("DELETE FROM code_operations WHERE id='up2'"), refused /* retained */);
});

test('unit storage indexes accepted commits', async (t) => {
  const f = await fixture(t);
  await f.initialize();
  await f.run(
    "INSERT INTO code_projects (project_id,mode,repository_id,binding_json,main_json,limits_json,warnings_json,updated_at) VALUES ('p','local','r','{}','{}','{}','[]','t')",
  );
  const acceptance = JSON.stringify({ code: { commit: oid('a') } });
  await f.run(
    "INSERT INTO code_units (project_id,unit_id,workflow,version,declared_at,acceptance_json,acceptance_hash,accepted_at) VALUES ('p','u','experiment',8,'t',?,'h','t')",
    acceptance,
  );
  await f.initialize();
  const field = "(acceptance_json::jsonb #>> '{code,commit}')";
  assert.deepEqual(
    {
      ...(await f.get<{ unit_id: string; acceptance_json: string }>(
        `SELECT unit_id,acceptance_json FROM code_units WHERE project_id=? AND acceptance_json IS NOT NULL AND ${field}=?`,
        'p',
        oid('a'),
      )),
    },
    { unit_id: 'u', acceptance_json: acceptance },
  );
  assert.ok(
    await f.get(
      "SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND indexname='code_units_accepted_commit'",
    ),
  );
});

/** Everything that defines a table's shape, by name, independent of physical column numbers. */
async function shape(f: Awaited<ReturnType<typeof fixture>>, table: string) {
  const all = async (sql: string) =>
    await f.get<{ shape: unknown }>(
      `SELECT COALESCE(json_agg(x ORDER BY x::text),'[]') AS shape FROM (${sql}) x`,
      table,
    );
  return {
    columns: await f.get<{ shape: unknown }>(
      'SELECT json_agg(json_build_array(column_name,data_type,is_nullable,column_default) ORDER BY ordinal_position) AS shape FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=?',
      table,
    ),
    constraints: await all(
      'SELECT conname,pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid=to_regclass(?)',
    ),
    indexes: await all(
      "SELECT replace(pg_get_indexdef(indexrelid),current_schema()||'.','') AS def FROM pg_index WHERE indrelid=to_regclass(?)",
    ),
    triggers: await all(
      'SELECT t.tgname,p.proname,p.prosrc FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid=to_regclass(?) AND NOT t.tgisinternal',
    ),
  };
}

test('a legacy code_units database and a fresh one end with the same unit table', async (t) => {
  const legacy = await fixture(t);
  await legacy.initialize();
  const fresh = await fixture(t, false);
  await fresh.initialize();
  for (const table of ['code_units', 'code_edges', 'code_unit_frontiers', 'code_unit_inputs'])
    assert.deepEqual(await shape(legacy, table), await shape(fresh, table), table);
  assert.equal(
    await legacy.get(
      "SELECT 1 FROM pg_proc WHERE proname='code_units_generation_guard' AND pronamespace=current_schema()::regnamespace",
    ),
    undefined,
  );
});
