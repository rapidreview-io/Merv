import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { canonical, digest, type Caller } from '@merv/contracts';
import { createApp } from './fixtures/app.js';
import {
  LegacyHistoryReader,
  legacyHistoryTypes,
  type LegacyHistoryType,
} from '../src/legacy-history.js';
import { seedLegacyHistory, type ArchivedFixtureRecord } from './fixtures/legacy-history.js';
import { stateConfig } from './fixtures/state.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'merv-legacy-history-'));
  const app = await createApp({
    directory,
    config: {
      plugins: [
        { id: 'state', name: '@merv/state', config: stateConfig(directory) },
        { id: 'scope', name: '@merv/scope' },
      ],
    },
  });
  t.after(async () => {
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const first = await app.ctx.scope.bootstrap({
    projectName: 'History A',
    actorName: 'Bootstrap A',
  });
  const second = await app.ctx.scope.bootstrap({
    projectName: 'History B',
    actorName: 'Bootstrap B',
  });
  const principal = await app.ctx.scope.acceptVerifiedIdentity({
    issuer: 'https://history.example/auth/v1',
    subject: 'member',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  await app.ctx.scope.adoptProject(principal, first.project.id);
  await app.ctx.scope.adoptProject(principal, second.project.id);
  const caller = await app.ctx.scope.caller(principal, first.project.id);
  const other = await app.ctx.scope.caller(principal, second.project.id);
  const records: ArchivedFixtureRecord[] = [
    {
      projectId: caller.projectId,
      type: 'reflections',
      id: 'reflection-original',
      data: {
        id: 'reflection-original',
        status: 'published',
        published_graph_version_id: 'graph-original',
        roster_json: [{ id: 'lens-original', title: 'Skeptic' }],
        corpus_json: { experiments: [{ id: 'experiment-original', attempt_index: 2 }] },
      },
    },
    {
      projectId: caller.projectId,
      type: 'reviews',
      id: 'review-original',
      data: {
        id: 'review-original',
        session_id: 'reviewer-original',
        submission_id: 'submission-original',
        verdict: 'pass',
        findings_json: [{ conclusion: 'Evidence accepted' }],
      },
    },
    {
      projectId: caller.projectId,
      type: 'events',
      id: '42',
      data: {
        id: 42,
        type: 'reflection.published',
        target_id: 'reflection-original',
        payload_json: { graph_version_id: 'graph-original' },
      },
    },
    ...[1, 2].map((attempt) => ({
      projectId: caller.projectId,
      type: 'workflow_history' as const,
      id: `history-${attempt}`,
      data: {
        id: `history-${attempt}`,
        instance_id: 'workflow-original',
        revision: attempt,
        after_json: { state: attempt === 1 ? 'running' : 'done', data: { attempt_index: attempt } },
        action: 'complete_attempt',
      },
    })),
    {
      projectId: caller.projectId,
      type: 'artifacts',
      id: 'artifact-original',
      data: {
        id: 'artifact-original',
        title: 'Lens evidence',
        content_sha256: 'a'.repeat(64),
        status: 'complete',
      },
    },
    {
      projectId: other.projectId,
      type: 'experiments',
      id: 'experiment-other',
      data: {
        id: 'experiment-other',
        name: 'Private B',
        status: 'running',
        attempt_index: 1,
      },
    },
  ];
  return {
    app,
    records,
    caller,
    other,
    reader: new LegacyHistoryReader(app.ctx.state, app.ctx.scope),
    machine: {
      actorId: first.actor.id,
      projectId: first.project.id,
      credentialId: first.credential.id,
    } satisfies Caller,
  };
}

test('populated immutable history preserves original records, hashes, evidence and publication without re-import', async (t) => {
  const { app, records, caller, other, reader } = await fixture(t);
  const receipt = await seedLegacyHistory(app.ctx.state, records);
  const { sourceId } = receipt;
  for (const record of records) {
    const owner = record.projectId === caller.projectId ? caller : other;
    const detail = await reader.detail(owner, { sourceId, type: record.type, id: record.id });
    assert.equal(
      canonical(detail.data),
      canonical(record.data),
      'opaque stored data is returned verbatim',
    );
    assert.equal(detail.hash, digest(record.data));
    assert.equal(detail.historical, true);
  }
  assert.equal(
    (await reader.detail(caller, { sourceId, type: 'reflections', id: 'reflection-original' })).data
      .published_graph_version_id,
    'graph-original',
  );
  assert.deepEqual(
    (await reader.detail(caller, { sourceId, type: 'artifacts', id: 'artifact-original' }))
      .fileRetention,
    { status: 'unverified' },
  );
  const summary = await reader.summary(caller, { sourceId });
  assert.equal(summary.fingerprint, receipt.fingerprint);
  assert.equal(summary.counts.workflow_history, 2);
  assert.equal(summary.counts.experiments, 0);
  assert.equal('projectCounts' in summary, false);
  assert.equal(summary.retention.nativeWorkflowContinuation, 'not-imported');
  assert.equal((await reader.summary(other, { sourceId })).counts.workflow_history, 0);
  const page = await reader.list(caller, { sourceId, type: 'workflow_history', limit: 1 });
  assert.equal(page.records.length, 1);
  assert.equal('data' in page.records[0], false);
  const next = await reader.list(caller, {
    sourceId,
    type: 'workflow_history',
    limit: 1,
    after: page.next,
  });
  assert.notEqual(page.records[0].id, next.records[0].id);
  assert.equal(next.next, undefined);
  await assert.rejects(
    reader.detail(other, { sourceId, type: 'workflow_history', id: 'history-1' }),
    { code: 'legacy_history_not_found' },
  );
  for (const table of ['legacy_history_imports', 'legacy_history_records'])
    for (const verb of ['UPDATE', 'DELETE'])
      await assert.rejects(
        app.ctx.state.transaction((tx) =>
          tx.run(
            verb === 'UPDATE' ? `UPDATE ${table} SET source_id=source_id` : `DELETE FROM ${table}`,
          ),
        ),
        { code: 'state_constraint' },
      );
});

test('every retained type stays readable while credentials and live-only types stay outside the reader allowlist', async (t) => {
  const { app, caller, reader } = await fixture(t);
  const records = legacyHistoryTypes.map((type) => ({
    projectId: caller.projectId,
    type,
    id: `stored-${type}`,
    data: {
      original_field: type,
      nested: { content_digest: 'historical-digest', token_count: 1200 },
    },
  }));
  const { sourceId } = await seedLegacyHistory(app.ctx.state, records);
  for (const record of records)
    assert.deepEqual(
      (await reader.detail(caller, { sourceId, type: record.type, id: record.id })).data,
      record.data,
    );
  for (const type of ['actors', 'project_api_keys', 'tool_calls'])
    await assert.rejects(reader.list(caller, { sourceId, type: type as LegacyHistoryType }), {
      code: 'invalid_legacy_history_query',
    });
});

test('every project reader reads the archive and each read rechecks authority before returning', async (t) => {
  const { app, records, reader, caller, machine } = await fixture(t);
  const { sourceId } = await seedLegacyHistory(app.ctx.state, records);
  assert.equal((await reader.list(machine, { sourceId, type: 'reviews' })).records.length, 1);
  for (const action of ['summary', 'list', 'detail'] as const) {
    let checks = 0;
    const revoking = new LegacyHistoryReader(app.ctx.state, {
      require: async (...args) => {
        if (++checks === 2)
          throw Object.assign(new Error('Membership removed during read'), {
            code: 'membership_required',
          });
        return app.ctx.scope.require(...args);
      },
    });
    const read =
      action === 'summary'
        ? revoking.summary(caller, { sourceId })
        : action === 'list'
          ? revoking.list(caller, { sourceId, type: 'reviews' })
          : revoking.detail(caller, { sourceId, type: 'reviews', id: 'review-original' });
    await assert.rejects(read, { code: 'membership_required' });
    assert.equal(checks, 2);
  }
});

test('large historical payloads remain stored while list stays bounded and detail refuses explicitly', async (t) => {
  const { app, records, reader, caller } = await fixture(t);
  records.find((r) => r.id === 'history-1')!.data.after_json = {
    retained: 'x'.repeat(4 * 1024 * 1024),
  };
  const { sourceId } = await seedLegacyHistory(app.ctx.state, records);
  assert.ok(
    JSON.stringify(await reader.list(caller, { sourceId, type: 'workflow_history' })).length < 2000,
  );
  await assert.rejects(
    reader.detail(caller, { sourceId, type: 'workflow_history', id: 'history-1' }),
    { code: 'legacy_history_detail_too_large' },
  );
  const stored = await app.ctx.state.read((sql) =>
    sql.get<{ detail_bytes: number }>(
      'SELECT detail_bytes FROM legacy_history_records WHERE source_key=?',
      'history-1',
    ),
  );
  assert.ok(stored!.detail_bytes > 4 * 1024 * 1024);
});

test('retained artifact availability is opaque, immutable and project-scoped', async (t) => {
  const { app, records, caller, other, reader } = await fixture(t);
  const auditSha256 = 'e'.repeat(64);
  records.find((r) => r.id === 'artifact-original')!.fileRetention = {
    status: 'verified',
    artifactId: 'artifact-original',
  };
  records.push(
    {
      projectId: caller.projectId,
      type: 'artifacts',
      id: 'lineage-original',
      data: { id: 'lineage-original', size_bytes: 5 },
      fileRetention: {
        status: 'metadata-only',
        reason: 'legacy-lineage-without-retained-bytes',
        auditSha256,
      },
    },
    {
      projectId: caller.projectId,
      type: 'artifacts',
      id: 'pending-file',
      data: { id: 'pending-file', status: 'pending' },
    },
    {
      projectId: other.projectId,
      type: 'artifacts',
      id: 'foreign-file',
      data: { id: 'foreign-file' },
      fileRetention: { status: 'verified', artifactId: 'foreign-file' },
    },
    {
      projectId: caller.projectId,
      type: 'tasks',
      id: 'lineage-original',
      data: { id: 'lineage-original', goal: 'Unrelated task' },
    },
  );
  const receipt = await seedLegacyHistory(app.ctx.state, records, {
    artifactRetention: {
      fingerprint: 'f'.repeat(64),
      auditSha256,
      counts: { verified: 2, metadataOnly: 1, unverified: 1 },
      projectCounts: {
        [caller.projectId]: { verified: 1, metadataOnly: 1, unverified: 1 },
        [other.projectId]: { verified: 1, metadataOnly: 0, unverified: 0 },
      },
    },
  });
  const { sourceId } = receipt;
  for (const record of records.filter(
    (r) => r.type === 'artifacts' && r.projectId === caller.projectId,
  )) {
    const detail = await reader.detail(caller, { sourceId, type: record.type, id: record.id });
    assert.deepEqual(detail.fileRetention, record.fileRetention ?? { status: 'unverified' });
    assert.deepEqual(detail.data, record.data);
    assert.equal(detail.hash, digest(record.data));
  }
  const page = await reader.list(caller, { sourceId, type: 'artifacts' });
  assert.equal(
    page.records.some((r) => r.id === 'foreign-file'),
    false,
  );
  assert.deepEqual(page.records.find((r) => r.id === 'pending-file')!.fileRetention, {
    status: 'unverified',
  });
  assert.equal(
    (await reader.detail(caller, { sourceId, type: 'tasks', id: 'lineage-original' }))
      .fileRetention,
    undefined,
  );
  assert.deepEqual((await reader.summary(caller, { sourceId })).artifactRetention, {
    fingerprint: receipt.artifactRetention!.fingerprint,
    auditSha256,
    counts: { verified: 1, metadataOnly: 1, unverified: 1 },
  });
  assert.deepEqual((await reader.summary(other, { sourceId })).artifactRetention!.counts, {
    verified: 1,
    metadataOnly: 0,
    unverified: 0,
  });
  await assert.rejects(
    reader.detail(other, { sourceId, type: 'artifacts', id: 'lineage-original' }),
    { code: 'legacy_history_not_found' },
  );
});
