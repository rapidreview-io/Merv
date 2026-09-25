import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { postgresUrl, schemaFor } from './fixtures/state.js';
import { postgresMigrations as migrations0 } from '../packages/artifacts/src/index.postgres.js';
import { postgresMigrations as migrations2 } from '../packages/code-research/src/commands.postgres.js';
import { postgresMigrations as migrations3 } from '../packages/code-research/src/proposals.postgres.js';
import { postgresMigrations as migrations25 } from '../packages/code/src/units.postgres.js';
import { postgresMigrations as migrations5 } from '../packages/context-builder/src/index.postgres.js';
import { postgresMigrations as migrations6 } from '../packages/domain-events/src/index.postgres.js';
import { postgresMigrations as migrations7 } from '../packages/experiments/src/program.postgres.js';
import { postgresMigrations as migrations8 } from '../packages/experiments/src/storage.postgres.js';
import { postgresMigrations as migrations9 } from '../packages/feed/src/index.postgres.js';
import { postgresMigrations as migrations10 } from '../packages/knowledge/src/storage.postgres.js';
import { postgresMigrations as migrations11 } from '../packages/paper/src/storage.postgres.js';
import { postgresMigrations as migrations12 } from '../packages/reflections/src/index.postgres.js';
import { postgresMigrations as migrations13 } from '../packages/research/src/index.postgres.js';
import { postgresMigrations as migrations14 } from '../packages/reviews/src/index.postgres.js';
import { postgresMigrations as migrations15 } from '../packages/scope/src/index.postgres.js';
import { postgresMigrations as migrations16 } from '../packages/scope/src/memberships.postgres.js';
import { postgresMigrations as migrations17 } from '../packages/scope/src/project-context.postgres.js';
import { postgresMigrations as migrations18 } from '../packages/scope/src/user-keys.postgres.js';
import { postgresMigrations as migrations19 } from '../packages/sessions/src/agents.postgres.js';
import { postgresMigrations as migrations20 } from '../packages/sessions/src/dispatch.postgres.js';
import { postgresMigrations as migrations21 } from '../packages/sessions/src/index.postgres.js';
import { managedNoncePostgresMigration } from '../packages/sessions/src/managed-nonce.postgres.js';
import { postgresMigrations as migrations22 } from '../packages/sessions/src/observations.postgres.js';
import { postgresMigrations as migrations23 } from '../packages/tasks/src/index.postgres.js';
import { postgresMigrations as migrations24 } from '../packages/workflows/src/index.postgres.js';
import { migration as fleetMigration } from '../packages/fleet/src/schema.js';
import { migration as piMigration } from '../packages/pi/src/schema.js';

type DomainMigration = { owner: string; version: number; postgres: string };
/** Every native migration file (`<owner>.postgres.ts`), keyed by the owner that registers it. */
const nativeMigrations: Record<string, Record<number, string>> = {
  'packages/artifacts/src/index.ts': migrations0,
  'packages/code-research/src/commands.ts': migrations2,
  'packages/code-research/src/proposals.ts': migrations3,
  'packages/context-builder/src/index.ts': migrations5,
  'packages/domain-events/src/index.ts': migrations6,
  'packages/experiments/src/program.ts': migrations7,
  'packages/experiments/src/storage.ts': migrations8,
  'packages/feed/src/index.ts': migrations9,
  'packages/knowledge/src/storage.ts': migrations10,
  'packages/paper/src/storage.ts': migrations11,
  'packages/reflections/src/index.ts': migrations12,
  'packages/research/src/index.ts': migrations13,
  'packages/reviews/src/index.ts': migrations14,
  'packages/scope/src/index.ts': migrations15,
  'packages/scope/src/memberships.ts': migrations16,
  'packages/scope/src/project-context.ts': migrations17,
  'packages/scope/src/user-keys.ts': migrations18,
  'packages/sessions/src/agents.ts': migrations19,
  'packages/sessions/src/dispatch.ts': migrations20,
  'packages/sessions/src/index.ts': migrations21,
  'packages/sessions/src/managed-nonce.ts': { 8: managedNoncePostgresMigration },
  'packages/sessions/src/observations.ts': migrations22,
  'packages/tasks/src/index.ts': migrations23,
  'packages/workflows/src/index.ts': migrations24,
  'packages/code/src/units.ts': migrations25,
};
const root = fileURLToPath(new URL('../', import.meta.url));
function migrations(): DomainMigration[] {
  const result = Object.entries(nativeMigrations).flatMap(([owner, texts]) =>
    Object.entries(texts).map(([version, postgres]) => ({
      owner,
      version: Number(version),
      postgres,
    })),
  );
  const rank = (m: DomainMigration) =>
    m.owner.includes('/scope/')
      ? 0
      : m.owner.includes('/workflows/')
        ? 1
        : m.owner === 'packages/sessions/src/index.ts'
          ? 2
          : 3;
  return result.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (rank(a) === 0
        ? a.version - b.version
        : a.owner.localeCompare(b.owner) || a.version - b.version),
  );
}

