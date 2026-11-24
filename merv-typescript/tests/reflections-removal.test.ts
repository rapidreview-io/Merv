/**
 * research@10 removes Reflections' data: its tables, guards and migration rows, and the research
 * cycle columns only a reflection or its plan wrote. Finished waves, lenses and research@6 cycles
 * stay as history; the release is refused while one is still open. The schema is seeded as
 * production holds it (Reflections' tables as their published migrations left them), with every
 * other component's migrations applied.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { postgresMigrations as knowledgeMigrations } from '../packages/knowledge/src/storage.postgres.js';
import { postgresMigrations as researchMigrations } from '../packages/research/src/index.postgres.js';
import { postgresMigrations as workflowMigrations } from '../packages/workflows/src/index.postgres.js';
import { openState } from './fixtures/state.js';

/** Research's migrations as production held them before this release. */
const before = Object.fromEntries(
  Object.entries(researchMigrations).filter(([version]) => Number(version) < 10),
);
const at = '2026-11-01T00:00:00.000Z';
/** State reports a refusal by its class only (23514: a guard or check refused), never its words. */
const refused = { code: 'state_constraint' };

/** Reflections' tables and guards as its published migrations 1-5 left them, with their rows. */
const reflectionTables = `
CREATE TABLE reflections(
 _merv_rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,owner_id TEXT NOT NULL,created_at TEXT NOT NULL,attempt BIGINT NOT NULL,review_id TEXT,submission TEXT,approved TEXT,feedback TEXT NOT NULL,abandoned TEXT);
CREATE OR REPLACE FUNCTION reflection_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Reflection history is retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER reflection_no_delete BEFORE DELETE ON reflections
FOR EACH ROW EXECUTE FUNCTION reflection_no_delete_guard();
CREATE TABLE reflection_lenses(
 _merv_rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,id TEXT PRIMARY KEY,project_id TEXT NOT NULL,reflection_id TEXT NOT NULL REFERENCES reflections(id),attempt BIGINT NOT NULL,perspective TEXT NOT NULL,instructions TEXT NOT NULL,producer_id TEXT,artifact TEXT,UNIQUE(reflection_id,attempt,perspective));
CREATE OR REPLACE FUNCTION reflection_lens_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Lens history is retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER reflection_lens_no_delete BEFORE DELETE ON reflection_lenses
FOR EACH ROW EXECUTE FUNCTION reflection_lens_no_delete_guard();
CREATE TABLE reflection_commands(project_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(project_id,actor_id,request_id));
INSERT INTO component_migrations(component,version,hash)
  SELECT 'reflections',v,'published' FROM generate_series(1,5) v;
`;

const definition = (name: string, version: number, states: string[], terminal: string[]) =>
  `INSERT INTO wf_definitions(name,version,fingerprint,definition_json,created_at) VALUES('${name}',${version},'${name}@${version}','${JSON.stringify({ name, version, initial: states[0], states, terminal, edges: [] })}','${at}');`;
const instance = (id: string, workflow: string, version: number, state: string) =>
  `INSERT INTO wf_instances(id,project_id,workflow,version,state,revision,data_json,created_at,updated_at) VALUES('${id}','p1','${workflow}',${version},'${state}',3,'{}','${at}','${at}');`;

