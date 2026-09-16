import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  captureSnapshot,
  importTarget,
  mediaInventory,
  planSnapshot,
  prepareMedia,
  targetIdentity,
  writePrivate,
  reconcile,
} from './legacy-rehearsal.mjs';
import { legacyHistoryTables, importLegacyHistory } from '../dist/src/legacy-history.js';
import { importLegacyFoundation, planLegacyFoundation } from '../dist/src/legacy-import.js';
import { legacyUnavailableArtifacts } from '../dist/src/legacy-media.js';
import { createApp } from '../dist/src/app.js';
import { deploymentSchema } from './schema.mjs';

const created = '2026-09-16T12:00:00.000Z';
const hash = createHash('sha256').update('body').digest('hex');
function row(type, values) {
  return {
    ...Object.fromEntries(
      legacyHistoryTables[type].columns.map((name) => [name, name.endsWith('_json') ? {} : null]),
    ),
    ...values,
  };
}
function fixture() {
  const tables = Object.fromEntries(Object.keys(legacyHistoryTables).map((name) => [name, []]));
  tables.projects.push(
    row('projects', {
      id: 'project_original',
      name: 'Original',
      summary: 'Retained summary',
      status: 'active',
      created_at: created,
    }),
  );
  tables.artifacts.push(
    row('artifacts', {
      id: 'artifact_original',
      project_id: 'project_original',
      title: 'Evidence',
      path: 'report.md',
      created_by: 'original-author',
      created_at: created,
      status: 'complete',
      content_type: 'text/markdown',
      content_sha256: hash,
      size_bytes: 4,
    }),
  );
  tables.workflow_instances.push(
    row('workflow_instances', {
      id: 'work_original',
      project_id: 'project_original',
      workflow: 'experiment',
      version: 1,
      state: 'running',
      outcome: '',
      data_json: JSON.stringify({ useful: 'retained', access_token: 'never-export-this' }),
    }),
  );
  const memberships = [{ project_id: 'project_original', user_id: 'same-user', added_at: created }];
  const counts = Object.fromEntries(
    Object.entries(tables).map(([name, rows]) => [name, rows.length]),
  );
  counts.project_members = memberships.length;
  counts.api_tokens = 3;
  const queries = [];
  const client = {
    query: async (sql) => {
      queries.push(sql);
      if (sql.startsWith('BEGIN') || ['COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
      if (sql.startsWith('SELECT transaction_timestamp'))
        return {
          rows: [
            {
              captured_at: new Date(created),
              snapshot_id: '100:100:',
              read_only: 'on',
              server_version: '17',
              schema_version: 81,
            },
          ],
        };
      if (sql.includes('pg_catalog.pg_tables'))
        return {
          rows: Object.keys(counts)
            .sort()
            .map((tablename) => ({ tablename })),
        };
      if (sql.startsWith('SELECT count(*)'))
        return { rows: [{ count: counts[sql.match(/public\."([a-z_]+)"/)[1]] }] };
      if (sql.includes('FROM public.project_members'))
        return { rows: structuredClone(memberships) };
      const name = sql.match(/FROM public\."([a-z_]+)"/)?.[1];
      assert.ok(name && Object.hasOwn(legacyHistoryTables, name));
      return { rows: structuredClone(tables[name]) };
    },
  };
  return { tables, counts, queries, client };
}

test('deployment schemas and import prefixes cannot select legacy or existing staging storage', () => {
  assert.equal(deploymentSchema(), 'merv_ts');
  assert.equal(deploymentSchema('merv_ts_rehearsal_20260916'), 'merv_ts_rehearsal_20260916');
  for (const schema of [
    'public',
    'pg_catalog',
    'merv_ts; DROP SCHEMA public',
    'merv_ts_' + 'a'.repeat(64),
  ])
    assert.throws(() => deploymentSchema(schema));
  assert.throws(() => importTarget('merv_ts', 'merv-ts', 'legacy'), {
    code: 'legacy_target_schema',
  });
  assert.throws(() => importTarget('merv_ts_rehearsal', 'legacy', 'legacy'), {
    code: 'legacy_target_prefix',
  });
  assert.deepEqual(importTarget('merv_ts_rehearsal', 'merv-ts/merv_ts_rehearsal', 'legacy'), {
    schema: 'merv_ts_rehearsal',
    prefix: 'merv-ts/merv_ts_rehearsal',
  });
});

test('one read-only snapshot captures independent counts, exact projections and no credential rows', async () => {
  const f = fixture();
  const snapshot = await captureSnapshot(
    f.client,
    'test-source',
    'https://identity.example/auth/v1',
  );
  assert.equal(f.queries[0], 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(f.queries.at(-1), 'COMMIT');
  assert.equal(
    f.queries.some((sql) => /SELECT \*/.test(sql)),
    false,
  );
  assert.equal(f.queries.filter((sql) => sql.includes('public."api_tokens"')).length, 1);
  assert.equal(snapshot.sourceCounts.api_tokens, 3);
  assert.equal(JSON.stringify(snapshot).includes('never-export-this'), false);
  const plan = planSnapshot(snapshot);
  assert.equal(plan.foundation.memberships, 1);
  assert.equal(plan.history.counts.workflow_instances, 1);
  assert.deepEqual(plan.nonResumableWork, [
    {
      projectId: 'project_original',
      id: 'work_original',
      workflow: 'experiment',
      version: 1,
      state: 'running',
    },
  ]);
  const changed = structuredClone(snapshot);
  changed.foundation.projects[0].summary = 'Different snapshot';
  assert.throws(() => planSnapshot(changed), { code: 'legacy_export_mismatch' });
  const wrongTime = structuredClone(snapshot);
  wrongTime.metadata.capturedAt = '2026-09-15T12:00:00.000Z';
  assert.throws(() => planSnapshot(wrongTime), { code: 'legacy_export_mismatch' });
});

test('count mismatch aborts the source transaction instead of publishing a partial capture', async () => {
  const f = fixture();
  f.counts.artifacts++;
  await assert.rejects(
    captureSnapshot(f.client, 'test-source', 'https://identity.example/auth/v1'),
    { code: 'legacy_export_count' },
  );
  assert.equal(f.queries.at(-1), 'ROLLBACK');
  assert.equal(f.queries.includes('COMMIT'), false);
});

test('media inventory deduplicates exact namespaces, retains figure provenance and marks unknown post sizes', async () => {
  const f = fixture();
  f.tables.artifact_figures.push(
    row('artifact_figures', {
      id: 'figure_original',
      artifact_id: 'artifact_original',
      status: 'complete',
      content_sha256: hash,
      size_bytes: 4,
      link_path: 'figure.png',
    }),
  );
  f.tables.posts.push(
    row('posts', {
      id: 'post_original',
      project_id: 'project_original',
      author_handle: 'original-author',
      created_at: created,
      image_sha256: hash,
      image_content_type: 'image/png',
      embed_sha256: 'b'.repeat(64),
      embed_content_type: 'text/html',
      link_preview_json: JSON.stringify({
        image_sha256: 'c'.repeat(64),
        image_content_type: 'image/jpeg',
      }),
    }),
  );
  f.counts.artifact_figures = 1;
  f.counts.posts = 1;
  const snapshot = await captureSnapshot(
    f.client,
    'test-source',
    'https://identity.example/auth/v1',
  );
  const media = mediaInventory(snapshot.history);
  assert.equal(media.distinctObjects, 3);
  assert.equal(media.missingSizesRequiringHead, 2);
  assert.equal(media.objects.find((object) => object.hash === hash).references.length, 3);
  assert.equal(
    media.objects
      .find((object) => object.hash === hash)
      .references.find((reference) => reference.kind === 'figures').parentArtifactId,
    'artifact_original',
  );
  assert.equal(media.files.length, 4);
  assert.equal(
    media.files.find((file) => file.slot === 'embed').mediaType,
    'application/octet-stream',
  );
  const copied = [];
  const prepared = await prepareMedia(snapshot, async (namespace, hash, size) => {
    copied.push({ namespace, hash, size });
    return { hash, size: size ?? 9 };
  });
  assert.equal(copied.length, 3);
  assert.equal(copied.filter((object) => object.size === undefined).length, 2);
  assert.equal(prepared.manifest.originalArtifacts, 1);
  assert.equal(prepared.manifest.derivedArtifacts, 4);
  assert.equal(prepared.foundation.artifacts.length, 5);
  assert.equal(snapshot.foundation.artifacts.length, 1);
  await assert.rejects(
    prepareMedia(snapshot, async () => ({ hash: '0'.repeat(64), size: 4 })),
    { code: 'legacy_blob_mismatch' },
  );
  snapshot.history.tables.artifact_figures[0].size_bytes = 5;
  assert.throws(() => mediaInventory(snapshot.history), { code: 'legacy_media_size' });
});

test('prepared target identity binds storage and database without retaining credentials', () => {
  const target = targetIdentity(
    'merv_ts_rehearsal',
    'merv-ts/merv_ts_rehearsal',
    'legacy',
    'postgresql://app:secret@db:5432/research?sslmode=require',
    'https://storage.example/',
    'bucket',
  );
  assert.deepEqual(target.database, { host: 'db', port: '5432', name: 'research' });
  assert.deepEqual(target.storage, {
    endpoint: 'https://storage.example',
    bucket: 'bucket',
    region: 'auto',
    prefix: 'merv-ts/merv_ts_rehearsal',
  });
  assert.equal(JSON.stringify(target).includes('secret'), false);
  const other = targetIdentity(
    'merv_ts_rehearsal',
    'merv-ts/merv_ts_rehearsal',
    'legacy',
    'postgresql://app:secret@db/research',
    'https://storage.example/',
    'other',
  );
  assert.notDeepEqual(target, other);
});

test('private reports publish atomically and replay only exact bytes without overwriting targets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-report-'));
  try {
    const path = join(directory, 'receipt.json');
    const first = writePrivate(path, { complete: true, count: 2 });
    assert.equal(writePrivate(path, { count: 2, complete: true }), first);
    assert.equal(statSync(path).mode & 0o077, 0);
    assert.deepEqual(JSON.parse(readFileSync(path)), { complete: true, count: 2 });
    assert.throws(() => writePrivate(path, { complete: false }), {
      code: 'legacy_report_conflict',
    });
    assert.deepEqual(readdirSync(directory), ['receipt.json']);
    const linked = join(directory, 'linked.json');
    symlinkSync(path, linked);
    assert.throws(() => writePrivate(linked, { complete: true, count: 2 }));
    assert.equal(JSON.parse(readFileSync(path)).count, 2);
    assert.deepEqual(readdirSync(directory).sort(), ['linked.json', 'receipt.json']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reconciliation proves native files and every unchanged archived row plus availability envelope', async () => {
  const f = fixture();
  const missing = {
    ...f.tables.artifacts[0],
    id: 'metadata_only',
    content_sha256: 'd'.repeat(64),
    size_bytes: 42,
  };
  f.tables.artifacts.push(missing);
  f.counts.artifacts++;
  const snapshot = await captureSnapshot(
    f.client,
    'test-source',
    'https://identity.example/auth/v1',
  );
  const auditBytes = Buffer.from(
    JSON.stringify({
      references: [
        {
          kind: 'artifact',
          id: missing.id,
          project_id: missing.project_id,
          sha256: missing.content_sha256,
          size_bytes: missing.size_bytes,
          covered: false,
        },
      ],
    }),
  );
  const audit = legacyUnavailableArtifacts(
    auditBytes,
    createHash('sha256').update(auditBytes).digest('hex'),
  );
  const plan = planSnapshot(snapshot, audit);
  const copied = [];
  const prepared = await prepareMedia(
    snapshot,
    async (namespace, hash, size) => {
      copied.push({ namespace, hash, size });
      return { hash, size };
    },
    () => {},
    audit,
  );
  assert.equal(copied.length, 1);
  assert.equal(plan.foundation.artifacts, 2);
  assert.equal(prepared.foundation.artifacts.length, 1);
  const directory = mkdtempSync(join(tmpdir(), 'merv-retention-reconcile-'));
  const app = await createApp({
    directory,
    config: {
      plugins: [
        { id: 'state', name: '@merv/state', config: { path: join(directory, 'state.sqlite') } },
        { id: 'scope', name: '@merv/scope' },
        { id: 'blobs', name: '@merv/blobs', config: { root: join(directory, 'blobs') } },
        { id: 'artifacts', name: '@merv/artifacts' },
        { id: 'claims', name: '@merv/claims' },
      ],
    },
  });
  try {
    await importLegacyFoundation(
      {
        state: app.ctx.state,
        sourceBlobs: { get: async () => Buffer.from('body') },
        destinationBlobs: app.ctx.blobs,
      },
      prepared.foundation,
    );
    await importLegacyHistory(app.ctx.state, snapshot.history, {
      artifactRetention: prepared.manifest.artifactRetention,
    });
    const importedPlan = { ...plan, foundation: planLegacyFoundation(prepared.foundation) };
    const result = await reconcile(
      app.ctx.state,
      snapshot,
      importedPlan,
      prepared.manifest.artifactRetention,
    );
    assert.equal(result.nativeRowsAndHashes, 'matched');
    assert.equal(result.historyRowsAndHashes, 'matched');
    assert.equal(result.artifactAvailabilityAndReceipt, 'matched');
    const altered = structuredClone(prepared.manifest.artifactRetention);
    altered.artifacts = altered.artifacts.map((row) =>
      row.id === missing.id
        ? {
            projectId: row.projectId,
            id: row.id,
            hash: row.hash,
            size: row.size,
            status: 'verified',
            artifactId: row.id,
          }
        : row,
    );
    await assert.rejects(reconcile(app.ctx.state, snapshot, importedPlan, altered), {
      code: 'legacy_reconciliation',
    });
  } finally {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('bounded media copy drains in-flight work before rejecting and never prepares partial receipts', async () => {
  const f = fixture();
  f.tables.posts.push(
    row('posts', {
      id: 'post_copy',
      project_id: 'project_original',
      author_handle: 'original',
      created_at: created,
      image_sha256: 'b'.repeat(64),
      embed_sha256: 'c'.repeat(64),
      link_preview_json: {},
    }),
  );
  f.counts.posts = 1;
  const snapshot = await captureSnapshot(
    f.client,
    'test-source',
    'https://identity.example/auth/v1',
  );
  const pending = [];
  let active = 0,
    maxActive = 0,
    finished = false;
  const result = prepareMedia(snapshot, async (namespace, hash, size) => {
    active++;
    maxActive = Math.max(maxActive, active);
    if (hash === 'b'.repeat(64)) {
      active--;
      throw new Error('Expected copy failure');
    }
    return await new Promise((resolve) =>
      pending.push(() => {
        active--;
        resolve({ hash, size: size ?? 4 });
      }),
    );
  });
  result.catch(() => {
    finished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false, 'A failed copy must wait for other in-flight copies');
  assert.equal(pending.length, 2);
  assert.ok(maxActive <= 4);
  for (const finish of pending) finish();
  await assert.rejects(result, /Expected copy failure/);
  assert.equal(active, 0);
});
