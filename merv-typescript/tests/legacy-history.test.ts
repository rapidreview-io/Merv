import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Pool } from 'pg';
import { digest, type Caller, type Data, type State } from '@merv/contracts';
import { createApp } from '../src/app.js';
import {
  importLegacyHistory,
  initializeLegacyHistory,
  LegacyHistoryReader,
  legacyHistoryExportSpec,
  legacyHistoryTables,
  planLegacyHistory,
  projectLegacyHistoryRow,
  type LegacyHistoryArtifactRetention,
  type LegacyHistoryType,
} from '../src/legacy-history.js';
import { emptyLegacyHistorySnapshot, legacyHistoryRow } from './fixtures/legacy-history.js';

async function fixture(t: TestContext, postgres = false) {
  const directory = await mkdtemp(join(tmpdir(), 'merv-legacy-history-'));
  const schema = `history_${randomUUID().replaceAll('-', '')}`;
  const env = `MERV_HISTORY_${randomUUID().replaceAll('-', '').toUpperCase()}`;
  if (postgres) process.env[env] = process.env.MERV_TEST_POSTGRES_URL;
  const app = await createApp({
    directory,
    config: {
      plugins: [
        {
          id: 'state',
          name: '@merv/state',
          config: postgres
            ? { backend: 'postgres', connectionStringEnv: env, schema }
            : { path: join(directory, 'state.sqlite') },
        },
        { id: 'scope', name: '@merv/scope' },
      ],
    },
  });
  t.after(async () => {
    await app.stop();
    if (postgres) {
      const pool = new Pool({ connectionString: process.env.MERV_TEST_POSTGRES_URL });
      try {
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await pool.end();
      }
    }
    delete process.env[env];
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
  const snapshot = emptyLegacyHistorySnapshot([first.project.id, second.project.id]);
  for (const project of [first.project, second.project])
    snapshot.tables.projects.push(
      legacyHistoryRow('projects', {
        id: project.id,
        name: project.name,
        summary: 'Original summary',
        status: 'active',
        created_at: project.createdAt,
      }),
    );
  const add = (type: LegacyHistoryType, row: Data) =>
    snapshot.tables[type].push(legacyHistoryRow(type, row));
  const p = { project_id: first.project.id };
  add('experiments', {
    ...p,
    id: 'experiment-original',
    name: 'Two attempts',
    status: 'done',
    attempt_index: 2,
  });
  add('experiments', {
    project_id: second.project.id,
    id: 'experiment-other',
    name: 'Private B',
    status: 'running',
    attempt_index: 1,
  });
  add('tasks', { ...p, id: 'task-original', goal: 'Original task', status: 'in_progress' });
  add('claims', { ...p, id: 'claim-original', statement: 'An original claim' });
  add('experiment_claims', { experiment_id: 'experiment-original', claim_id: 'claim-original' });
  add('reflections', {
    ...p,
    id: 'reflection-original',
    status: 'published',
    published_graph_version_id: 'graph-original',
    roster_json: [{ id: 'lens-original', title: 'Skeptic' }],
    corpus_json: { experiments: [{ id: 'experiment-original', attempt_index: 2 }] },
  });
  add('reflection_experiments', {
    reflection_id: 'reflection-original',
    experiment_id: 'experiment-original',
  });
  add('reflection_tasks', { reflection_id: 'reflection-original', task_id: 'task-original' });
  add('reflection_claim_changes', {
    reflection_id: 'reflection-original',
    claim_id: 'claim-original',
    op: 'update',
  });
  add('artifacts', {
    ...p,
    id: 'artifact-original',
    title: 'Lens evidence',
    content_sha256: 'a'.repeat(64),
    status: 'complete',
  });
  add('artifact_figures', {
    id: 'figure-original',
    artifact_id: 'artifact-original',
    link_path: 'figure.png',
    content_sha256: 'b'.repeat(64),
    status: 'complete',
  });
  add('submissions', {
    ...p,
    id: 'submission-original',
    target_id: 'reflection-original',
    target_type: 'reflection',
    attempt_index: 1,
  });
  add('research_artifact_links', {
    ...p,
    id: 'link-original',
    artifact_id: 'artifact-original',
    target_type: 'reflection',
    target_id: 'reflection-original',
    lens_id: 'lens-original',
    role: 'lens',
    attempt_index: 1,
    submission_id: 'submission-original',
  });
  add('research_submission_artifacts', {
    submission_id: 'submission-original',
    link_id: 'link-original',
  });
  add('review_requests', {
    ...p,
    id: 'request-original',
    target_id: 'reflection-original',
    target_type: 'reflection',
    status: 'done',
  });
  add('review_sessions', {
    id: 'reviewer-original',
    request_id: 'request-original',
    independence: 'independent',
    declared_agent: 'original-context-window',
  });
  add('reviews', {
    ...p,
    id: 'review-original',
    request_id: 'request-original',
    session_id: 'reviewer-original',
    verdict: 'pass',
    submission_id: 'submission-original',
    findings_json: [{ conclusion: 'Evidence accepted' }],
  });
  add('consolidation_proposals', {
    ...p,
    id: 'proposal-original',
    reflection_id: 'reflection-original',
    proposal_sha: 'original-sha',
    revision: 1,
  });
  add('consolidation_decisions', {
    proposal_id: 'proposal-original',
    experiment_id: 'experiment-original',
    disposition: 'adapted',
    rationale: 'Preserved rationale',
  });
  add('workflow_instances', {
    ...p,
    id: 'workflow-original',
    workflow: 'experiment',
    state: 'done',
    version: 2,
    revision: 4,
    data_json: { attempt_index: 2 },
  });
  for (const attempt of [1, 2])
    add('workflow_history', {
      ...p,
      id: `history-${attempt}`,
      instance_id: 'workflow-original',
      revision: attempt,
      after_json: { state: attempt === 1 ? 'running' : 'done', data: { attempt_index: attempt } },
      action: 'complete_attempt',
    });
  add('workspace_advances', {
    id: 'advance-original',
    instance_id: 'reflection-original',
    proposal_id: 'proposal-original',
    target_sha: 'original-sha',
    status: 'bound',
    ancestry_json: [{ retained: true }],
  });
  add('research_objects', {
    ...p,
    object_id: 'object-original',
    target_id: 'experiment-original',
    content_sha256: 'c'.repeat(64),
    status: 'complete',
  });
  add('events', {
    ...p,
    id: 42,
    type: 'reflection.published',
    target_id: 'reflection-original',
    payload_json: { graph_version_id: 'graph-original' },
  });
  const reader = new LegacyHistoryReader(app.ctx.state, app.ctx.scope);
  return {
    app,
    snapshot,
    add,
    caller,
    other,
    reader,
    principal,
    machine: {
      actorId: first.actor.id,
      projectId: first.project.id,
      credentialId: first.credential.id,
    } satisfies Caller,
  };
}

for (const postgres of [false, true])
  test(
    `immutable research history preserves IDs, attempts, evidence and publication on ${postgres ? 'PostgreSQL' : 'SQLite'}`,
    { skip: postgres && !process.env.MERV_TEST_POSTGRES_URL },
    async (t) => {
      const { app, snapshot, caller, other, reader } = await fixture(t, postgres);
      const receipt = await importLegacyHistory(app.ctx.state, snapshot);
      assert.equal(receipt.counts.workflow_history, 2);
      assert.equal(receipt.retention.objectBytes, 'not-verified-by-history-import');
      assert.equal(receipt.retention.nativeWorkflowContinuation, 'not-imported');
      assert.deepEqual(
        (
          await reader.detail(caller, {
            sourceId: snapshot.sourceId,
            type: 'artifacts',
            id: 'artifact-original',
          })
        ).fileRetention,
        { status: 'unverified' },
      );
      const reordered = structuredClone(snapshot);
      reordered.projectIds.reverse();
      for (const rows of Object.values(reordered.tables)) rows.reverse();
      assert.deepEqual(await importLegacyHistory(app.ctx.state, reordered), receipt);
      const details = await reader.detail(caller, {
        sourceId: snapshot.sourceId,
        type: 'workflow_history',
        id: 'history-1',
      });
      assert.deepEqual(details.data.after_json, { state: 'running', data: { attempt_index: 1 } });
      assert.equal(details.hash, digest(details.data));
      assert.equal(
        (
          await reader.detail(caller, {
            sourceId: snapshot.sourceId,
            type: 'reviews',
            id: 'review-original',
          })
        ).data.session_id,
        'reviewer-original',
      );
      assert.equal(
        (
          await reader.detail(caller, {
            sourceId: snapshot.sourceId,
            type: 'reflections',
            id: 'reflection-original',
          })
        ).data.published_graph_version_id,
        'graph-original',
      );
      const summaries = await reader.summary(caller, { sourceId: snapshot.sourceId });
      assert.equal(summaries.counts.experiments, 1);
      assert.equal('projectCounts' in summaries, false);
      assert.equal(
        (await reader.summary(other, { sourceId: snapshot.sourceId })).counts.workflow_history,
        0,
      );
      const page = await reader.list(caller, {
        sourceId: snapshot.sourceId,
        type: 'workflow_history',
        limit: 1,
      });
      assert.equal(page.records.length, 1);
      assert.equal('data' in page.records[0], false);
      const next = await reader.list(caller, {
        sourceId: snapshot.sourceId,
        type: 'workflow_history',
        limit: 1,
        after: page.next,
      });
      assert.notEqual(page.records[0].id, next.records[0].id);
      assert.equal(next.next, undefined);
      await assert.rejects(
        reader.detail(other, {
          sourceId: snapshot.sourceId,
          type: 'workflow_history',
          id: 'history-1',
        }),
        { code: 'legacy_history_not_found' },
      );
      for (const table of ['legacy_history_imports', 'legacy_history_records'])
        for (const verb of ['UPDATE', 'DELETE'])
          await assert.rejects(
            app.ctx.state.transaction((tx) =>
              tx.run(
                verb === 'UPDATE'
                  ? `UPDATE ${table} SET source_id=source_id`
                  : `DELETE FROM ${table}`,
              ),
            ),
            postgres ? { code: 'state_constraint' } : /immutable|retained/i,
          );
      const changed = structuredClone(snapshot);
      changed.tables.tasks[0].goal = 'Different history';
      await assert.rejects(importLegacyHistory(app.ctx.state, changed), {
        code: 'legacy_history_conflict',
      });
    },
  );

test('export allowlist excludes capabilities, credentials and tool payloads; JSON projection hashes only retained content', async (t) => {
  const { snapshot } = await fixture(t);
  assert.ok(legacyHistoryExportSpec.excludedTables.includes('tool_calls'));
  assert.ok(
    !legacyHistoryTables.review_requests.columns.some((column) => column.includes('capability')),
  );
  const raw = {
    ...snapshot.tables.workflow_history[0],
    command_fingerprint: 'sensitive digest',
    after_json: JSON.stringify({
      state: 'done',
      reviewerCapability: 'sensitive bearer',
      nested: { authorization: 'secret', findings: ['kept'] },
    }),
  };
  const projected = projectLegacyHistoryRow('workflow_history', raw);
  assert.deepEqual(projected.after_json, { state: 'done', nested: { findings: ['kept'] } });
  assert.equal('command_fingerprint' in projected, false);
  snapshot.tables.workflow_history[0] = projected;
  assert.equal(planLegacyHistory(snapshot).counts.workflow_history, 2);
  snapshot.tables.review_requests[0].capability_hash = 'must not import';
  assert.throws(() => planLegacyHistory(snapshot), { code: 'invalid_legacy_history' });
  delete snapshot.tables.review_requests[0].capability_hash;
  delete (snapshot.tables as Partial<typeof snapshot.tables>).reviews;
  assert.throws(() => planLegacyHistory(snapshot), { code: 'invalid_legacy_history' });
});

test('child ownership rejects missing and cross-project parents before any import', async (t) => {
  const { app, snapshot } = await fixture(t);
  const missing = structuredClone(snapshot);
  missing.tables.review_sessions[0].request_id = 'missing';
  await assert.rejects(importLegacyHistory(app.ctx.state, missing), {
    code: 'invalid_legacy_history',
  });
  const crossed = structuredClone(snapshot);
  crossed.tables.experiment_claims[0].experiment_id = 'experiment-other';
  await assert.rejects(importLegacyHistory(app.ctx.state, crossed), {
    code: 'legacy_history_cross_project',
  });
  const noProject = structuredClone(snapshot);
  noProject.projectIds.push('not-imported');
  noProject.tables.projects.push(legacyHistoryRow('projects', { id: 'not-imported' }));
  await assert.rejects(importLegacyHistory(app.ctx.state, noProject), {
    code: 'legacy_history_project_missing',
  });
  assert.equal(
    await app.ctx.state.read((sql) => sql.get('SELECT source_id FROM legacy_history_imports')),
    undefined,
  );
});

test('archive rows and receipt roll back together on a mid-import storage failure', async (t) => {
  const { app, snapshot } = await fixture(t);
  await initializeLegacyHistory(app.ctx.state);
  const original = app.ctx.state.transaction.bind(app.ctx.state);
  let rows = 0;
  const mocked = t.mock.method(
    app.ctx.state,
    'transaction',
    async (fn: Parameters<State['transaction']>[0]) =>
      original((tx) =>
        fn({
          ...tx,
          run: async (sql, ...params) => {
            if (sql.startsWith('INSERT INTO legacy_history_records') && ++rows === 3)
              throw new Error('Synthetic record failure');
            return tx.run(sql, ...params);
          },
        }),
      ),
  );
  await assert.rejects(importLegacyHistory(app.ctx.state, snapshot), /Synthetic record failure/);
  mocked.mock.restore();
  assert.equal(
    (await app.ctx.state.read((sql) => sql.all('SELECT source_id FROM legacy_history_imports')))
      .length,
    0,
  );
  assert.equal(
    (await app.ctx.state.read((sql) => sql.all('SELECT source_key FROM legacy_history_records')))
      .length,
    0,
  );
  assert.equal((await importLegacyHistory(app.ctx.state, snapshot)).counts.reviews, 1);
});

test('only verified human members can read; expired authority is rechecked after asynchronous reads', async (t) => {
  const { app, snapshot, reader, caller, machine } = await fixture(t);
  await importLegacyHistory(app.ctx.state, snapshot);
  for (const unauthorized of [
    machine,
    { actorId: caller.actorId, projectId: caller.projectId },
    { ...caller, session: {} } as Caller,
  ])
    await assert.rejects(
      reader.list(unauthorized, { sourceId: snapshot.sourceId, type: 'experiments' }),
      { code: 'legacy_history_member_required' },
    );
  await assert.rejects(
    reader.list(caller, { sourceId: snapshot.sourceId, type: 'actors' as LegacyHistoryType }),
    { code: 'invalid_legacy_history_query' },
  );
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
  await assert.rejects(
    revoking.detail(caller, {
      sourceId: snapshot.sourceId,
      type: 'reviews',
      id: 'review-original',
    }),
    { code: 'membership_required' },
  );
  assert.equal(checks, 2);
});

test('large historical payloads remain archived but list stays small and detail fails explicitly', async (t) => {
  const { app, snapshot, reader, caller } = await fixture(t);
  snapshot.tables.workflow_history[0].after_json = { retained: 'x'.repeat(4 * 1024 * 1024) };
  await importLegacyHistory(app.ctx.state, snapshot);
  assert.ok(
    JSON.stringify(
      await reader.list(caller, { sourceId: snapshot.sourceId, type: 'workflow_history' }),
    ).length < 2000,
  );
  await assert.rejects(
    reader.detail(caller, {
      sourceId: snapshot.sourceId,
      type: 'workflow_history',
      id: 'history-1',
    }),
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

test('projection v2 preserves nested token metrics and scientific integrity references while excluding credentials', async (t) => {
  const { app, snapshot, caller, reader } = await fixture(t);
  const metrics = {
    token_count: 1200,
    max_tokens: 8192,
    tokens: 1175,
    completion_tokens: 975,
    completionTokens: 975,
    completionTokenBudget: 2048,
    token_count_digest: 'metric-digest',
    content_digest: 'content-digest',
    dataset_fingerprint: 'dataset-fingerprint',
    tokenizerFingerprint: 'tokenizer-fingerprint',
    content_sha256: 'e'.repeat(64),
    digest: 'research-integrity-digest',
    fingerprint: 'research-snapshot-fingerprint',
  };
  snapshot.tables.workflow_history[0].after_json = {
    state: 'done',
    results: [{ metrics, credentials: { token: 'synthetic-secret' } }],
    configuration: {
      precision: 'fp32',
      token: 'synthetic-secret',
      tokens: ['synthetic-secret'],
      completion_tokens: 'synthetic-secret',
      completion_token: 'synthetic-secret',
      accessToken: 'synthetic-secret',
      refresh_token_hash: 'synthetic-secret-digest',
      sessionTokenFingerprint: 'synthetic-secret-fingerprint',
      reviewer_capability: 'synthetic-secret',
      capability_hash: 'synthetic-secret-digest',
      APIAccessKeyId: 'synthetic-access-key-id',
      accesskeyid: 'synthetic-access-key-id',
      secretAccessKey: 'synthetic-secret',
      AWS_SECRET_ACCESS_KEY: 'synthetic-secret',
      privateKeyPEM: 'synthetic-private-key',
      rsa_private_key: 'synthetic-private-key',
      password: 'synthetic-secret',
      headers: { Authorization: 'Bearer synthetic-secret' },
    },
  };
  const expected = { state: 'done', results: [{ metrics }], configuration: { precision: 'fp32' } };
  const plan = planLegacyHistory(snapshot);
  const row = plan.records.find(
    (record) => record.type === 'workflow_history' && record.id === 'history-1',
  )!;
  assert.deepEqual(row.data.after_json, expected);
  assert.equal(row.hash, digest(row.data));
  const receipt = await importLegacyHistory(app.ctx.state, snapshot);
  assert.equal(receipt.projectionVersion, 2);
  assert.deepEqual(
    (
      await reader.detail(caller, {
        sourceId: snapshot.sourceId,
        type: 'workflow_history',
        id: 'history-1',
      })
    ).data.after_json,
    expected,
  );
  const changed = structuredClone(snapshot);
  const payload = changed.tables.workflow_history[0].after_json as Data;
  (payload.configuration as Data).accessToken = 'different-excluded-secret';
  assert.equal(planLegacyHistory(changed).fingerprint, plan.fingerprint);
  ((payload.results as Data[])[0].metrics as Data).token_count = 1201;
  assert.notEqual(planLegacyHistory(changed).fingerprint, plan.fingerprint);
  const { projectionVersion: _version, ...oldProjection } = snapshot;
  assert.throws(() => planLegacyHistory(oldProjection), { code: 'invalid_legacy_history' });
  assert.throws(() => planLegacyHistory({ ...snapshot, projectionVersion: 1 }), {
    code: 'invalid_legacy_history',
  });
});

for (const postgres of [false, true])
  test(
    `artifact retention is explicit, immutable and project-scoped on ${postgres ? 'PostgreSQL' : 'SQLite'}`,
    { skip: postgres && !process.env.MERV_TEST_POSTGRES_URL },
    async (t) => {
      const { app, snapshot, caller, other, reader, add } = await fixture(t, postgres);
      snapshot.tables.artifacts[0].size_bytes = 3;
      add('artifacts', {
        id: 'lineage-original',
        project_id: caller.projectId,
        status: 'complete',
        content_sha256: 'c'.repeat(64),
        size_bytes: 5,
      });
      add('artifacts', {
        id: 'foreign-file',
        project_id: other.projectId,
        status: 'complete',
        content_sha256: 'd'.repeat(64),
        size_bytes: 7,
      });
      add('artifacts', { id: 'pending-file', project_id: caller.projectId, status: 'pending' });
      // Original IDs are unique within each table, not across all research record types.
      add('tasks', {
        id: 'lineage-original',
        project_id: caller.projectId,
        goal: 'Unrelated task',
      });
      const auditSha256 = 'e'.repeat(64);
      const artifactRetention: LegacyHistoryArtifactRetention = {
        auditSha256,
        artifacts: [
          {
            projectId: caller.projectId,
            id: 'artifact-original',
            hash: 'a'.repeat(64),
            size: 3,
            status: 'verified',
            artifactId: 'artifact-original',
          },
          {
            projectId: caller.projectId,
            id: 'lineage-original',
            hash: 'c'.repeat(64),
            size: 5,
            status: 'metadata-only',
            reason: 'legacy-lineage-without-retained-bytes',
            auditSha256,
          },
          {
            projectId: other.projectId,
            id: 'foreign-file',
            hash: 'd'.repeat(64),
            size: 7,
            status: 'verified',
            artifactId: 'foreign-file',
          },
        ],
      };
      const sourcePlan = planLegacyHistory(snapshot);
      const receipt = await importLegacyHistory(app.ctx.state, snapshot, { artifactRetention });
      assert.equal(receipt.fingerprint, sourcePlan.fingerprint);
      assert.deepEqual(receipt.artifactRetention!.counts, {
        verified: 2,
        metadataOnly: 1,
        unverified: 1,
      });
      assert.equal(receipt.artifactRetention!.auditSha256, auditSha256);
      assert.deepEqual(
        await importLegacyHistory(app.ctx.state, snapshot, {
          artifactRetention: {
            ...artifactRetention,
            artifacts: [...artifactRetention.artifacts].reverse(),
          },
        }),
        receipt,
      );
      for (const entry of artifactRetention.artifacts.filter(
        (a) => a.projectId === caller.projectId,
      )) {
        const detail = await reader.detail(caller, {
          sourceId: snapshot.sourceId,
          type: 'artifacts',
          id: entry.id,
        });
        const original = sourcePlan.records.find(
          (r) => r.type === 'artifacts' && r.id === entry.id,
        )!;
        assert.deepEqual(detail.data, original.data);
        assert.equal(detail.hash, original.hash);
        assert.deepEqual(
          detail.fileRetention,
          entry.status === 'verified'
            ? { status: 'verified', artifactId: entry.id }
            : { status: 'metadata-only', reason: entry.reason, auditSha256 },
        );
      }
      const page = await reader.list(caller, { sourceId: snapshot.sourceId, type: 'artifacts' });
      assert.deepEqual(page.records.find((r) => r.id === 'pending-file')!.fileRetention, {
        status: 'unverified',
      });
      assert.equal(
        page.records.some((r) => r.id === 'foreign-file'),
        false,
      );
      assert.equal(
        (
          await reader.detail(caller, {
            sourceId: snapshot.sourceId,
            type: 'tasks',
            id: 'lineage-original',
          })
        ).fileRetention,
        undefined,
      );
      assert.deepEqual(
        (await reader.summary(caller, { sourceId: snapshot.sourceId })).artifactRetention,
        {
          fingerprint: receipt.artifactRetention!.fingerprint,
          auditSha256,
          counts: { verified: 1, metadataOnly: 1, unverified: 1 },
        },
      );
      assert.deepEqual(
        (await reader.summary(other, { sourceId: snapshot.sourceId })).artifactRetention!.counts,
        { verified: 1, metadataOnly: 0, unverified: 0 },
      );
      await assert.rejects(
        reader.detail(other, {
          sourceId: snapshot.sourceId,
          type: 'artifacts',
          id: 'lineage-original',
        }),
        { code: 'legacy_history_not_found' },
      );
      await assert.rejects(importLegacyHistory(app.ctx.state, snapshot), {
        code: 'legacy_history_conflict',
      });
      const changed = structuredClone(artifactRetention);
      changed.auditSha256 = 'f'.repeat(64);
      const lineage = changed.artifacts.find((r) => r.status === 'metadata-only')!;
      if (lineage.status === 'metadata-only') lineage.auditSha256 = changed.auditSha256;
      await assert.rejects(
        importLegacyHistory(app.ctx.state, snapshot, { artifactRetention: changed }),
        { code: 'legacy_history_conflict' },
      );
    },
  );

test('retention rejects incomplete or substituted source identities and unsupported missing-byte claims before writes', async (t) => {
  const { app, snapshot, caller, other } = await fixture(t);
  snapshot.tables.artifacts[0].size_bytes = 3;
  const entry = {
    projectId: caller.projectId,
    id: 'artifact-original',
    hash: 'a'.repeat(64),
    size: 3,
    status: 'verified' as const,
    artifactId: 'artifact-original',
  };
  const invalid: unknown[] = [
    { artifacts: [] },
    { artifacts: [entry, entry] },
    { artifacts: [{ ...entry, projectId: other.projectId }] },
    { artifacts: [{ ...entry, hash: 'b'.repeat(64) }] },
    { artifacts: [{ ...entry, size: 4 }] },
    { artifacts: [{ ...entry, artifactId: 'different-native-file' }] },
    {
      auditSha256: 'e'.repeat(64),
      artifacts: [
        {
          projectId: entry.projectId,
          id: entry.id,
          hash: entry.hash,
          size: entry.size,
          status: 'metadata-only',
          reason: '404',
          auditSha256: 'e'.repeat(64),
        },
      ],
    },
    {
      auditSha256: 'e'.repeat(64),
      artifacts: [
        {
          projectId: entry.projectId,
          id: entry.id,
          hash: entry.hash,
          size: entry.size,
          status: 'metadata-only',
          reason: 'legacy-lineage-without-retained-bytes',
          auditSha256: 'f'.repeat(64),
        },
      ],
    },
  ];
  for (const value of invalid)
    await assert.rejects(
      importLegacyHistory(app.ctx.state, snapshot, {
        artifactRetention: value as LegacyHistoryArtifactRetention,
      }),
      { code: 'invalid_legacy_retention' },
    );
  await initializeLegacyHistory(app.ctx.state);
  assert.deepEqual(
    await app.ctx.state.read((sql) => sql.all('SELECT source_id FROM legacy_history_imports')),
    [],
  );
});
