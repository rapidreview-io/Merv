import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { selection } from './selection.mjs';
import { hash } from './history.mjs';
import { postgresMigrations as artifacts } from '../../packages/artifacts/src/index.postgres.ts';
import { postgresMigrations as scope } from '../../packages/scope/src/index.postgres.ts';
import * as fleet from '../../packages/fleet/src/schema.ts';
const url = process.env.ISOLATION_TEST_DATABASE_URL;
test(
  'real Main migrations and JSONB artifacts select exact retained providers and verify every source query',
  { skip: !url },
  async () => {
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname));
    const { openDatabase, migrate } = await import('@sandboxes/db');
    const main = new pg.Client({ connectionString: url });
    await main.connect();
    let madeSchema = false,
      madeSource = false,
      source;
    const sourceName = 'isolation_selection_source';
    try {
      assert.equal(
        (await main.query('SELECT current_database() AS name')).rows[0].name,
        'postgres',
      );
      await main.query('CREATE SCHEMA merv_ts_staging');
      madeSchema = true;
      await main.query('SET search_path TO merv_ts_staging');
      // The State bootstrap owns events. Use its actual declared DDL, not a query adapter.
      const stateSource = readFileSync(
        new URL('../../packages/state/src/postgres.ts', import.meta.url),
        'utf8',
      );
      const eventDDL = stateSource.match(/CREATE TABLE IF NOT EXISTS events\([^;]+;/)?.[0];
      assert.ok(eventDDL);
      await main.query(eventDDL);
      await main.query(scope[1]);
      for (const sql of Object.values(artifacts)) await main.query(sql);
      for (const name of [
        'migration',
        'migrationV2',
        'migrationV3',
        'migrationV4',
        'migrationV5',
        'migrationV6',
      ])
        await main.query(fleet[name].sql);
      const native = JSON.parse(
        readFileSync(new URL('./selection-native-schema.fixture.json', import.meta.url), 'utf8'),
      );
      for (const sql of native.migrations) await main.query(sql);
      const types = (
        await main.query(
          "SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='merv_ts_staging' AND table_name='artifacts' AND column_name IN ('files_json','file_refs_json') ORDER BY column_name",
        )
      ).rows;
      assert.deepEqual(
        types.map((r) => r.data_type),
        ['jsonb', 'jsonb'],
      );
      await main.query('CREATE DATABASE ' + sourceName);
      madeSource = true;
      const sourceUrl = new URL(url);
      sourceUrl.pathname = '/' + sourceName;
      const nativeDb = await openDatabase({ url: sourceUrl.href, schema: 'public' });
      try {
        await migrate(nativeDb, { schemaExplicit: true });
      } finally {
        await nativeDb.close();
      }
      source = new pg.Client({ connectionString: sourceUrl.href });
      await source.connect();
      await main.query(
        "INSERT INTO projects VALUES('owner','Owner','now'),('other','Other','now')",
      );
      await main.query(
        "INSERT INTO sandbox_native_connections(id,project_id,root_id,account_id,member_id,credentials,connected_at) VALUES('connection','owner','root','account','member','not-a-secret','now')",
      );
      for (let i = 0; i < 14; i++)
        await main.query(
          "INSERT INTO sandbox_native_work(project_id,work_kind,work_id,connection_id,namespace,closed_at) VALUES('owner','task',$1,'connection',$2,'now')",
          ['work' + i, 'closed_' + i],
        );
      for (let i = 0; i < 6; i++)
        await main.query(
          "INSERT INTO sandbox_native_captures(connection_id,namespace,workflow_id,node_id,artifact_id) VALUES('connection','archive',$1,'node','native-artifact')",
          ['wf' + i],
        );
      for (let i = 0; i < 75; i++) {
        const id = 'sandbox_' + String(i).padStart(2, '0');
        await main.query(
          "INSERT INTO fleet_allocations VALUES($1,'owner','source',$1,'input','released','now',$2)",
          ['allocation_' + i, JSON.stringify({ runtime: { sandboxId: id } })],
        );
        await source.query(
          "INSERT INTO sandboxes(id,namespace,name,provider,plugin,state,revision,operation_id,offer_json,request_json,login_user,created_at,updated_at) VALUES($1::text,'archive',$1::text,$2,'cloudflare','stopped',1,$1::text,'{}','{}','root',now(),now())",
          [id, i % 2 ? 'cloudflare-fleet-staging' : 'cloudflare-fleet-staging-large'],
        );
      }
      const digest = hash('bytes');
      for (const [id, namespace] of [
        ['native-file', 'archive'],
        ['bare-file', 'merv-ml'],
      ])
        await source.query(
          "INSERT INTO storage_objects(id,namespace,name,version,kind,state,sha256,size_bytes,content_type,object_key,request_json,entries_json,created_at,updated_at) VALUES($1::text,$2,$1::text,1,'file','available',$3,5,'text/plain',$1::text,'{}','[]',now(),now())",
          [id, namespace, digest],
        );
      const refs = Array.from({ length: 15 }, (_, i) => ({
        name: 'file' + i,
        provider: 'sandboxes-native',
        reference: JSON.stringify([
          1,
          'connection',
          'archive',
          'task',
          'work',
          'workflow',
          'node',
          'native-file',
          digest,
          5,
        ]),
      }));
      const insert = async (id, project, fileRefs, files) =>
        main.query(
          "INSERT INTO artifacts(id,project_id,created_by,title,media_type,hash,size,created_at,files_json,file_refs_json) VALUES($1,$2,'actor',$1,'application/json',$3,0,'now',$4,$5)",
          [
            id,
            project,
            digest,
            files === null ? null : JSON.stringify(files),
            fileRefs === null ? null : JSON.stringify(fileRefs),
          ],
        );
      await insert('native-artifact', 'owner', refs, []);
      await insert(
        'bare-artifact',
        'owner',
        [{ name: 'bare', provider: 'sandboxes', reference: 'bare-file' }],
        [{ name: 'bare', provider: 'sandboxes', hash: digest, size: 5 }],
      );
      await insert('null-artifact', 'owner', null, null);
      await insert('empty-artifact', 'owner', [], []);
      await insert(
        'unrelated-artifact',
        'owner',
        [
          {
            name: 'mentions sandboxes-native',
            provider: 'another-provider',
            reference: 'sandboxes',
          },
        ],
        [],
      );
      await insert(
        'lookalike-artifact',
        'owner',
        [{ name: 'fake', provider: 'sandboxes-native-extra', reference: 'not-json' }],
        [],
      );
      const before = (await main.query('SELECT to_jsonb(a) AS row FROM artifacts a ORDER BY id'))
        .rows;
      await assert.rejects(
        main.query("SELECT id FROM artifacts WHERE file_refs_json LIKE '%sandboxes%'"),
        { code: '42883' },
      );
      const selected = await selection(main, source);
      assert.equal(selected.provenance.allocations.length, 75);
      assert.equal(selected.provenance.work.length, 14);
      assert.equal(selected.provenance.captures.length, 6);
      assert.equal(selected.provenance.refs.length, 16);
      assert.equal(
        selected.provenance.refs.filter((r) => r.reference.provider === 'sandboxes-native').length,
        15,
      );
      assert.equal(new Set(selected.provenance.refs.map((r) => r.referenceKey)).size, 16);
      assert.deepEqual(
        new Set(selected.provenance.refs.map((r) => r.artifact)),
        new Set(['native-artifact', 'bare-artifact']),
      );
      assert.deepEqual(
        (await main.query('SELECT to_jsonb(a) AS row FROM artifacts a ORDER BY id')).rows,
        before,
      );
      await main.query("UPDATE fleet_allocations SET data_json=$1 WHERE id='allocation_0'", [
        JSON.stringify({ runtime: { sandboxId: 'wrong' } }),
      ]);
      await assert.rejects(selection(main, source), /ID sets differ/);
      await main.query("UPDATE fleet_allocations SET data_json=$1 WHERE id='allocation_0'", [
        JSON.stringify({ runtime: { sandboxId: 'sandbox_00' } }),
      ]);
      await source.query("UPDATE storage_objects SET size_bytes=6 WHERE id='native-file'");
      await assert.rejects(selection(main, source), /source identity mismatch/);
      await source.query("UPDATE storage_objects SET size_bytes=5 WHERE id='native-file'");
      await insert('bad-owner', 'other', [refs[0]], []);
      await assert.rejects(selection(main, source), /another project/);
    } finally {
      await source?.end();
      if (madeSource) await main.query('DROP DATABASE ' + sourceName);
      if (madeSchema) await main.query('DROP SCHEMA merv_ts_staging CASCADE');
      await main.end();
    }
  },
);
