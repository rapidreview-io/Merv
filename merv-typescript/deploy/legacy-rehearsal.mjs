import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client, types } from 'pg';
import { canonical, check, digest } from '@merv/contracts';
import { S3Blobs } from '@merv/blobs';
import { createApp } from '../dist/src/app.js';
import { importLegacyFoundation, planLegacyFoundation } from '../dist/src/legacy-import.js';
import {
  planLegacyMedia,
  prepareLegacyMediaFoundation,
  legacyUnavailableArtifacts,
} from '../dist/src/legacy-media.js';
import {
  legacyHistoryTables,
  legacyHistoryExportSpec,
  projectLegacyHistoryRow,
  planLegacyHistory,
  importLegacyHistory,
  planLegacyHistoryArtifactRetention,
} from '../dist/src/legacy-history.js';
import { deploymentSchema } from './schema.mjs';
import { pruneLegacySnapshot } from './prune-legacy.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const required = (name) => {
  check(process.env[name]?.trim(), 'legacy_configuration', `Required environment name: ${name}`);
  return process.env[name];
};
const identifier = (name) => {
  check(
    /^[a-z_][a-z0-9_]*$/.test(name),
    'legacy_export_identifier',
    'Invalid fixed SQL identifier',
  );
  return `"${name}"`;
};
const count = (value) => {
  const number = Number(value);
  check(Number.isSafeInteger(number) && number >= 0, 'legacy_count_range', 'Invalid source count');
  return number;
};
const safeInteger = (value) => {
  const number = Number(value);
  check(Number.isSafeInteger(number), 'legacy_integer_range', 'Source integer is not exact');
  return number;
};

function privateDirectory(directory, create = false) {
  if (create) mkdirSync(directory, { mode: 0o700, recursive: true });
  const stat = lstatSync(directory);
  check(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid() &&
      !(stat.mode & 0o077),
    'legacy_export_permissions',
    'Snapshot directory must be private and owned by its operator',
  );
}
function readPrivate(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    check(
      stat.isFile() &&
        stat.uid === process.getuid() &&
        !(stat.mode & 0o077) &&
        stat.size <= 512 * 1024 * 1024,
      'legacy_export_permissions',
      'Snapshot file must be private, bounded and owned by its operator',
    );
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function writePrivate(path, value) {
  const bytes = Buffer.from(canonical(value) + '\n');
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      // A hard link publishes the complete file atomically without replacing an existing report.
      linkSync(temporary, path);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      check(
        readPrivate(path).equals(bytes),
        'legacy_report_conflict',
        'An immutable export/report already contains different data',
      );
    }
    const directoryFd = openSync(
      dirname(path),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } finally {
    // Only this invocation's exclusive temporary file is removed; the published report is retained.
    unlinkSync(temporary);
  }
  return hash(bytes);
}

