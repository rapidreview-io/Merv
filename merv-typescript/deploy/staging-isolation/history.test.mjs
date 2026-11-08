import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import {
  exportHistory,
  hash,
  identity,
  importHistory,
  installDataFile,
  safeRow,
} from './history.mjs';
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

test('private log publication survives SIGKILL mid-write and refuses unrelated final files', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'history-install-')),
    target = join(dir, 'stdout.log'),
    bytes = Buffer.from('complete retained output'),
    digest = hash(bytes);
  try {
    const script = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const original=fs.writeFileSync;fs.writeFileSync=(fd,data,...args)=>{original(fd,data.subarray(0,4),...args);process.kill(process.pid,'SIGKILL');};syncBuiltinESMExports();const {installDataFile}=await import(${JSON.stringify(new URL('./history.mjs', import.meta.url).href)});installDataFile(${JSON.stringify(target)},Buffer.from(${JSON.stringify(bytes.toString())}),${JSON.stringify(digest)});`;
    const killed = spawnSync(process.execPath, ['--input-type=module', '-e', script]);
    assert.equal(killed.signal, 'SIGKILL');
    assert.equal(existsSync(target), false);
    installDataFile(target, bytes, digest);
    installDataFile(target, bytes, digest);
    assert.deepEqual(readFileSync(target), bytes);
    writeFileSync(target, 'unrelated');
    assert.throws(() => installDataFile(target, bytes, digest), /private data conflict/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'exact JSON, decimal and array transport plus non-rewinding INT64 sequence boundary',
  { skip: !url },
  async () => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const created = [],
      dir = mkdtempSync(join(tmpdir(), 'history-exact-'));
    let source, dest;
    try {
      for (const name of ['isolation_source', 'sandboxes_staging']) {
        await admin.query(`CREATE DATABASE ${name}`);
        created.push(name);
      }
      source = new pg.Client({ connectionString: new URL('/isolation_source', url).href });
      dest = new pg.Client({ connectionString: new URL('/sandboxes_staging', url).href });
      await source.connect();
      await dest.connect();
      const ddl =
        'CREATE TABLE certificates(serial BIGSERIAL PRIMARY KEY,amount NUMERIC,payload JSONB,raw_json JSON,peers BIGINT[])';
      await source.query(ddl);
      await dest.query(ddl);
      const small = '9007199254740993',
        max = '9223372036854775807',
        decimal = '123456789012345678901234567890.12345678901234567890';
      const raw = '{ "value": 9223372036854775807, "rate": 0.123456789012345678901234567890 }';
      await source.query('INSERT INTO certificates VALUES($1,$2,$3,$4,$5)', [
        small,
        decimal,
        raw,
        raw,
        '{9223372036854775807,NULL,-9223372036854775808}',
      ]);
      await source.query("INSERT INTO certificates VALUES($1,NULL,'null'::jsonb,NULL,NULL)", [max]);
      const choose = (serials) => ({
        version: 1,
        namespaces: ['archive'],
        roots: serials.map((serial) => ({ table: 'certificates', key: { serial } })),
      });
      const binding = await identity(dest),
        one = await exportHistory(source, choose([small]), dir);
      assert.equal(one.rows.certificates[0].original.amount, decimal);
      assert.equal(one.rows.certificates[0].original.raw_json, raw);
      assert.equal(
        one.rows.certificates[0].original.peers,
        '{9223372036854775807,NULL,-9223372036854775808}',
      );
      const { sha256: ignored, ...legacyBody } = { ...one, version: 1 };
      const legacy = { ...legacyBody, sha256: hash(legacyBody) };
      await assert.rejects(
        importHistory(
          {
            query: () => {
              throw Error('DB must not be reached');
            },
          },
          legacy,
          binding,
          dir,
          legacy.sha256,
        ),
        /version 2/,
      );
      await assert.rejects(
        exportHistory(source, choose([Number(max)]), dir),
        /unsafe numeric row selector/,
      );
      await dest.query("SELECT setval('certificates_serial_seq',9223372036854775805,true)");
      await importHistory(dest, one, binding, dir, one.sha256);
      assert.equal(
        (await dest.query('SELECT last_value::text FROM certificates_serial_seq')).rows[0]
          .last_value,
        '9223372036854775805',
      );
      assert.equal(
        (await dest.query("SELECT nextval('certificates_serial_seq')::text AS value")).rows[0]
          .value,
        '9223372036854775806',
      );
      const all = await exportHistory(source, choose([small, max]), dir);
      await importHistory(dest, all, binding, dir, all.sha256);
      await importHistory(dest, all, binding, dir, all.sha256);
      const sql =
        'SELECT serial::text,amount::text,payload::text,raw_json::text,peers::text FROM certificates ORDER BY serial';
      assert.deepEqual((await dest.query(sql)).rows, (await source.query(sql)).rows);
      assert.deepEqual(
        (await dest.query('SELECT last_value::text,is_called FROM certificates_serial_seq')).rows,
        [{ last_value: max, is_called: true }],
      );
      await assert.rejects(dest.query("SELECT nextval('certificates_serial_seq')"), {
        code: '2200H',
      });
      await dest.query('ALTER SEQUENCE certificates_serial_seq CYCLE');
      await assert.rejects(
        importHistory(dest, all, binding, dir, all.sha256),
        /cycling history sequence/,
      );
    } finally {
      await source?.end();
      await dest?.end();
      for (const name of created) await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