/** A project that reflected once: its wave and lens approved, its research@6 cycle complete. */
async function seeded(waveState: 'approved' | 'reflecting') {
  const state = await openState();
  await state.migrate('workflows', workflowMigrations);
  await state.migrate('research', before);
  await state.migrate('seed', {
    1: `${reflectionTables}
${definition('reflection', 5, ['reflecting', 'synthesizing', 'in_review', 'approved', 'abandoned'], ['approved', 'abandoned'])}
${definition('reflection.lens', 4, ['reflecting', 'complete', 'abandoned'], ['complete', 'abandoned'])}
${definition('research', 6, ['defining', 'researching', 'reflecting', 'consolidating', 'complete', 'abandoned', 'failed'], ['complete', 'abandoned', 'failed'])}
${instance('wave', 'reflection', 5, waveState)}
${instance('lens', 'reflection.lens', 4, 'complete')}
${instance('cycle', 'research', 6, 'complete')}
INSERT INTO reflections(id,project_id,title,owner_id,created_at,attempt,feedback,approved)
  VALUES('wave','p1','Cycle: reflection','owner','${at}',1,'[]','${at}');
INSERT INTO reflection_lenses(id,project_id,reflection_id,attempt,perspective,instructions)
  VALUES('lens','p1','wave',1,'evidence','Audit the evidence.');
INSERT INTO reflection_commands VALUES('p1','owner','r1','f','{}');
INSERT INTO wf_blockers(project_id,instance_id,provider,blocker_key,code,message,status,next,related_json,since,updated_at)
  VALUES('p1','cycle','research','automatic','research_needs_owner','The plan stops',409,'Decide','[]','${at}','${at}');
INSERT INTO research_cycles(id,project_id,record,reflection_id)
  VALUES('cycle','p1','{"id":"cycle","name":"Cycle"}','wave');
INSERT INTO research_automation(research_id,project_id,source_json,root_id,cycle_index,max_cycles)
  VALUES('cycle','p1','{}','cycle',1,10);`,
  });
  const exists = async (table: string) =>
    !!(
      await state.read((sql) => sql.get<{ t: string | null }>('SELECT to_regclass(?) AS t', table))
    )?.t;
  const columns = async (table: string) =>
    (
      await state.read((sql) =>
        sql.all<{ column_name: string }>(
          'SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=? ORDER BY column_name',
          table,
        ),
      )
    ).map((row) => row.column_name);
  return { state, exists, columns };
}

test('research@10 drops Reflections and keeps finished waves and cycles as history', async () => {
  const { state, exists, columns } = await seeded('approved');
  await state.migrate('research', researchMigrations);
  for (const table of ['reflections', 'reflection_lenses', 'reflection_commands'])
    assert.equal(await exists(table), false, table);
  await state.read(async (sql) => {
    assert.equal(
      (await sql.get<{ n: number }>(
        "SELECT count(*)::int AS n FROM component_migrations WHERE component='reflections'",
      ))!.n,
      0,
    );
    assert.equal(
      (await sql.get<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'reflection%'",
      ))!.n,
      0,
    );
    // The history stays: the instances, the cycle and its automation, without the wave's link.
    assert.deepEqual(
      (await sql.all<{ id: string }>('SELECT id FROM wf_instances ORDER BY id')).map((r) => r.id),
      ['cycle', 'lens', 'wave'],
    );
    assert.equal((await sql.get<{ id: string }>('SELECT id FROM research_cycles'))!.id, 'cycle');
    assert.equal(
      (await sql.get<{ n: number }>('SELECT count(*)::int AS n FROM research_automation'))!.n,
      1,
    );
    // What a retired cycle asked of its owner no longer stands on Home.
    assert.equal(
      (await sql.get<{ n: number }>('SELECT count(*)::int AS n FROM wf_blockers'))!.n,
      0,
    );
  });
  // The published retirement ledger reads it, so the column stays.
  assert.equal((await columns('research_cycles')).includes('reflection_id'), true);
  assert.deepEqual(await columns('research_automation'), [
    'project_id',
    'research_id',
    'source_json',
    'unavailable_since',
  ]);
  // The guards still hold on what remains.
  await state.transaction(async (tx) => {
    await tx.run("UPDATE research_cycles SET problem='{}' WHERE id='cycle'");
  });
  await assert.rejects(
    state.transaction(async (tx) => {
      await tx.run("UPDATE research_cycles SET problem='{\"changed\":true}' WHERE id='cycle'");
    }),
    refused,
  );
  await assert.rejects(
    state.transaction(async (tx) => {
      await tx.run("UPDATE research_automation SET source_json='[]' WHERE research_id='cycle'");
    }),
    refused,
  );
});

test('research@10 is refused while a reflection wave is still open, and changes nothing', async () => {
  const { state, exists, columns } = await seeded('reflecting');
  await assert.rejects(state.migrate('research', researchMigrations), {
    code: 'state_constraint',
    message: 'Migration research/10 failed (SQLSTATE 23514)',
  });
  assert.equal(await exists('reflections'), true);
  assert.equal((await columns('research_automation')).includes('root_id'), true);
});

test('a component retirement that runs after research@10 on a fresh database still runs', async () => {
  const state = await openState();
  await state.migrate('workflows', workflowMigrations);
  await state.migrate('research', researchMigrations);
  // knowledge@2 opens with the retirement ledger, which reads research_cycles.reflection_id.
  await state.migrate('knowledge', knowledgeMigrations);
});