/** One complete export. The connection is read-only before any application SQL runs. */
export async function captureSnapshot(client, sourceId, issuer) {
  check(
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(sourceId),
    'legacy_source_id',
    'Invalid source ID',
  );
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const metadata = (
      await client.query(
        "SELECT transaction_timestamp() AS captured_at, pg_current_snapshot()::text AS snapshot_id, current_setting('transaction_read_only') AS read_only, current_setting('server_version') AS server_version, (SELECT max(version) FROM public.schema_migrations) AS schema_version",
      )
    ).rows[0];
    check(
      metadata.read_only === 'on' && Number(metadata.schema_version) === 81,
      'legacy_source_schema',
      'Source must be read-only schema 81',
    );
    const tables = {};
    const sourceCounts = {};
    const inventory = (
      await client.query(
        "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public' ORDER BY tablename",
      )
    ).rows.map((row) => row.tablename);
    for (const table of inventory) {
      sourceCounts[table] = count(
        (await client.query(`SELECT count(*) AS count FROM public.${identifier(table)}`)).rows[0]
          .count,
      );
    }
    for (const [table, spec] of Object.entries(legacyHistoryTables)) {
      const columns = spec.columns.map(identifier).join(',');
      const order = spec.keys.map(identifier).join(',');
      const rows = (
        await client.query(`SELECT ${columns} FROM public.${identifier(table)} ORDER BY ${order}`)
      ).rows;
      check(
        rows.length === sourceCounts[table],
        'legacy_export_count',
        'Projected history count differs from its snapshot source count',
      );
      tables[table] = rows.map((row) => projectLegacyHistoryRow(table, row));
    }
    const memberships = (
      await client.query(
        'SELECT project_id,user_id,added_at FROM public.project_members ORDER BY project_id,user_id',
      )
    ).rows;
    check(
      memberships.length === sourceCounts.project_members,
      'legacy_export_count',
      'Membership count differs from source',
    );
    const capturedAt = new Date(metadata.captured_at).toISOString();
    const projectIds = tables.projects.map((row) => row.id).sort();
    const pick = (row, names) => Object.fromEntries(names.map((name) => [name, row[name]]));
    const foundation = {
      sourceId,
      schemaVersion: 81,
      issuer,
      projects: tables.projects.map((row) =>
        pick(row, ['id', 'name', 'summary', 'created_at', 'status']),
      ),
      memberships,
      artifacts: tables.artifacts
        .filter((row) => row.status === 'complete')
        .map((row) =>
          pick(row, [
            'id',
            'project_id',
            'title',
            'path',
            'created_by',
            'created_at',
            'status',
            'content_type',
            'content_sha256',
            'size_bytes',
          ]),
        ),
      claims: tables.claims.map((row) =>
        pick(row, ['id', 'project_id', 'statement', 'scope', 'status', 'confidence', 'created_at']),
      ),
    };
    const history = {
      sourceId,
      schemaVersion: 81,
      projectionVersion: legacyHistoryExportSpec.projectionVersion,
      capturedAt,
      consistency: 'postgres-repeatable-read-read-only',
      projectIds,
      tables,
    };
    await client.query('COMMIT');
    return {
      format: 'merv-legacy-export-v1',
      metadata: {
        capturedAt,
        postgresSnapshot: metadata.snapshot_id,
        serverVersion: metadata.server_version,
      },
      sourceCounts,
      foundation,
      history,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export function planSnapshot(snapshot, unavailableAudit) {
  check(
    snapshot?.format === 'merv-legacy-export-v1',
    'legacy_export_format',
    'Unknown export format',
  );
  check(
    snapshot.foundation?.sourceId === snapshot.history?.sourceId,
    'legacy_export_mismatch',
    'Foundation and history source IDs differ',
  );
  check(
    snapshot.metadata?.capturedAt === snapshot.history?.capturedAt,
    'legacy_export_mismatch',
    'Snapshot and history capture times differ',
  );
  const foundation = planLegacyFoundation(snapshot.foundation);
  const history = planLegacyHistory(snapshot.history);
  const equal = (one, two) =>
    check(
      digest(one) === digest(two),
      'legacy_export_mismatch',
      'Foundation and history projections differ',
    );
  equal(
    foundation.snapshot.projects.map((row) => row.id).sort(),
    [...snapshot.history.projectIds].sort(),
  );
  for (const table of Object.keys(legacyHistoryTables)) {
    check(
      history.counts[table] === snapshot.sourceCounts[table],
      'legacy_export_count',
      'Source count differs from projected history',
    );
  }
  check(
    foundation.memberships === snapshot.sourceCounts.project_members,
    'legacy_export_count',
    'Source membership count differs',
  );
  const byId = (rows) => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const [name, fields, filter] of [
    ['projects', ['id', 'name', 'summary', 'created_at', 'status'], () => true],
    [
      'claims',
      ['id', 'project_id', 'statement', 'scope', 'status', 'confidence', 'created_at'],
      () => true,
    ],
    [
      'artifacts',
      [
        'id',
        'project_id',
        'title',
        'path',
        'created_by',
        'created_at',
        'status',
        'content_type',
        'content_sha256',
        'size_bytes',
      ],
      (row) => row.status === 'complete',
    ],
  ])
    equal(
      byId(foundation.snapshot[name]),
      byId(
        snapshot.history.tables[name]
          .filter(filter)
          .map((row) => Object.fromEntries(fields.map((field) => [field, row[field]]))),
      ),
    );
  // A historical instance is not a new native lease, task, review claim or resumable workflow.
  const nonResumableWork = snapshot.history.tables.workflow_instances
    .filter((row) => !row.outcome)
    .map((row) => ({
      projectId: row.project_id,
      id: row.id,
      workflow: row.workflow,
      version: row.version,
      state: row.state,
    }));
  return {
    foundation,
    history,
    nonResumableWork,
    media: mediaInventory(snapshot.history, unavailableAudit),
  };
}

/** Shared with the offline importer and historical UI's deterministic file bindings. */
export const mediaInventory = planLegacyMedia;

/** All network verification completes before either metadata importer starts. */
export async function prepareMedia(snapshot, copyObject, progress = () => {}, unavailableAudit) {
  const media = mediaInventory(snapshot.history, unavailableAudit);
  const receipts = new Array(media.objects.length);
  let next = 0,
    verified = 0,
    failed = false;
  const worker = async () => {
    while (!failed && next < media.objects.length) {
      const index = next++,
        object = media.objects[index];
      try {
        const receipt = await copyObject(object.namespace, object.hash, object.size ?? undefined);
        check(
          receipt.hash === object.hash && (object.size === null || receipt.size === object.size),
          'legacy_blob_mismatch',
          'Verified copy does not match its retained source reference',
        );
        receipts[index] = { namespace: object.namespace, hash: receipt.hash, size: receipt.size };
        verified++;
        if (verified % 25 === 0 || verified === media.objects.length)
          progress({ phase: 'media_copy', verified, total: media.objects.length });
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  // Bound independent streams and drain all in-flight copies before reporting failure or importing.
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(4, media.objects.length) }, worker),
  );
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  return prepareLegacyMediaFoundation(
    snapshot.foundation,
    snapshot.history,
    receipts,
    unavailableAudit,
  );
}

function preparedMedia(directory, snapshot, manifest, target, unavailableAudit, prepared) {
  const path = join(directory, `prepared-${target.schema}.json`);
  if (prepared) {
    writePrivate(path, { snapshotSha256: manifest.snapshotSha256, target, ...prepared });
    return prepared;
  }
  const stored = JSON.parse(readPrivate(path));
  const recomputed = prepareLegacyMediaFoundation(
    snapshot.foundation,
    snapshot.history,
    stored.manifest?.verifiedObjects,
    unavailableAudit,
  );
  check(
    canonical(stored) ===
      canonical({ snapshotSha256: manifest.snapshotSha256, target, ...recomputed }),
    'legacy_media_manifest',
    'Prepared media manifest does not match its source snapshot and target',
  );
  return recomputed;
}

// Approved prior Merv migration audit: exact legacy-lineage exceptions, never a generic 404 skip.
const lineageAuditSha256 = '701a765373829fff4cd9ab33321a6ee72e784763337e1da6c882c094eea75ade';
function loadUnavailableAudit(directory) {
  const path = join(directory, 'preexisting-artifact-audit.json');
  return existsSync(path)
    ? legacyUnavailableArtifacts(readPrivate(path), lineageAuditSha256)
    : undefined;
}

function loadExport(directory) {
  privateDirectory(directory);
  const manifest = JSON.parse(readPrivate(join(directory, 'manifest.json')));
  const bytes = readPrivate(join(directory, 'snapshot.json'));
  check(
    hash(bytes) === manifest.snapshotSha256,
    'legacy_export_hash',
    'Snapshot hash does not match its manifest',
  );
  const snapshot = JSON.parse(bytes);
  const unavailableAudit = loadUnavailableAudit(directory);
  const plan = planSnapshot(snapshot, unavailableAudit);
  check(
    digest(snapshot.sourceCounts) === digest(manifest.sourceCounts) &&
      manifest.projectionVersion === snapshot.history.projectionVersion,
    'legacy_export_count',
    'Manifest source counts differ',
  );
  return { snapshot, plan, manifest, unavailableAudit };
}

function summary(snapshot, plan) {
  return {
    sourceId: snapshot.foundation.sourceId,
    foundationFingerprint: plan.foundation.fingerprint,
    historyFingerprint: plan.history.fingerprint,
    nativeCounts: {
      projects: plan.foundation.projects,
      memberships: plan.foundation.memberships,
      artifacts: plan.foundation.artifacts,
      claims: plan.foundation.claims,
    },
    historyCounts: plan.history.counts,
    historyProjectCounts: plan.history.projectCounts,
    distinctArtifactBlobs: plan.foundation.distinctBlobs,
    oversizedArtifacts: plan.foundation.oversizedArtifacts.length,
    nonResumableWork: plan.nonResumableWork,
    mediaInventory: plan.media,
    metadataOnlyArtifacts: plan.media.metadataOnlyArtifacts.length,
    nativeWorkflowContinuation: 'not-imported',
    objectCoverage:
      'planned completed artifacts, figures and retained feed media; bytes not yet verified',
    excludedTables: legacyHistoryExportSpec.excludedTables,
    credentialsImported: false,
  };
}

/** Prevent rehearsal from occupying the existing staging schema or sharing its object prefix. */
export function importTarget(schema, prefix, sourcePrefix) {
  deploymentSchema(schema);
  check(
    schema !== 'merv_ts',
    'legacy_target_schema',
    'Import requires a separate versioned merv_ts_* schema',
  );
  check(
    prefix === `merv-ts/${schema}` && prefix !== sourcePrefix,
    'legacy_target_prefix',
    'Import requires its exact separate schema-specific object prefix',
  );
  return { schema, prefix };
}
/** Non-secret environment identity prevents a receipt from being reused for another store. */
export function targetIdentity(
  schema,
  prefix,
  sourcePrefix,
  connection,
  endpoint,
  bucket,
  region = 'auto',
) {
  const target = importTarget(schema, prefix, sourcePrefix);
  const database = new URL(connection);
  const storage = new URL(endpoint);
  check(
    ['postgres:', 'postgresql:'].includes(database.protocol) &&
      storage.protocol === 'https:' &&
      !storage.username &&
      !storage.password &&
      !storage.search &&
      !storage.hash &&
      bucket?.trim() === bucket &&
      bucket.length > 0,
    'legacy_target_identity',
    'Target database and storage identity must be explicit and valid',
  );
  return {
    ...target,
    database: {
      host: database.searchParams.get('host') ?? database.hostname,
      port: database.searchParams.get('port') ?? (database.port || '5432'),
      name: decodeURIComponent(database.pathname.slice(1)),
    },
    storage: { endpoint: storage.href.replace(/\/$/, ''), bucket, region, prefix },
  };
}

const sortRows = (rows) => rows.map(canonical).sort();
const sameRows = (actual, expected) =>
  check(
    digest(sortRows(actual)) === digest(sortRows(expected)),
    'legacy_reconciliation',
    'Imported native rows differ from the source projection',
  );

export async function reconcile(state, snapshot, plan, artifactRetention) {
  const retention = planLegacyHistoryArtifactRetention(plan.history, artifactRetention);
  const f = plan.foundation.snapshot;
  return state.read(async (sql) => {
    const rows = {};
    rows.projects = await sql.all('SELECT id,name,summary,created_at FROM projects');
    sameRows(
      rows.projects,
      f.projects.map(({ id, name, summary, created_at }) => ({ id, name, summary, created_at })),
    );
    rows.memberships = await sql.all(
      'SELECT project_id,issuer,subject,role,active,created_at FROM project_memberships',
    );
    sameRows(
      rows.memberships,
      f.memberships.map((row) => ({
        project_id: row.project_id,
        issuer: f.issuer,
        subject: row.user_id,
        role: 'operator',
        active: 1,
        created_at: row.added_at,
      })),
    );
    rows.artifacts = await sql.all(
      'SELECT id,project_id,created_by,title,media_type,hash,size,created_at FROM artifacts',
    );
    sameRows(
      rows.artifacts,
      f.artifacts.map((row) => ({
        id: row.id,
        project_id: row.project_id,
        created_by: row.created_by,
        title: row.title || row.path || row.id,
        media_type: row.content_type,
        hash: row.content_sha256,
        size: row.size_bytes,
        created_at: row.created_at,
      })),
    );
    rows.claims = await sql.all(
      'SELECT id,project_id,statement,scope,status,confidence,created_at FROM claims',
    );
    sameRows(
      rows.claims,
      f.claims.map(({ id, project_id, statement, scope, status, confidence, created_at }) => ({
        id,
        project_id,
        statement,
        scope,
        status,
        confidence,
        created_at,
      })),
    );
    const retained = await sql.all(
      'SELECT project_id,record_type,source_key,content_hash,data_json,summary_json FROM legacy_history_records WHERE source_id=?',
      f.sourceId,
    );
    sameRows(
      retained.map(({ summary_json, ...row }) => row),
      plan.history.records.map((row) => ({
        project_id: row.projectId,
        record_type: row.type,
        source_key: row.id,
        content_hash: row.hash,
        data_json: row.json,
      })),
    );
    for (const row of retained)
      check(
        digest(JSON.parse(row.data_json)) === row.content_hash,
        'legacy_reconciliation',
        'Stored history bytes differ from retained hash',
      );
    for (const row of retained)
      if (row.record_type === 'artifacts')
        check(
          canonical(JSON.parse(row.summary_json).fileRetention) ===
            canonical(retention.byId.get(row.source_key)),
          'legacy_reconciliation',
          'Historical artifact availability differs from its verified retention map',
        );
    const historyReceipt = await sql.get(
      'SELECT fingerprint,receipt FROM legacy_history_imports WHERE source_id=?',
      f.sourceId,
    );
    check(
      historyReceipt?.fingerprint === plan.history.fingerprint &&
        canonical(JSON.parse(historyReceipt.receipt).artifactRetention) ===
          canonical(retention.receipt),
      'legacy_reconciliation',
      'Historical receipt does not match its source and artifact retention fingerprints',
    );
    const projectCounts = {};
    for (const project of f.projects)
      projectCounts[project.id] = {
        projects: 1,
        memberships: f.memberships.filter((row) => row.project_id === project.id).length,
        artifacts: f.artifacts.filter((row) => row.project_id === project.id).length,
        claims: f.claims.filter((row) => row.project_id === project.id).length,
        history: plan.history.projectCounts[project.id],
      };
    return {
      nativeRowsAndHashes: 'matched',
      historyRowsAndHashes: 'matched',
      artifactAvailabilityAndReceipt: 'matched',
      projects: projectCounts,
    };
  });
}

async function withTarget(fn) {
  const target = targetIdentity(
    required('MERV_TS_DB_SCHEMA'),
    required('MERV_BLOB_PREFIX'),
    process.env.MERV_LEGACY_BLOB_PREFIX ?? '',
    required('MERV_DB_URL'),
    required('MERV_BLOB_ENDPOINT_URL'),
    required('MERV_BLOB_BUCKET'),
    process.env.MERV_BLOB_REGION || 'auto',
  );
  const config = JSON.parse(
    readFileSync(new URL('../dist/config/default.json', import.meta.url), 'utf8'),
  );
  config.plugins = config.plugins.filter((entry) =>
    ['state', 'scope', 'blobs', 'artifacts', 'claims'].includes(entry.id),
  );
  config.plugins.find((entry) => entry.id === 'state').config = {
    backend: 'postgres',
    connectionStringEnv: 'MERV_DB_URL',
    schema: target.schema,
    statementTimeoutMs: 120000,
  };
  config.plugins.find((entry) => entry.id === 'blobs').config = { backend: 's3' };
  const app = await createApp({ directory: '/tmp/merv-legacy-import', config });
  try {
    return await fn(app.ctx.state, app.ctx.blobs, target);
  } finally {
    await app.stop();
  }
}

async function main() {
  const [command, argument, ...extra] = process.argv.slice(2);
  check(
    ['export', 'prune', 'plan', 'import', 'reconcile'].includes(command) &&
      argument &&
      extra.length === 0,
    'legacy_arguments',
    'Use export|prune|plan|import|reconcile PRIVATE_DIRECTORY',
  );
  check(
    process.getuid?.() === 0,
    'legacy_export_permissions',
    'Run the offline deployment command as root',
  );
  const directory = resolve(argument);
  if (command === 'export') {
    privateDirectory(directory, true);
    const client = new Client({
      connectionString: required('MERV_LEGACY_DB_URL'),
      options: '-c default_transaction_read_only=on',
      statement_timeout: 120000,
      connectionTimeoutMillis: 5000,
      types: {
        getTypeParser: (oid, format) =>
          oid === 20 && format !== 'binary' ? safeInteger : types.getTypeParser(oid, format),
      },
    });
    await client.connect();
    let snapshot;
    try {
      snapshot = await captureSnapshot(
        client,
        required('MERV_LEGACY_SOURCE_ID'),
        required('SUPABASE_URL').replace(/\/$/, '') + '/auth/v1',
      );
    } finally {
      await client.end();
    }
    const snapshotSha256 = writePrivate(join(directory, 'snapshot.json'), snapshot);
    const manifestSha256 = writePrivate(join(directory, 'manifest.json'), {
      format: snapshot.format,
      sourceId: snapshot.foundation.sourceId,
      schemaVersion: 81,
      projectionVersion: snapshot.history.projectionVersion,
      ...snapshot.metadata,
      sourceCounts: snapshot.sourceCounts,
      snapshotSha256,
      structuredSecrets: 'excluded-by-fixed-history-projection',
      prose: 'retained-private-research-content',
      sourceReadOnly: true,
    });
    console.log(JSON.stringify({ manifestSha256 }));
    return;
  }
  const { snapshot, plan, manifest, unavailableAudit } = loadExport(directory);
  if (command === 'prune') {
    const destination = resolve(required('MERV_LEGACY_DERIVED_DIRECTORY'));
    check(
      destination !== directory,
      'legacy_prune_source',
      'Original export must remain immutable',
    );
    const derived = pruneLegacySnapshot(snapshot, {
      sourceId: required('MERV_LEGACY_DERIVED_SOURCE_ID'),
      sourceSnapshotSha256: manifest.snapshotSha256,
    });
    planSnapshot(derived.snapshot, unavailableAudit);
    privateDirectory(destination, true);
    const audit = join(directory, 'preexisting-artifact-audit.json');
    const auditTarget = join(destination, 'preexisting-artifact-audit.json');
    if (existsSync(audit)) {
      if (existsSync(auditTarget))
        check(
          readPrivate(audit).equals(readPrivate(auditTarget)),
          'legacy_prune_audit',
          'Derived audit differs',
        );
      else copyFileSync(audit, auditTarget, constants.COPYFILE_EXCL);
    }
    const reportSha256 = writePrivate(join(destination, 'prune-report.json'), derived.report);
    const snapshotSha256 = writePrivate(join(destination, 'snapshot.json'), derived.snapshot);
    const manifestSha256 = writePrivate(join(destination, 'manifest.json'), {
      ...manifest,
      sourceId: derived.snapshot.foundation.sourceId,
      ...derived.snapshot.metadata,
      sourceCounts: derived.snapshot.sourceCounts,
      snapshotSha256,
      pruneReportSha256: reportSha256,
      kind: 'derived',
    });
    console.log(JSON.stringify({ manifestSha256 }));
    return;
  }
  if (command === 'plan') {
    const manifestSha256 = writePrivate(
      join(directory, unavailableAudit ? 'retention-plan.json' : 'plan.json'),
      {
        snapshotSha256: manifest.snapshotSha256,
        ...summary(snapshot, plan),
      },
    );
    console.log(JSON.stringify({ manifestSha256 }));
    return;
  }
  const result = await withTarget(async (state, blobs, target) => {
    let foundation, history, prepared;
    if (command === 'import') {
      const source = new S3Blobs({
        bucket: required('MERV_LEGACY_BLOB_BUCKET'),
        endpoint: required('MERV_LEGACY_BLOB_ENDPOINT_URL'),
        accessKeyId: required('MERV_LEGACY_BLOB_ACCESS_KEY_ID'),
        secretAccessKey: required('MERV_LEGACY_BLOB_SECRET_ACCESS_KEY'),
        region: process.env.MERV_LEGACY_BLOB_REGION || 'auto',
        prefix: process.env.MERV_LEGACY_BLOB_PREFIX || '',
      });
      try {
        prepared = await prepareMedia(
          snapshot,
          (project, hash, size) =>
            blobs.copyVerifiedFrom(source, project, hash, size, { timeoutMs: 900000 }),
          (progress) => console.log(JSON.stringify(progress)),
          unavailableAudit,
        );
        preparedMedia(directory, snapshot, manifest, target, unavailableAudit, prepared);
        const verified = new Map(
          prepared.manifest.verifiedObjects.map((row) => [`${row.namespace}/${row.hash}`, row]),
        );
        foundation = await importLegacyFoundation(
          {
            state,
            sourceBlobs: source,
            destinationBlobs: blobs,
            copyArtifact: async (project, hash, size) => {
              const receipt = verified.get(`${project}/${hash}`);
              check(
                receipt?.size === size,
                'legacy_media_receipt',
                'Artifact lacks its verified byte receipt',
              );
              return receipt;
            },
          },
          prepared.foundation,
        );
      } finally {
        await source.close();
      }
      history = await importLegacyHistory(state, snapshot.history, {
        artifactRetention: prepared.manifest.artifactRetention,
      });
    } else {
      prepared = preparedMedia(directory, snapshot, manifest, target, unavailableAudit);
    }
    const preparedPlan = planLegacyFoundation(prepared.foundation);
    const reconciliation = await reconcile(
      state,
      snapshot,
      { ...plan, foundation: preparedPlan },
      prepared.manifest.artifactRetention,
    );
    return {
      snapshotSha256: manifest.snapshotSha256,
      target,
      ...summary(snapshot, plan),
      preparedFoundationFingerprint: preparedPlan.fingerprint,
      preparedNativeCounts: {
        projects: preparedPlan.projects,
        memberships: preparedPlan.memberships,
        artifacts: preparedPlan.artifacts,
        claims: preparedPlan.claims,
      },
      mediaManifestFingerprint: prepared.manifest.fingerprint,
      derivedMediaArtifacts: prepared.manifest.derivedArtifacts,
      verifiedMediaObjects: prepared.manifest.verifiedObjects.length,
      objectCoverage:
        'verified retained artifacts, figures and feed media: exact bytes and native file bindings reconciled; documented metadata-only legacy lineage remains in history',
      excludedObjectBytes:
        'sandbox storage-ledger objects are retained as historical metadata only',
      ...(foundation ? { foundationReceipt: foundation, historyReceipt: history } : {}),
      reconciliation,
      publicCutover: false,
    };
  });
  const manifestSha256 = writePrivate(
    join(directory, `${command}-${result.target.schema}.json`),
    result,
  );
  console.log(JSON.stringify({ manifestSha256 }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const code =
      typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(error.code)
        ? error.code
        : 'legacy_command_failed';
    console.error(JSON.stringify({ error: code }));
    process.exitCode = 1;
  });
}
