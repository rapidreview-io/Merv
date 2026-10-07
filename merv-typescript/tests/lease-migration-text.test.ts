import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { postgresMigrations as taskMigrations } from '../packages/tasks/src/index.postgres.js';
import { postgresMigrations as experimentMigrations } from '../packages/experiments/src/program.postgres.js';
import { postgresMigrations as reflectionMigrations } from '../packages/reflections/src/index.postgres.js';
import { createApp } from './fixtures/app.js';
import { postgresUrl, schemaFor } from './fixtures/state.js';

// Old lease rows hold JSON as TEXT. A string in it may escape NUL or a lone surrogate: legal
// json, refused by jsonb. The lease copies must move such rows byte for byte, not fail startup.
test('the lease copies move JSON text that jsonb would refuse', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'merv-lease-text-'));
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  const app = await createApp({ directory });
  const { project } = await app.ctx.scope.credentials.bootstrap({
    projectName: 'P',
    actorName: 'Op',
  });
  await app.stop();
  const sql = new pg.Client({ connectionString: postgresUrl });
  await sql.connect();
  t.after(async () => await sql.end());
  await sql.query(`SET search_path TO "${schemaFor(directory)}"`);
  // Rewind to the released shape: the three lease tables, and no wf_leases yet. workflows@14
  // came after it.
  const reflections = reflectionMigrations[1]!;
  await sql.query(`ALTER TABLE wf_blockers DROP COLUMN whose, DROP COLUMN revision;
DELETE FROM component_migrations WHERE component='workflows' AND version=14;
DROP TABLE wf_leases; DROP FUNCTION wf_leases_immutable_guard();
${taskMigrations[6]}${taskMigrations[7]}${experimentMigrations[1]}${experimentMigrations[2]}
${reflections.slice(reflections.indexOf('CREATE TABLE reflection_leases'))}
DELETE FROM component_migrations WHERE (component='workflows' AND version IN (12,13))
  OR (component='tasks' AND version IN (10,11)) OR (component='experiment_program' AND version=4)
  OR (component='reflections' AND version=5);`);
  const nul = JSON.stringify([{ summary: 'log tail: a\u0000b' }]);
  const surrogate = '{"note":"half \\ud800 pair"}';
  await sql.query(
    `INSERT INTO task_leases VALUES('ses_t',$1,'tsk_x',3,'act_w','act_s','work',NULL,NULL,'{"leaseId":"ses_t"}','[]',$2,NULL)`,
    [project.id, nul],
  );
  await sql.query(
    `INSERT INTO experiment_leases(id,project_id,experiment_id,revision,attempt_index,state,actor_id,source_actor_id,review_id,claim_id,receipt,artifacts,recovery,inputs,released_at)
     VALUES('ses_e',$1,'exp_x',7,2,'running','act_b','act_s',NULL,NULL,'{"leaseId":"ses_e"}','[]',$2,$3,NULL)`,
    [project.id, nul, surrogate],
  );
  await sql.query(
    `INSERT INTO reflection_leases VALUES('ses_r',$1,'lens_x',2,'act_c','{"leaseId":"ses_r","sourceId":"act_s"}',$2,$3,NULL,NULL,NULL)`,
    [project.id, surrogate, nul],
  );
  const restarted = await createApp({ directory });
  await restarted.stop();
  const details = Object.fromEntries(
    (await sql.query('SELECT id, details FROM wf_leases ORDER BY id')).rows.map(
      (row: { id: string; details: string }) => [row.id, JSON.parse(row.details)],
    ),
  );
  assert.equal(details.ses_t.checkpoints[0].summary, 'log tail: a\u0000b');
  assert.equal(details.ses_e.recovery[0].summary, 'log tail: a\u0000b');
  assert.equal(details.ses_e.inputs.note, 'half \ud800 pair');
  assert.equal(details.ses_r.inputs.note, 'half \ud800 pair');
  assert.equal(details.ses_r.artifacts[0].summary, 'log tail: a\u0000b');
  const source = await sql.query("SELECT source_actor_id FROM wf_leases WHERE id='ses_r'");
  assert.equal(source.rows[0].source_actor_id, 'act_s');
});
