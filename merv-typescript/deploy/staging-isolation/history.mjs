/** Selective cross-database history transport. No provider calls and no source writes.
 * Run under a private operator directory; receipts contain historical metadata, never bearer secrets.
 * Selection is by reviewed primary keys, never by account or namespace-wide dumps.
 */
import { createHash } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
  renameSync,
  mkdirSync,
  lstatSync,
  readdirSync,
  existsSync,
  linkSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import pg from 'pg';

export const TABLES = new Set(
  'operator_provider_connections infra_accounts persons infra_members infra_namespaces api_tokens runtime_bootstraps budgets sandboxes infra_compute jobs job_events job_outputs job_reader_progress sandbox_events sessions certificates snapshots pipelines storage_objects storage_manifest_refs infra_import_records'.split(
    ' ',
  ),
);
const q = (s) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw Error('unsafe identifier');
  return `"${s}"`;
};
export const canonical = (v) =>
  JSON.stringify(v, (_, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );
export const hash = (v) =>
  createHash('sha256')
    .update(typeof v === 'string' || Buffer.isBuffer(v) ? v : canonical(v))
    .digest('hex');
export function need(ok, message) {
  if (!ok) throw Error(message);
}
export function durable(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  need((lstatSync(dirname(path)).mode & 0o077) === 0, 'operator directory must be private');
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeFileSync(fd, canonical(value) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const dir = openSync(dirname(path), 'r');
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
export async function schema(db) {
  const { rows } = await db.query(`SELECT c.relname AS name,
    (SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'required',a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
    (SELECT jsonb_agg(a.attname ORDER BY k.ord) FROM pg_constraint p CROSS JOIN LATERAL unnest(p.conkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.n WHERE p.conrelid=c.oid AND p.contype='p') AS pk,
    coalesce((SELECT jsonb_agg(jsonb_build_object('target',f.confrelid::regclass::text,'columns',(SELECT jsonb_agg(a.attname ORDER BY k.ord) FROM unnest(f.conkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.n),'foreign',(SELECT jsonb_agg(a.attname ORDER BY k.ord) FROM unnest(f.confkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=f.confrelid AND a.attnum=k.n)) ORDER BY f.conname) FROM pg_constraint f WHERE f.conrelid=c.oid AND f.contype='f'),'[]') AS fk
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname`);
  return Object.fromEntries(rows.filter((r) => TABLES.has(r.name)).map((r) => [r.name, r]));
}
export async function identity(db) {
  return (
    await db.query(
      'SELECT current_database() AS database, (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid, current_user AS role, inet_server_addr()::text AS address, inet_server_port() AS port',
    )
  ).rows[0];
}
const keyOf = (meta, row) => Object.fromEntries(meta.pk.map((k) => [k, row[k]]));
const textTransport = (type) =>
  /^(bigint|numeric|decimal|money)(\(|$)/.test(type) ||
  ['json', 'jsonb'].includes(type) ||
  type.endsWith('[]');
export async function select(db, table, key, meta) {
  const columns = Object.keys(key);
  need(columns.length, 'empty row selector');
  need(meta?.columns?.length, 'row schema required');
  for (const value of Object.values(key))
    need(typeof value !== 'number' || Number.isSafeInteger(value), 'unsafe numeric row selector');
  // Convert exact scalars and JSON/arrays to database text BEFORE JSON parsing in pg.
  // JSON text retains nested exact numbers and the distinct JSON null versus SQL NULL.
  const fields = meta.columns.map(
    (c) => `'${c.name}',${q(c.name)}${textTransport(c.type) ? '::text' : ''}`,
  );
  return (
    await db.query(
      `SELECT jsonb_build_object(${fields.join(',')}) AS row FROM public.${q(table)} t WHERE ${columns.map((k, i) => `${q(k)} IS NOT DISTINCT FROM $${i + 1}`).join(' AND ')}`,
      Object.values(key),
    )
  ).rows.map((r) => r.row);
}
export function safeRow(table, original, namespaces) {
  const row = structuredClone(original);
  if (row.namespace)
    need(namespaces.includes(row.namespace), 'reference crosses unapproved namespace');
  if (table === 'infra_namespaces')
    need(namespaces.includes(row.name), 'unapproved namespace ancestor');
  if (table === 'api_tokens') need(row.revoked_at, 'active credential in historical closure');
  if (table === 'runtime_bootstraps') {
    need(
      ['consumed', 'expired', 'revoked'].includes(row.state),
      'pending or unknown historical bootstrap',
    );
    row.secret = null;
  }
  if (table === 'sandboxes') need(row.state === 'stopped', 'history contains non-stopped sandbox');
  if (table === 'jobs')
    need(['succeeded', 'failed', 'cancelled', 'timed_out'].includes(row.state), 'unfinished job');
  if (table === 'pipelines')
    need(['completed', 'failed', 'cancelled'].includes(row.state), 'unfinished pipeline');
  if (table === 'storage_objects' && row.kind === 'file') {
    need(
      /^[A-Za-z0-9_-]+$/.test(row.id) &&
        /^[A-Za-z0-9_-]+$/.test(row.namespace) &&
        /^[a-f0-9]{64}$/.test(row.sha256),
      'unsafe storage identity',
    );
    row.object_key = `staging-native/history/${row.namespace}/${row.id}/${row.sha256}`;
  }
  if (table === 'snapshots')
    need(
      ['deleted', 'failed'].includes(row.state),
      'readable Kopia snapshots require a separately verified repository rekey receipt',
    );
  if (table === 'sessions') need(row.ended_at, 'open historical session');
  // Retain original provenance in the immutable bundle, but never grant imported human authority.
  if (table === 'infra_members') {
    row.role = 'member';
    row.disabled = true;
  }
  if (table === 'persons') {
    row.username = null;
    row.password_hash = null;
    row.disabled_at ??= row.created_at;
    row.home_namespace = null;
  }
  if (table === 'infra_accounts') row.suspended = true;
  if (table === 'infra_namespaces') row.merv_project_id = null;
  return row;
}
// These logical references are not all declared as PostgreSQL FKs. Follow parents, not siblings.
const parents = {
  jobs: [
    ['sandboxes', 'sandbox_id', 'id'],
    ['storage_objects', 'artifact_id', 'id'],
  ],
  pipelines: [
    ['sandboxes', 'sandbox_id', 'id'],
    ['jobs', 'job_id', 'id'],
  ],
  snapshots: [
    ['sandboxes', 'sandbox_id', 'id'],
    ['jobs', 'job_id', 'id'],
  ],
  storage_objects: [
    ['pipelines', 'producer_pipeline_id', 'id'],
    ['jobs', 'producer_job_id', 'id'],
    ['infra_members', 'member_id', 'id'],
  ],
  storage_manifest_refs: [
    ['storage_objects', 'manifest_id', 'id'],
    ['storage_objects', 'object_id', 'id'],
  ],
  sessions: [
    ['sandboxes', 'sandbox_id', 'id'],
    ['certificates', 'certificate_serial', 'serial'],
  ],
  certificates: [
    ['api_tokens', 'token_id', 'id'],
    ['sandboxes', 'sandbox_id', 'id'],
  ],
  job_events: [['jobs', 'job_id', 'id']],
  job_outputs: [['jobs', 'job_id', 'id']],
  job_reader_progress: [['jobs', 'job_id', 'id']],
  sandbox_events: [['sandboxes', 'sandbox_id', 'id']],
};
// The only permitted missing logical parent is an observed, pre-existing closed-session
// certificate reference. Declared foreign keys always retain their normal closure rules.
function missingCertificateRecord(meta, session, namespaces) {
  const row = session.original;
  safeRow('sessions', row, namespaces);
  need(namespaces.includes(row.namespace), 'unapproved missing-reference namespace');
  need(
    meta.sessions.columns.some((c) => c.name === 'certificate_serial' && c.type === 'bigint') &&
      canonical(meta.certificates?.pk) === canonical(['serial']) &&
      !meta.sessions.fk.some((f) => f.columns.includes('certificate_serial')),
    'missing certificate exception cannot bypass declared FK or ambiguous target schema',
  );
  need(
    typeof row.certificate_serial === 'string' &&
      /^-?\d+$/.test(row.certificate_serial) &&
      session.sourceSha256 === hash(row) &&
      canonical(session.key) === canonical(keyOf(meta.sessions, row)),
    'invalid missing-reference session evidence',
  );
  return {
    kind: 'closed-session-missing-certificate',
    sessionKey: session.key,
    sessionSourceSha256: session.sourceSha256,
    namespace: row.namespace,
    certificateSerial: row.certificate_serial,
    observedSourceTargetRows: 0,
  };
}
function validateMissingReferences(bundle) {
  const expected = [];
  for (const session of bundle.rows.sessions ?? []) {
    const serial = session.original.certificate_serial;
    if (serial == null) continue;
    const matches = (bundle.rows.certificates ?? []).filter((r) => r.original.serial === serial);
    need(matches.length <= 1, 'ambiguous certificate in bundle');
    if (!matches.length)
      expected.push(missingCertificateRecord(bundle.schema, session, bundle.selection.namespaces));
  }
  expected.sort((a, b) => canonical(a).localeCompare(canonical(b)));
  need(
    canonical(bundle.missingReferences ?? []) === canonical(expected),
    'missing-reference manifest differs from exact session closure',
  );
  return expected;
}
export async function exportHistory(db, selection, blobDir, fetchBlob) {
  need(
    selection.version === 1 && selection.namespaces.length && selection.roots.length,
    'invalid selection',
  );
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    // Canonical timestamp JSON must not depend on the caller's session timezone.
    await db.query("SET LOCAL TIME ZONE 'UTC'");
    const source = await identity(db),
      meta = await schema(db),
      rows = {},
      missingReferences = [],
      queue = [...selection.roots];
    while (queue.length) {
      const { table, key } = queue.shift();
      need(TABLES.has(table) && meta[table]?.pk, 'table outside history allowlist');
      const found = await select(db, table, key, meta[table]);
      need(found.length === 1, `missing or ambiguous ${table} reference`);
      const original = found[0],
        sourceSha256 = hash(original),
        pk = keyOf(meta[table], original),
        id = canonical(pk);
      rows[table] ??= {};
      if (rows[table][id]) continue;
      if (table === 'runtime_bootstraps') original.secret = null;
      if (table === 'persons') {
        original.password_hash = null;
        original.username = null;
      }
      const value = safeRow(table, original, selection.namespaces);
      rows[table][id] = { key: pk, sourceSha256, original, value };
      if (original.namespace)
        queue.push({ table: 'infra_namespaces', key: { name: original.namespace } });
      for (const fk of meta[table].fk) {
        const target = fk.target.replace(/^public\./, '');
        if (fk.columns.some((k) => original[k] == null)) continue;
        queue.push({
          table: target,
          key: Object.fromEntries(fk.foreign.map((k, i) => [k, original[fk.columns[i]]])),
        });
      }
      for (const [target, col, dest] of parents[table] ?? []) {
        if (original[col] == null) continue;
        if (table === 'sessions' && col === 'certificate_serial') {
          const targets = await select(db, target, { [dest]: original[col] }, meta[target]);
          need(targets.length <= 1, 'ambiguous certificate reference');
          if (!targets.length) {
            missingReferences.push(
              missingCertificateRecord(meta, rows[table][id], selection.namespaces),
            );
            continue;
          }
        }
        queue.push({ table: target, key: { [dest]: original[col] } });
      }
      for (const [child, col] of table === 'sandboxes'
        ? [
            ['sandbox_events', 'sandbox_id'],
            ['infra_compute', 'sandbox_id'],
            ['sessions', 'sandbox_id'],
            ['certificates', 'sandbox_id'],
            ['runtime_bootstraps', 'sandbox_id'],
            ['jobs', 'sandbox_id'],
            ['snapshots', 'sandbox_id'],
          ]
        : table === 'jobs'
          ? [
              ['job_events', 'job_id'],
              ['job_outputs', 'job_id'],
              ['job_reader_progress', 'job_id'],
            ]
          : []) {
        need(meta[child]?.pk, 'missing history table');
        const children = await select(db, child, { [col]: original.id }, meta[child]);
        for (const row of children) queue.push({ table: child, key: keyOf(meta[child], row) });
      }
      if (table === 'storage_objects' && original.kind === 'manifest') {
        const refs = (
          await db.query(
            'SELECT manifest_id,object_id FROM public.storage_manifest_refs WHERE manifest_id=$1',
            [original.id],
          )
        ).rows;
        for (const ref of refs) queue.push({ table: 'storage_manifest_refs', key: ref });
        // entries_json can carry files whose missing refs would otherwise silently truncate closure.
        const manifest = JSON.parse(original.entries_json);
        const entries = Array.isArray(manifest) ? manifest : manifest?.entries;
        need(Array.isArray(entries), 'unknown manifest entries format');
        for (const entry of entries) {
          const objectId = entry.object_id;
          need(
            typeof objectId === 'string' && refs.some((r) => r.object_id === objectId),
            'manifest FK closure incomplete',
          );
        }
      }
    }
    const files = [];
    for (const r of Object.values(rows.storage_objects ?? {})) {
      const o = r.value;
      need(o.state === 'available', 'object not available');
      if (o.kind === 'file') {
        need(/^[a-f0-9]{64}$/.test(o.sha256), 'invalid blob hash');
        const path = join(blobDir, o.sha256);
        if (fetchBlob) await fetchBlob(r.original, path);
        const st = lstatSync(path);
        need(st.isFile() && !st.isSymbolicLink(), 'blob must be regular file');
        const bytes = readFileSync(path);
        need(
          bytes.length === count(o.size_bytes) && hash(bytes) === o.sha256,
          'missing or corrupt selected blob',
        );
        files.push({
          id: o.id,
          namespace: o.namespace,
          sha256: o.sha256,
          size: o.size_bytes,
          objectKey: o.object_key,
          sourceObjectKey: r.original.object_key,
        });
      }
    }
    const exported = Object.fromEntries(
      Object.entries(rows)
        .sort()
        .map(([t, rs]) => [
          t,
          Object.values(rs).sort((a, b) => canonical(a.key).localeCompare(canonical(b.key))),
        ]),
    );
    const dataFiles = [];
    for (const { value: o } of Object.values(rows.job_outputs ?? {})) {
      need(o.file_state !== 'purge_pending', 'job output retention is in flight');
      if (o.file_state !== 'present' || count(o.total_length) === 0) continue;
      need(
        process.env.STAGING_HISTORY_DATA_DIR,
        'selected job output needs source private data directory',
      );
      need(
        /^[A-Za-z0-9_-]+$/.test(o.job_id) && /^(stdout|stderr)$/.test(o.stream),
        'unsafe output path',
      );
      const relative = `jobs/${o.job_id}/${o.stream}.log`,
        path = join(process.env.STAGING_HISTORY_DATA_DIR, relative);
      const st = lstatSync(path);
      need(!st.isSymbolicLink(), 'symlink output refused');
      const names = st.isDirectory() ? readdirSync(path).sort() : null;
      let end = count(o.available_start);
      for (const name of names ?? ['']) {
        need(name === '' || name === 'start' || /^\d+$/.test(name), 'unknown output segment');
        const file = name ? join(path, name) : path,
          stat = lstatSync(file);
        need(stat.isFile() && !stat.isSymbolicLink(), 'nonregular output segment');
        const bytes = readFileSync(file),
          sha256 = hash(bytes);
        if (name === 'start')
          need(count(bytes.toString()) === count(o.available_start), 'output start drift');
        else end = Math.max(end, count(name || 0) + bytes.length);
        const stored = join(blobDir, sha256);
        if (!existsSync(stored)) {
          const fd = openSync(stored, 'wx', 0o600);
          try {
            writeFileSync(fd, bytes);
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        }
        dataFiles.push({ path: relative + (name ? '/' + name : ''), sha256, size: bytes.length });
      }
      need(end === count(o.total_length), 'output byte length drift');
    }
    const body = {
      version: 2,
      encoding: 'postgres-exact-text-v1',
      source,
      selection,
      schema: meta,
      rows: exported,
      missingReferences: missingReferences.sort((a, b) => canonical(a).localeCompare(canonical(b))),
      files,
      dataFiles,
    };
    validateMissingReferences(body);
    validateOutputFiles(body, blobDir);
    await db.query('ROLLBACK');
    return { ...body, sha256: hash(body) };
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
}
function validateOutputFiles(bundle, blobDir) {
  const files = bundle.dataFiles ?? [];
  const paths = new Set();
  for (const f of files) {
    need(!paths.has(f.path), 'duplicate private data path');
    paths.add(f.path);
    need(/^[a-f0-9]{64}$/.test(f.sha256), 'invalid private data hash');
    const bytes = readFileSync(join(blobDir, f.sha256));
    need(hash(bytes) === f.sha256 && bytes.length === f.size, 'private data hash mismatch');
  }
  const used = new Set();
  for (const { value: o } of bundle.rows.job_outputs ?? []) {
    need(o.file_state !== 'purge_pending', 'job output retention is in flight');
    if (o.file_state !== 'present' || count(o.total_length) === 0) continue;
    const base = `jobs/${o.job_id}/${o.stream}.log`,
      start = count(o.available_start),
      end = count(o.total_length);
    const selected = files.filter((f) => f.path === base || f.path.startsWith(base + '/'));
    need(selected.length > 0, 'retained output file manifest missing');
    selected.forEach((f) => used.add(f.path));
    const flat = selected.find((f) => f.path === base);
    if (flat)
      need(
        selected.length === 1 && start === 0 && flat.size === end,
        'flat output byte range mismatch',
      );
    else {
      const marker = selected.find((f) => f.path === base + '/start');
      need(
        marker && count(readFileSync(join(blobDir, marker.sha256)).toString()) === start,
        'output start marker missing or changed',
      );
      const segments = selected
        .filter((f) => f !== marker)
        .map((f) => ({ file: f, offset: count(f.path.slice(base.length + 1)) }))
        .sort((a, b) => a.offset - b.offset);
      let cursor = start;
      for (const { file, offset } of segments) {
        need(
          Number.isSafeInteger(offset) &&
            offset >= 0 &&
            offset <= cursor &&
            offset + file.size >= cursor,
          'output segment gap or overlap',
        );
        cursor = offset + file.size;
      }
      need(cursor === end, 'output retained range incomplete');
    }
  }
  need(used.size === files.length, 'private file lacks retained output metadata');
}

/** Publish a fully fsynced inode without overwriting an existing final pathname.
 * Crashes leave only unreferenced private temporary files; retry always uses a fresh temp.
 */
export function installDataFile(target, bytes, sha256) {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const verify = () =>
    need(
      lstatSync(target).isFile() &&
        !lstatSync(target).isSymbolicLink() &&
        hash(readFileSync(target)) === sha256,
      'private data conflict',
    );
  if (existsSync(target)) verify();
  else {
    const tempDir = mkdtempSync(join(dirname(target), '.history-import-'));
    const temp = join(tempDir, 'bytes');
    try {
      const fd = openSync(temp, 'wx', 0o600);
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      need(hash(readFileSync(temp)) === sha256, 'private data temporary write mismatch');
      try {
        linkSync(temp, target);
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        verify();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
  const parent = openSync(dirname(target), 'r');
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

/** Keep sequence arithmetic inside PostgreSQL; never max+1 (INT64_MAX overflows).
 * Existing sequence high-water marks are retained, including on idempotent import.
 */
export async function resetSequence(db, table, column) {
  const row = (
    await db.query(
      `SELECT s.seqrelid::regclass::text AS seq,n.nspname,c.relname,s.seqincrement::text AS increment,s.seqcycle AS cycle
    FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE s.seqrelid=pg_get_serial_sequence($1,$2)::regclass`,
      ['public.' + table, column],
    )
  ).rows[0];
  if (!row) return;
  need(
    BigInt(row.increment) > 0n && !row.cycle,
    'descending/cycling history sequence requires explicit review',
  );
  await db.query(
    `WITH m AS (SELECT max(${q(column)}) AS maximum FROM public.${q(table)}),
    last AS (SELECT last_value,is_called FROM ${q(row.nspname)}.${q(row.relname)}),
    chosen AS (SELECT greatest(coalesce(m.maximum,s.seqmin),s.seqmin,last.last_value) AS value,
      m.maximum,last.is_called FROM m,last,pg_sequence s WHERE s.seqrelid=$1::regclass)
    SELECT setval($1::regclass,value,is_called OR coalesce(maximum>=value,false)) FROM chosen`,
    [row.seq],
  );
}

function count(value) {
  const n = Number(value);
  need(Number.isSafeInteger(n) && n >= 0, 'file offset/size exceeds exact supported range');
  return n;
}

export async function importHistory(db, bundle, expectedIdentity, blobDir, expectedDigest) {
  const { sha256, ...body } = bundle;
  need(
    typeof expectedDigest === 'string' &&
      /^[a-f0-9]{64}$/.test(expectedDigest) &&
      sha256 === expectedDigest,
    'bundle differs from independently reviewed export digest',
  );
  need(hash(body) === sha256, 'bundle hash mismatch');
  need(
    bundle.version === 2 && bundle.encoding === 'postgres-exact-text-v1',
    'lossless version 2 export required; re-export legacy bundles',
  );
  need(
    expectedIdentity.database === 'sandboxes_staging' &&
      canonical(await identity(db)) === canonical(expectedIdentity),
    'wrong destination database identity',
  );
  need(canonical(expectedIdentity) !== canonical(bundle.source), 'source and destination coincide');
  need(canonical(await schema(db)) === canonical(bundle.schema), 'schema drift');
  const missingReferences = validateMissingReferences(bundle);
  for (const f of bundle.files) {
    const b = readFileSync(join(blobDir, f.sha256));
    need(hash(b) === f.sha256 && b.length === count(f.size), 'blob verification failed');
  }
  validateOutputFiles(bundle, blobDir);
  for (const file of bundle.dataFiles ?? []) {
    need(
      /^jobs\/[A-Za-z0-9_-]+\/(stdout|stderr)\.log(?:\/(start|[0-9]+))?$/.test(file.path),
      'unsafe private data path',
    );
    need(process.env.STAGING_HISTORY_DATA_DIR, 'destination private data directory required');
    const bytes = readFileSync(join(blobDir, file.sha256));
    need(hash(bytes) === file.sha256 && bytes.length === file.size, 'private data hash mismatch');
    const target = join(process.env.STAGING_HISTORY_DATA_DIR, file.path);
    installDataFile(target, bytes, file.sha256);
  }
  await db.query('BEGIN');
  try {
    // Match export rendering without changing the caller's session setting.
    await db.query("SET LOCAL TIME ZONE 'UTC'");
    await db.query("SELECT pg_advisory_xact_lock(hashtext('merv-staging-history-import'))");
    if (missingReferences.length) {
      // Keep absence stable through commit, including against concurrent certificate writers.
      await db.query('LOCK TABLE public.certificates IN SHARE MODE');
      for (const ref of missingReferences)
        need(
          (
            await select(
              db,
              'certificates',
              { serial: ref.certificateSerial },
              bundle.schema.certificates,
            )
          ).length === 0,
          'missing-reference target is present at destination',
        );
    }
    // FK order is derived from the actual pinned schema. No constraint disabling or broad upsert.
    const pending = Object.keys(bundle.rows),
      done = new Set();
    while (pending.length) {
      const index = pending.findIndex((t) =>
        bundle.schema[t].fk.every((f) => !pending.includes(f.target.replace(/^public\./, ''))),
      );
      need(index >= 0, 'cyclic FK graph requires explicit reviewed migration');
      const [table] = pending.splice(index, 1);
      need(TABLES.has(table), 'unapproved import table');
      for (const r of bundle.rows[table]) {
        for (const row of [r.original, r.value, r.key])
          for (const c of bundle.schema[table].columns)
            if (c.name in row && textTransport(c.type))
              need(
                row[c.name] === null || typeof row[c.name] === 'string',
                'exact column requires database text encoding',
              );
        need(
          canonical(r.value) === canonical(safeRow(table, r.original, bundle.selection.namespaces)),
          'unreviewed row transformation',
        );
        const existing = await select(db, table, r.key, bundle.schema[table]);
        if (existing.length) {
          need(canonical(existing[0]) === canonical(r.value), 'same-ID destination conflict');
          continue;
        }
        const columns = bundle.schema[table].columns.map((c) => c.name);
        await db.query(
          `INSERT INTO public.${q(table)} (${columns.map(q).join(',')}) VALUES (${columns.map((_, i) => '$' + (i + 1)).join(',')})`,
          columns.map((name) => r.value[name]),
        );
      }
      done.add(table);
    }
    for (const table of done)
      for (const column of bundle.schema[table].columns)
        await resetSequence(db, table, column.name);
    await db.query('COMMIT');
    return {
      bundle: sha256,
      destination: expectedIdentity,
      missingReferences,
      rows: Object.fromEntries(Object.entries(bundle.rows).map(([t, r]) => [t, r.length])),
    };
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
}
if (process.argv[1]?.endsWith('/history.mjs')) {
  const [action, input, blobs, output] = process.argv.slice(2);
  const db = new pg.Client({ connectionString: process.env.STAGING_HISTORY_DATABASE_URL });
  try {
    need(['export', 'import', 'identity'].includes(action), 'expected export/import/identity');
    await db.connect();
    const data =
      action === 'identity'
        ? await identity(db)
        : action === 'export'
          ? await exportHistory(db, JSON.parse(readFileSync(input)), blobs)
          : await importHistory(
              db,
              JSON.parse(readFileSync(input)),
              JSON.parse(readFileSync(process.env.STAGING_HISTORY_IDENTITY_FILE)),
              blobs,
              process.env.STAGING_HISTORY_EXPECTED_SHA256,
            );
    durable(output, data);
    console.log(JSON.stringify({ ok: true, receipt: output }));
  } catch {
    console.error(
      'History operation refused; inspect private inputs and database diagnostics. No credentials are logged.',
    );
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}
