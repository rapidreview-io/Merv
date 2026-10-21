import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportHistory, importHistory, identity, hash, safeRow } from './history.mjs';
const url = process.env.ISOLATION_TEST_DATABASE_URL;
if (url)
  assert.ok(
    ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname),
    'disposable local PostgreSQL only',
  );
test('archive authority reduction keeps IDs and rejects live credentials', () => {
  assert.deepEqual(safeRow('infra_members', { id: 'same', role: 'admin', disabled: false }, []), {
    id: 'same',
    role: 'member',
    disabled: true,
  });
  assert.throws(() => safeRow('api_tokens', { revoked_at: null }, []), /active credential/);
  assert.throws(
    () => safeRow('sandboxes', { namespace: 'customer', state: 'stopped' }, ['staging']),
    /namespace/,
  );
  assert.equal(
    safeRow('infra_namespaces', { name: 'mixed', merv_project_id: 'p1' }, ['mixed'])
      .merv_project_id,
    null,
  );
});
test(
  'transactional PostgreSQL closure, blobs, conflicts, rollback and idempotent resume',
  { skip: !url },
  async () => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const dir = mkdtempSync(join(tmpdir(), 'isolation-blobs-'));
    const connect = async (name) => {
      const u = new URL(url);
      u.pathname = '/' + name;
      const c = new pg.Client({ connectionString: u.href });
      await c.connect();
      return c;
    };
    let source, dest;
    const created = [];
    try {
      await admin.query('CREATE DATABASE isolation_source');
      created.push('isolation_source');
      await admin.query('CREATE DATABASE sandboxes_staging');
      created.push('sandboxes_staging');
      source = await connect('isolation_source');
      dest = await connect('sandboxes_staging');
      const ddl = `CREATE TABLE infra_accounts(id text PRIMARY KEY,name text,suspended bool);
 CREATE TABLE infra_members(id text PRIMARY KEY,account_id text REFERENCES infra_accounts(id),role text,disabled bool);
 CREATE TABLE infra_namespaces(name text PRIMARY KEY,account_id text REFERENCES infra_accounts(id),default_member_id text REFERENCES infra_members(id),merv_project_id text);
 CREATE TABLE storage_objects(id text PRIMARY KEY,namespace text,kind text,state text,sha256 text,size_bytes bigint,object_key text,entries_json jsonb);
 CREATE TABLE storage_manifest_refs(manifest_id text REFERENCES storage_objects(id),object_id text REFERENCES storage_objects(id),PRIMARY KEY(manifest_id,object_id));`;
      await source.query(ddl);
      await dest.query(ddl);
      await source.query(
        "INSERT INTO infra_accounts VALUES('shared','shared',false); INSERT INTO infra_members VALUES('m','shared','admin',false); INSERT INTO infra_namespaces VALUES('staging','shared','m','p1'),('archive','shared','m',NULL),('customer','shared','m','other')",
      );
      const bytes = Buffer.from('selected immutable bytes'),
        digest = hash(bytes);
      writeFileSync(join(dir, digest), bytes);
      await source.query(
        "INSERT INTO storage_objects VALUES('file','archive','file','available',$1,$2,'old/key','[]'),('manifest','staging','manifest','available',$1,0,NULL,'[{\"object_id\":\"file\"}]'),('unrelated','customer','file','available',$1,$2,'customer/key','[]')",
        [digest, bytes.length],
      );
      await source.query("INSERT INTO storage_manifest_refs VALUES('manifest','file')");
      const selection = {
        version: 1,
        namespaces: ['staging', 'archive'],
        roots: [{ table: 'storage_objects', key: { id: 'manifest' } }],
      };
      const bundle = await exportHistory(source, selection, dir),
        binding = await identity(dest);
      assert.equal(bundle.rows.storage_objects.length, 2);
      assert.equal(bundle.rows.infra_namespaces.length, 2);
      assert.equal(bundle.rows.infra_members[0].original.role, 'admin');
      const tampered = structuredClone(bundle);
      tampered.rows.infra_accounts.push({
        ...tampered.rows.infra_accounts[0],
        key: { id: 'unrelated' },
        original: { ...tampered.rows.infra_accounts[0].original, id: 'unrelated' },
        value: { ...tampered.rows.infra_accounts[0].value, id: 'unrelated' },
      });
      const { sha256: ignored, ...changed } = tampered;
      tampered.sha256 = hash(changed);
      await assert.rejects(
        importHistory(dest, tampered, binding, dir, bundle.sha256),
        /reviewed export digest/,
      );
      await importHistory(dest, bundle, binding, dir, bundle.sha256);
      await importHistory(dest, bundle, binding, dir, bundle.sha256);
      assert.equal((await dest.query('SELECT count(*) FROM storage_objects')).rows[0].count, '2');
      assert.equal(
        (
          await dest.query(
            'SELECT count(*) FROM infra_namespaces WHERE merv_project_id IS NOT NULL',
          )
        ).rows[0].count,
        '0',
      );
      assert.equal(
        (await source.query('SELECT count(*) FROM infra_namespaces')).rows[0].count,
        '3',
      );
      await assert.rejects(
        importHistory(dest, bundle, { ...binding, database: 'postgres' }, dir, bundle.sha256),
        /identity/,
      );
      await assert.rejects(
        exportHistory(source, { ...selection, namespaces: ['staging'] }, dir),
        /namespace/,
      );
      writeFileSync(join(dir, digest), 'corrupt');
      await assert.rejects(
        importHistory(dest, bundle, binding, dir, bundle.sha256),
        /verification/,
      );
      writeFileSync(join(dir, digest), bytes);
      await dest.query("UPDATE storage_objects SET object_key='drift' WHERE id='file'");
      await assert.rejects(importHistory(dest, bundle, binding, dir, bundle.sha256), /same-ID/);
      await source.query('DELETE FROM storage_manifest_refs');
      await assert.rejects(exportHistory(source, selection, dir), /closure/);
    } finally {
      await source?.end();
      await dest?.end();
      for (const name of created) await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'pinned migrations preserve stopped sandbox/session/certificate/token closure and restore',
  { skip: !url },
  async () => {
    const { openDatabase, migrate } = await import('@sandboxes/db');
    const { fenceSource, LEGACY } = await import('./source-fence.mjs');
    const { BillingService } = await import('@sandboxes/billing');
    const { AccountService, ResourceLimitService } = await import('@sandboxes/accounts');
    const { SystemClock } = await import('@sandboxes/kernel');
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const dir = mkdtempSync(join(tmpdir(), 'pinned-history-'));
    let source, dest, sbx;
    const created = [];
    const connect = async (name) => {
      const u = new URL(url);
      u.pathname = '/' + name;
      const c = new pg.Client({ connectionString: u.href });
      await c.connect();
      const db = await openDatabase({ url: u.href, schema: 'public' });
      await migrate(db, { schemaExplicit: true });
      await db.close();
      return c;
    };
    try {
      await admin.query('CREATE DATABASE isolation_source');
      created.push('isolation_source');
      await admin.query('CREATE DATABASE sandboxes_staging');
      created.push('sandboxes_staging');
      source = await connect('isolation_source');
      dest = await connect('sandboxes_staging');
      await source.query(
        "INSERT INTO infra_accounts VALUES('acct_zo40u4jf8tmbhjkh','shared',false,now());INSERT INTO infra_members(id,account_id,name,disabled,role) VALUES('member','acct_zo40u4jf8tmbhjkh','payer',false,'member')",
      );
      await source.query(
        "INSERT INTO infra_namespaces(name,account_id,default_member_id) VALUES($1,'acct_zo40u4jf8t8mbhjkh','member')".replace(
          '8t8',
          '8t',
        ),
        [LEGACY],
      );
      await source.query(
        "INSERT INTO infra_namespaces(name,account_id,default_member_id) VALUES('customer','acct_zo40u4jf8tmbhjkh','member')",
      );
      for (const [id, namespace] of [
        ['stopped-one', LEGACY],
        ['customer-one', 'customer'],
      ])
        await source.query(
          "INSERT INTO sandboxes(id,namespace,name,provider,plugin,state,revision,operation_id,offer_json,request_json,login_user,created_at,updated_at) VALUES($1,$2,$1,'cloudflare-fleet-staging','cloudflare','stopped',1,$1,'{}','{}','root',now(),now())",
          [id, namespace],
        );
      await source.query(
        "INSERT INTO api_tokens(id,namespace,label,token_hash,created_at,revoked_at,account_id,member_id,kind) VALUES('revoked',$1,'archive','hash',now(),now(),'acct_zo40u4jf8tmbhjkh','member','cli')",
        [LEGACY],
      );
      await source.query(
        "INSERT INTO certificates(serial,namespace,token_id,kind,key_id,key_fingerprint,principals_json,sandbox_id,issued_at,expires_at) VALUES(42,$1,'revoked','user','key','fingerprint','[]','stopped-one',now()-interval '2 days',now()-interval '1 day')",
        [LEGACY],
      );
      await source.query(
        "INSERT INTO sessions(id,sandbox_id,namespace,certificate_serial,remote_addr,started_at,ended_at) VALUES('session','stopped-one',$1,42,'local',now()-interval '2 days',now()-interval '1 day')",
        [LEGACY],
      );
      await source.query(
        "INSERT INTO sandbox_events(id,sandbox_id,namespace,kind,at,data_json) VALUES('event','stopped-one',$1,'stopped',now(),'{}')",
        [LEGACY],
      );
      await source.query(
        "INSERT INTO pipelines(id,namespace,name,idempotency_key,request_json,state,outputs_json,progress_json,deadline_at,capture_deadline_at,created_at,updated_at,grant_id) VALUES('completed-producer',$1,'producer','producer','{}','completed','{}','{}',now(),now(),now(),now(),'revoked')",
        [LEGACY],
      );
      const contents = Buffer.from('completed workflow artifact'),
        digest = hash(contents);
      writeFileSync(join(dir, digest), contents);
      for (const [id, kind, entries] of [
        ['file', 'file', []],
        [
          'manifest',
          'manifest',
          [
            {
              object_id: 'file',
              path: 'evidence.txt',
              sha256: digest,
              size_bytes: contents.length,
            },
          ],
        ],
      ]) {
        await source.query(
          "INSERT INTO storage_objects(id,namespace,name,version,kind,state,sha256,size_bytes,content_type,object_key,request_json,entries_json,producer_pipeline_id,created_at,updated_at) VALUES($1::text,$2,$1::text,1,$3,'available',$4,$5,'text/plain',$1::text,'{}',$6,'completed-producer',now(),now())",
          [
            id,
            LEGACY,
            kind,
            digest,
            kind === 'file' ? contents.length : 0,
            JSON.stringify(entries),
          ],
        );
      }
      await source.query("INSERT INTO storage_manifest_refs VALUES('manifest','file')");
      const selection = {
        version: 1,
        namespaces: [LEGACY],
        roots: [
          { table: 'sandboxes', key: { id: 'stopped-one' } },
          { table: 'storage_objects', key: { id: 'manifest' } },
        ],
      };
      const bundle = await exportHistory(source, selection, dir),
        binding = await identity(dest);
      assert.equal(bundle.rows.pipelines[0].value.state, 'completed');
      assert.equal(bundle.rows.storage_manifest_refs.length, 1);
      assert.equal(bundle.rows.sessions.length, 1);
      assert.equal(bundle.rows.certificates.length, 1);
      assert.equal(bundle.rows.api_tokens[0].value.id, 'revoked');
      await importHistory(dest, bundle, binding, dir, bundle.sha256);
      await importHistory(dest, bundle, binding, dir, bundle.sha256);
      assert.equal((await dest.query('SELECT count(*) FROM sandboxes')).rows[0].count, '1');
      assert.equal((await source.query('SELECT count(*) FROM sandboxes')).rows[0].count, '2');
      await fenceSource(source, true);
      assert.equal((await fenceSource(source)).denied, true);
      assert.equal(
        (await source.query("SELECT count(*) FROM infra_provider_controls WHERE target='customer'"))
          .rows[0].count,
        '0',
      );
      const su = new URL(url);
      su.pathname = '/isolation_source';
      sbx = await openDatabase({ url: su.href, schema: 'public' });
      const clock = new SystemClock(),
        accounts = new AccountService(sbx, clock),
        limits = new ResourceLimitService(sbx, clock, accounts),
        billing = new BillingService(sbx, clock, accounts, limits);
      await assert.rejects(
        sbx.transaction((tx) =>
          billing.admit(tx, {
            identity: {
              account_id: 'acct_zo40u4jf8tmbhjkh',
              namespace: LEGACY,
              member_id: 'member',
            },
            offer: { plugin: 'cloudflare' },
            source: 'host',
            leaseSeconds: 900,
            now: clock.now(),
          }),
        ),
        /provider spending is disabled/,
      );
      // Real PostgreSQL logical restore in a separate local DB; don't mistake an import retry for restore rehearsal.
      const { spawnSync } = await import('node:child_process');
      const dump = spawnSync(
        'pg_dump',
        ['--dbname', new URL('/sandboxes_staging', url).href, '--format=custom'],
        { maxBuffer: 64 << 20 },
      );
      assert.equal(dump.status, 0, dump.stderr.toString());
      await admin.query('CREATE DATABASE isolation_restore');
      created.push('isolation_restore');
      const restore = spawnSync(
        'pg_restore',
        ['--dbname', new URL('/isolation_restore', url).href, '--no-owner', '--no-acl'],
        { input: dump.stdout, maxBuffer: 64 << 20 },
      );
      assert.equal(restore.status, 0, restore.stderr.toString());
      const restored = new pg.Client({ connectionString: new URL('/isolation_restore', url).href });
      await restored.connect();
      try {
        for (const table of Object.keys(bundle.rows)) {
          const a = await dest.query(
              `SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`,
            ),
            b = await restored.query(
              `SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`,
            );
          assert.deepEqual(b.rows, a.rows);
        }
      } finally {
        await restored.end();
      }
    } finally {
      await sbx?.close();
      await source?.end();
      await dest?.end();
      for (const name of created) await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