test('every native migration file is listed here', () => {
  const files = readdirSync(join(root, 'packages')).flatMap((name) => {
    let source: string[];
    try {
      source = readdirSync(join(root, 'packages', name, 'src'));
    } catch {
      return [];
    }
    return source
      .filter((file) => file.endsWith('.postgres.ts'))
      .map((file) => `packages/${name}/src/${file.replace('.postgres.ts', '.ts')}`);
  });
  assert.deepEqual(files.sort(), Object.keys(nativeMigrations).sort());
});

test('domain migrations are PostgreSQL without SQLite constructs', () => {
  const all = migrations();
  assert.equal(all.length, 82);
  all.push(
    ...[
      { owner: 'fleet', version: fleetMigration.version, postgres: fleetMigration.sql },
      { owner: 'pi', version: piMigration.version, postgres: piMigration.sql },
    ],
  );
  for (const migration of all) {
    assert.ok(migration.postgres?.trim(), `${migration.owner}@${migration.version}`);
    assert.doesNotMatch(
      migration.postgres,
      /RAISE\(ABORT|\bAUTOINCREMENT\b|\bCOLLATE NOCASE\b|\bjson_extract\s*\(|\bjson_each\s*\(|\bjson_valid\s*\(|\bPRAGMA\b/,
    );
  }
});

test('all native domain migrations execute on PostgreSQL and retain provenance, ordering and atomicity', async (t) => {
  const client = new pg.Client({ connectionString: postgresUrl });
  const schema = schemaFor();
  await client.connect();
  t.after(async () => {
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await client.end();
    }
  });
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  await client.query(`CREATE TABLE events(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id TEXT NOT NULL,actor_id TEXT NOT NULL,type TEXT NOT NULL,subject_id TEXT NOT NULL,
    data_json TEXT NOT NULL,created_at TEXT NOT NULL)`);
  for (const migration of migrations()) {
    await client.query('BEGIN');
    try {
      await client.query(migration.postgres);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`${migration.owner}@${migration.version}: ${(error as Error).message}`, {
        cause: error,
      });
    }
    if (migration.owner === 'packages/scope/src/index.ts' && migration.version === 1) {
      await client.query(
        "INSERT INTO projects(id,name,created_at) VALUES('project','Legacy project','2026-01-01')",
      );
      await client.query(
        "INSERT INTO actors(id,project_id,name,role,token_hash,active) VALUES('actor','project','Legacy actor','operator','fixture-token-hash',1)",
      );
    }
    if (migration.owner === 'packages/scope/src/index.ts' && migration.version === 2) {
      const migrated = await client.query(
        "SELECT actor_id,token_hash FROM actor_credentials WHERE project_id='project'",
      );
      assert.deepEqual(migrated.rows, [{ actor_id: 'actor', token_hash: 'fixture-token-hash' }]);
    }
    if (migration.owner === 'packages/sessions/src/index.ts' && migration.version === 1) {
      await client.query(
        "INSERT INTO worker_sessions(id,project_id,actor_id,instance_id,revision,owner_hash,runner_id,request_id,token_hash,fingerprint,status,session_json) VALUES('old','project','actor','work-old',0,'owner','runner','old','old-hash','old-input','released','{}')",
      );
    }
  }
  // Native ALTER preserves old executions and allows a stable actor to undertake new work.
  await client.query(
    "INSERT INTO worker_sessions(id,project_id,actor_id,instance_id,revision,owner_hash,runner_id,request_id,token_hash,fingerprint,status,session_json) VALUES('new','project','actor','work-new',0,'owner','runner','new','new-hash','new-input','active','{}')",
  );
  assert.deepEqual(
    (await client.query('SELECT id FROM worker_sessions ORDER BY _merv_rowid')).rows.map(
      (row) => row.id,
    ),
    ['old', 'new'],
  );
  await assert.rejects(
    client.query(
      'UPDATE worker_sessions SET session_json=\'{"source":{"actorId":"other"}}\' WHERE id=\'new\'',
    ),
    /immutable/,
  );
  await client.query("UPDATE worker_sessions SET status='released' WHERE id='new'");
  await assert.rejects(client.query("DELETE FROM worker_sessions WHERE id='old'"), /retained/);

  const review =
    "INSERT INTO reviews(id,project_id,subject_id,subject_revision,producer_id,artifact_ids,criteria,manifest,snapshot_hash,status,reviewer_id,created_at,excluded_actor_ids) VALUES($1,'project','subject',0,'producer','[]','[]','{}','hash','requested',$2,'now','[\"contributor\"]')";
  await assert.rejects(
    client.query(review, ['bad-review', 'contributor']),
    /contributor cannot review/,
  );
  await client.query(review, ['review', 'independent']);
  await assert.rejects(
    client.query("UPDATE reviews SET reviewer_id='contributor' WHERE id='review'"),
    /contributor cannot review/,
  );
  await assert.rejects(
    client.query("UPDATE reviews SET excluded_actor_ids='[]' WHERE id='review'"),
    /immutable/,
  );
  await assert.rejects(
    client.query("UPDATE reviews SET required_criteria='[1]' WHERE id='review'"),
    /immutable/,
  );

  const post =
    "INSERT INTO feed_posts(id,project_id,author_id,body,artifact_ids,created_at) VALUES($1,'project','actor','Body','[]','now') RETURNING sequence";
  const first = await client.query(post, ['post-a']);
  const second = await client.query(post, ['post-b']);
  assert.ok(BigInt(second.rows[0].sequence) > BigInt(first.rows[0].sequence));
  await assert.rejects(
    client.query("UPDATE feed_posts SET body='changed' WHERE id='post-a'"),
    /immutable/,
  );

  await client.query('BEGIN');
  await client.query(
    "INSERT INTO artifacts(id,project_id,created_by,title,media_type,hash,size,created_at) VALUES('rollback','project','actor','Evidence','text/plain','hash',123,'now')",
  );
  await assert.rejects(
    client.query("UPDATE artifacts SET title='changed' WHERE id='rollback'"),
    /immutable/,
  );
  await client.query('ROLLBACK');
  assert.equal(
    (await client.query("SELECT COUNT(*) AS count FROM artifacts WHERE id='rollback'")).rows[0]
      .count,
    '0',
  );
  // One successor per research cycle is a storage fact: the database itself refuses a rival
  // successor and a rewritten predecessor.
  const cycle =
    "INSERT INTO research_cycles(id,project_id,record,predecessor_id) VALUES($1,'project','{}',$2)";
  await client.query(cycle, ['cycle', null]);
  await client.query(cycle, ['unrelated', null]);
  await client.query(cycle, ['follower', 'cycle']);
  await assert.rejects(client.query(cycle, ['rival', 'cycle']), { code: '23505' });
  await assert.rejects(
    client.query("UPDATE research_cycles SET predecessor_id='unrelated' WHERE id='follower'"),
    { code: '23514' },
  );
  await assert.rejects(
    client.query("UPDATE research_cycles SET predecessor_id='cycle' WHERE id='unrelated'"),
    { code: '23514' },
  );

  await client.query(
    "INSERT INTO event_consumers(id,definition_hash,cursor,retry_at) VALUES('consumer','hash',1,1800000000000)",
  );
  assert.equal(
    (await client.query("SELECT retry_at FROM event_consumers WHERE id='consumer'")).rows[0]
      .retry_at,
    '1800000000000',
  );
});
