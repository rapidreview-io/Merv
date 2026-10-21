import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  readFileSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  exportHistory,
  importHistory,
  identity,
  hash,
  safeRow,
  installDataFile,
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
    const previousDataDir = process.env.STAGING_HISTORY_DATA_DIR;
    const sourceData = join(dir, 'source-data'),
      targetData = join(dir, 'target-data');
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
      const serials = [
        '42',
        '-9223372036854775808',
        '9223372036854775807',
        '9223372036854775806',
        '9007199254740992',
        '9007199254740993',
        ...Array.from({ length: 32 }, () =>
          ((randomBytes(8).readBigUInt64BE() & ((1n << 63n) - 1n)) | (1n << 60n)).toString(),
        ),
      ];
      assert.equal(new Set(serials).size, serials.length);
      for (const [i, serial] of serials.entries()) {
        await source.query(
          "INSERT INTO certificates(serial,namespace,token_id,kind,key_id,key_fingerprint,principals_json,sandbox_id,issued_at,expires_at) VALUES($1,$2,'revoked','user','key','fingerprint','[]','stopped-one','2026-10-19 00:00:00.123456+00','2026-10-20 00:00:00.987654+00')",
          [serial, LEGACY],
        );
        await source.query(
          "INSERT INTO sessions(id,sandbox_id,namespace,certificate_serial,remote_addr,started_at,ended_at) VALUES($1,'stopped-one',$2,$3,'local','2026-10-19 00:00:00.123456+00','2026-10-20 00:00:00.987654+00')",
          ['session-' + i, LEGACY, serial],
        );
      }
      const rate = '123456789012345678.123456789012';
      await source.query(
        "INSERT INTO infra_compute(sandbox_id,account_id,namespace,member_id,provider,source,rate) VALUES('stopped-one','acct_zo40u4jf8tmbhjkh',$1,'member','cloudflare-fleet-staging','host',$2)",
        [LEGACY, rate],
      );
      const exactJson =
        '{"serial":9007199254740993,"decimal":123456789012345678.123456789012,"nested":[9223372036854775807,-9223372036854775808,1e400,null,true,"9007199254740993"]}';
      await source.query("UPDATE sandboxes SET request_json=$1::jsonb WHERE id='stopped-one'", [
        exactJson,
      ]);
      const eventSeqs = ['9007199254740992', '9007199254740993', '9223372036854775807'];
      for (const [i, seq] of eventSeqs.entries())
        await source.query(
          "INSERT INTO sandbox_events(seq,id,sandbox_id,namespace,kind,at,data_json) VALUES($1,$2,'stopped-one',$3,'stopped','2026-10-20 00:00:00.123456+00',$4)",
          [seq, 'event-' + i, LEGACY, exactJson],
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
      const outputs = new Map();
      for (const job of ['flat-job', 'segmented-job']) {
        await source.query(
          "INSERT INTO jobs(id,namespace,sandbox_id,state,revision,command,request_json,epoch,attempts,run_after,created_at,updated_at) VALUES($1,$2,'stopped-one','succeeded',1,'echo history','{}','epoch',1,now(),now(),now())",
          [job, LEGACY],
        );
        for (const stream of ['stdout', 'stderr']) {
          const base = `jobs/${job}/${stream}.log`;
          const bytes = Buffer.from(`${job} ${stream} retained bytes`);
          const start = job === 'flat-job' ? 0 : 7;
          await source.query(
            "INSERT INTO job_outputs(job_id,stream,epoch,available_start,total_length,complete,updated_at) VALUES($1,$2,'epoch',$3,$4,true,now())",
            [job, stream, start, start + bytes.length],
          );
          if (job === 'flat-job') outputs.set(base, bytes);
          else {
            outputs.set(base + '/start', Buffer.from(String(start)));
            outputs.set(base + '/' + String(start).padStart(20, '0'), bytes.subarray(0, 8));
            outputs.set(base + '/' + String(start + 8).padStart(20, '0'), bytes.subarray(8));
          }
        }
      }
      for (const [path, bytes] of outputs) {
        mkdirSync(join(sourceData, path, '..'), { recursive: true });
        writeFileSync(join(sourceData, path), bytes);
      }
      process.env.STAGING_HISTORY_DATA_DIR = sourceData;
      const missing = 'jobs/segmented-job/stdout.log/00000000000000000007';
      unlinkSync(join(sourceData, missing));
      await assert.rejects(exportHistory(source, selection, dir), /segment gap/);
      writeFileSync(join(sourceData, missing), outputs.get(missing));
      const flatPath = 'jobs/flat-job/stdout.log';
      writeFileSync(join(sourceData, flatPath), 'short');
      await assert.rejects(exportHistory(source, selection, dir), /byte length drift/);
      writeFileSync(join(sourceData, flatPath), outputs.get(flatPath));
      await source.query("SET TIME ZONE 'UTC'");
      const bundle = await exportHistory(source, selection, dir),
        binding = await identity(dest);
      for (const zone of ['America/Los_Angeles', 'Asia/Kathmandu']) {
        await source.query("SELECT set_config('TimeZone', $1, false)", [zone]);
        const otherZone = await exportHistory(source, selection, dir);
        assert.equal(otherZone.sha256, bundle.sha256);
        assert.deepEqual(otherZone.rows, bundle.rows);
        assert.equal((await source.query('SHOW TIME ZONE')).rows[0].TimeZone, zone);
      }
      await source.query("SET TIME ZONE 'UTC'");
      assert.equal(bundle.rows.pipelines[0].value.state, 'completed');
      assert.equal(bundle.rows.storage_manifest_refs.length, 1);
      assert.equal(bundle.rows.sessions.length, serials.length);
      assert.equal(bundle.rows.certificates.length, serials.length);
      assert.equal(bundle.version, 2);
      assert.equal((await exportHistory(source, selection, dir)).sha256, bundle.sha256);
      assert.deepEqual(
        new Set(bundle.rows.certificates.map((r) => r.key.serial)),
        new Set(serials),
      );
      assert.deepEqual(
        new Set(bundle.rows.sessions.map((r) => r.value.certificate_serial)),
        new Set(serials),
      );
      for (const r of bundle.rows.certificates) {
        const independent = (
          await source.query(
            "SELECT (to_jsonb(c)||jsonb_build_object('serial',serial::text,'principals_json',principals_json::text)) AS row FROM certificates c WHERE serial=$1",
            [r.key.serial],
          )
        ).rows[0].row;
        assert.deepEqual(r.original, independent);
        assert.equal(r.sourceSha256, hash(independent));
      }
      assert.equal(bundle.rows.infra_compute[0].value.rate, rate);
      assert.deepEqual(
        new Set(bundle.rows.sandbox_events.map((r) => r.value.seq)),
        new Set(eventSeqs),
      );
      const originalHash = bundle.rows.sandboxes.find(
        (r) => r.key.id === 'stopped-one',
      ).sourceSha256;
      await source.query(
        "UPDATE sandboxes SET request_json=jsonb_set(request_json,'{serial}','9007199254740992') WHERE id='stopped-one'",
      );
      assert.notEqual(
        (await exportHistory(source, selection, dir)).rows.sandboxes.find(
          (r) => r.key.id === 'stopped-one',
        ).sourceSha256,
        originalHash,
      );
      await source.query("UPDATE sandboxes SET request_json=$1::jsonb WHERE id='stopped-one'", [
        exactJson,
      ]);
      assert.equal(bundle.rows.api_tokens[0].value.id, 'revoked');
      assert.equal(bundle.dataFiles.length, outputs.size);
      process.env.STAGING_HISTORY_DATA_DIR = targetData;
      const saved = readFileSync(join(dir, bundle.dataFiles[0].sha256));
      unlinkSync(join(dir, bundle.dataFiles[0].sha256));
      await assert.rejects(importHistory(dest, bundle, binding, dir, bundle.sha256), /ENOENT/);
      writeFileSync(join(dir, bundle.dataFiles[0].sha256), 'corrupt');
      await assert.rejects(
        importHistory(dest, bundle, binding, dir, bundle.sha256),
        /private data hash/,
      );
      writeFileSync(join(dir, bundle.dataFiles[0].sha256), saved);
      const { dataFiles: omitted, sha256: oldDigest, ...without } = bundle;
      const incomplete = { ...without, sha256: hash(without) };
      await assert.rejects(
        importHistory(dest, incomplete, binding, dir, incomplete.sha256),
        /manifest missing/,
      );
      const broken = {
        query: async (sql, ...args) => {
          if (sql.startsWith('INSERT INTO')) throw Error('simulated database interruption');
          return dest.query(sql, ...args);
        },
      };
      await assert.rejects(
        importHistory(broken, bundle, binding, dir, bundle.sha256),
        /database interruption/,
      );
      assert.equal((await dest.query('SELECT count(*) FROM job_outputs')).rows[0].count, '0');
      await dest.query("SET TIME ZONE 'UTC'");
      await importHistory(dest, bundle, binding, dir, bundle.sha256);
      for (const zone of ['America/Los_Angeles', 'Asia/Kathmandu']) {
        await dest.query("SELECT set_config('TimeZone', $1, false)", [zone]);
        await importHistory(dest, bundle, binding, dir, bundle.sha256);
        assert.equal((await dest.query('SHOW TIME ZONE')).rows[0].TimeZone, zone);
      }
      for (const [path, bytes] of outputs) {
        assert.deepEqual(readFileSync(join(targetData, path)), bytes);
        assert.equal(hash(readFileSync(join(targetData, path))), hash(bytes));
      }
      assert.equal((await dest.query('SELECT count(*) FROM job_outputs')).rows[0].count, '4');
      assert.deepEqual(
        (await dest.query('SELECT serial::text FROM certificates ORDER BY serial')).rows,
        (await source.query('SELECT serial::text FROM certificates ORDER BY serial')).rows,
      );
      assert.deepEqual(
        (await dest.query('SELECT certificate_serial::text FROM sessions ORDER BY id')).rows,
        (await source.query('SELECT certificate_serial::text FROM sessions ORDER BY id')).rows,
      );
      assert.equal((await dest.query('SELECT rate::text FROM infra_compute')).rows[0].rate, rate);
      assert.equal(
        (
          await dest.query(
            "SELECT request_json::text AS data FROM sandboxes WHERE id='stopped-one'",
          )
        ).rows[0].data,
        (
          await source.query(
            "SELECT request_json::text AS data FROM sandboxes WHERE id='stopped-one'",
          )
        ).rows[0].data,
      );
      await dest.query("UPDATE certificates SET key_id='drift' WHERE serial=9223372036854775807");
      await assert.rejects(importHistory(dest, bundle, binding, dir, bundle.sha256), /same-ID/);
      assert.equal((await dest.query('SHOW TIME ZONE')).rows[0].TimeZone, 'Asia/Kathmandu');
      await dest.query("UPDATE certificates SET key_id='key' WHERE serial=9223372036854775807");
      await importHistory(dest, bundle, binding, dir, bundle.sha256);
      assert.equal((await dest.query('SELECT count(*) FROM sandboxes')).rows[0].count, '1');
      assert.equal((await source.query('SELECT count(*) FROM sandboxes')).rows[0].count, '2');
      assert.equal((await dest.query('SHOW TIME ZONE')).rows[0].TimeZone, 'Asia/Kathmandu');
      await dest.query("SET TIME ZONE 'UTC'");
      for (const table of ['certificates', 'sessions', 'infra_compute', 'sandbox_events']) {
        const sql = `SELECT to_jsonb(t)::text AS exact FROM ${table} t ORDER BY to_jsonb(t)::text`;
        assert.deepEqual((await dest.query(sql)).rows, (await source.query(sql)).rows);
      }
      await assert.rejects(
        dest.query("SELECT nextval(pg_get_serial_sequence('sandbox_events','seq'))"),
        { code: '2200H' },
      );
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
        // Compare exact SQL text under the same rendering timezone on both connections.
        await dest.query("SET TIME ZONE 'UTC'");
        await restored.query("SET TIME ZONE 'UTC'");
        for (const table of Object.keys(bundle.rows)) {
          const a = await dest.query(
              `SELECT to_jsonb(t)::text AS row FROM ${table} t ORDER BY to_jsonb(t)::text`,
            ),
            b = await restored.query(
              `SELECT to_jsonb(t)::text AS row FROM ${table} t ORDER BY to_jsonb(t)::text`,
            );
          assert.deepEqual(b.rows, a.rows);
        }
      } finally {
        await restored.end();
      }
    } finally {
      if (previousDataDir === undefined) delete process.env.STAGING_HISTORY_DATA_DIR;
      else process.env.STAGING_HISTORY_DATA_DIR = previousDataDir;
      await sbx?.close();
      await source?.end();
      await dest?.end();
      for (const name of created) await admin.query(`DROP DATABASE IF EXISTS ${name}`);
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
