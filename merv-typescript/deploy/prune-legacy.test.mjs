import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { legacyHistoryTables } from '../dist/src/legacy-history.js';
import { pruneLegacySnapshot } from './prune-legacy.mjs';
import { planSnapshot } from './legacy-rehearsal.mjs';

const at = '2026-09-16T12:00:00.000Z';
const hash = createHash('sha256').update('body').digest('hex');
const row = (table, fields) => ({
  ...Object.fromEntries(
    legacyHistoryTables[table].columns.map((name) => [name, name.endsWith('_json') ? {} : null]),
  ),
  ...fields,
});
function fixture() {
  const tables = Object.fromEntries(Object.keys(legacyHistoryTables).map((name) => [name, []]));
  const add = (table, fields) => {
    const item = row(table, { project_id: 'p', ...fields });
    if (!legacyHistoryTables[table].columns.includes('project_id')) delete item.project_id;
    tables[table].push(item);
    return item;
  };
  add('projects', {
    id: 'p',
    name: 'Research',
    summary: 'Retained',
    status: 'active',
    created_at: at,
  });
  add('experiments', {
    id: 'exp_done',
    status: 'complete',
    name: 'Completed child',
    conclusion: 'keep exp_pending verbatim',
  });
  add('experiments', { id: 'exp_pending', status: 'running', name: 'Unfinished' });
  add('tasks', {
    id: 'task_done',
    status: 'done',
    name: 'Finished task',
    outcome: 'This is prose, not a workflow outcome.',
  });
  add('reflections', { id: 'reflection_done', status: 'published', published_at: at });
  add('reflections', { id: 'reflection_pending', status: 'consolidating' });
  add('review_requests', {
    id: 'review_pending',
    status: 'started',
    target_type: 'experiment',
    target_id: 'exp_done',
  });
  add('review_requests', {
    id: 'review_old',
    status: 'submitted',
    target_type: 'experiment',
    target_id: 'exp_pending',
  });
  add('workflow_instances', {
    id: 'wave_pending',
    workflow: 'research_wave',
    state: 'working',
    outcome: '',
  });
  add('workflow_instances', {
    id: 'exp_done',
    workflow: 'experiment',
    state: 'complete',
    outcome: 'completed',
    parent_id: 'wave_pending',
    child_key: 'experiment:done',
    parent_revision: 1,
    data_json: { parent_id: 'wave_pending', note: 'The wave_pending name is retained in prose.' },
  });
  add('workflow_instances', {
    id: 'exp_pending',
    workflow: 'experiment',
    state: 'running',
    outcome: '',
  });
  add('workflow_history', {
    id: 'history_done',
    instance_id: 'exp_done',
    after_json: { parent_id: 'wave_pending', state: 'complete' },
  });
  add('workflow_history', { id: 'history_pending', instance_id: 'exp_pending' });
  add('node_dependencies', { node_id: 'exp_done', depends_on_id: 'exp_pending' });
  add('node_dependencies', { node_id: 'exp_pending', depends_on_id: 'task_done' });
  add('consolidation_proposals', { id: 'proposal_pending', reflection_id: 'reflection_pending' });
  add('workspace_advances', {
    id: 'advance_pending',
    instance_id: 'reflection_pending',
    proposal_id: 'proposal_pending',
  });
  add('submissions', {
    id: 'submission_pending',
    target_id: 'exp_pending',
    target_type: 'experiment',
  });
  const artifact = add('artifacts', {
    id: 'artifact_shared',
    title: 'Shared evidence',
    path: 'report.md',
    created_by: 'old-author',
    created_at: at,
    status: 'complete',
    content_type: 'text/markdown',
    content_sha256: hash,
    size_bytes: 4,
  });
  add('artifacts', { id: 'artifact_upload', status: 'pending' });
  add('research_artifact_links', {
    id: 'link_pending',
    target_type: 'experiment',
    target_id: 'exp_pending',
    artifact_id: artifact.id,
    submission_id: 'submission_pending',
  });
  add('research_artifact_links', {
    id: 'link_done',
    target_type: 'experiment',
    target_id: 'exp_done',
    artifact_id: artifact.id,
  });
  add('research_submission_artifacts', {
    submission_id: 'submission_pending',
    link_id: 'link_pending',
  });
  add('posts', { id: 'post_pending', ref: 'exp_pending', text: 'Unfinished progress' });
  add('posts', {
    id: 'post_done',
    text: 'The exp_pending idea remains a textual mention.',
    attachments_json: [{ ref: 'exp_pending' }, { ref: 'exp_done' }],
  });
  const pick = (record, fields) => Object.fromEntries(fields.map((name) => [name, record[name]]));
  const foundation = {
    sourceId: 'original',
    schemaVersion: 81,
    issuer: 'https://identity.example/auth/v1',
    projects: tables.projects.map((item) =>
      pick(item, ['id', 'name', 'summary', 'created_at', 'status']),
    ),
    memberships: [{ project_id: 'p', user_id: 'user', added_at: at }],
    artifacts: [
      pick(artifact, [
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
    ],
    claims: [],
  };
  return {
    format: 'merv-legacy-export-v1',
    metadata: { capturedAt: at },
    sourceCounts: {
      ...Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, rows.length])),
      project_members: 1,
    },
    foundation,
    history: {
      sourceId: 'original',
      schemaVersion: 81,
      projectionVersion: 2,
      capturedAt: at,
      consistency: 'postgres-repeatable-read-read-only',
      projectIds: ['p'],
      tables,
    },
  };
}
const derive = (input) =>
  pruneLegacySnapshot(input, { sourceId: 'finished-only', sourceSnapshotSha256: hash });

test('removes unfinished domain work without a workflow, preserves completed children and shared evidence', () => {
  const source = fixture();
  const before = structuredClone(source);
  const { snapshot, report } = derive(source);
  assert.deepEqual(source, before);
  const t = snapshot.history.tables;
  assert.deepEqual(
    t.experiments.map((item) => item.id),
    ['exp_done'],
  );
  assert.deepEqual(t.tasks, source.history.tables.tasks);
  assert.deepEqual(
    t.reflections.map((item) => item.id),
    ['reflection_done'],
  );
  assert.equal(t.review_requests.length, 0);
  assert.equal(t.workflow_instances.length, 1);
  assert.equal(t.workflow_instances[0].parent_id, null);
  assert.equal(t.workflow_instances[0].child_key, null);
  assert.equal(t.workflow_instances[0].data_json.parent_id, undefined);
  assert.equal(t.workflow_history.length, 1);
  assert.equal(t.node_dependencies.length, 0);
  assert.equal(t.workspace_advances.length, 0);
  assert.equal(t.research_submission_artifacts.length, 0);
  assert.equal(t.research_artifact_links[0].id, 'link_done');
  assert.equal(t.artifacts.length, 1);
  assert.deepEqual(snapshot.foundation.artifacts, source.foundation.artifacts);
  assert.equal(t.posts[0].id, 'post_done');
  assert.equal(t.posts[0].text, source.history.tables.posts[1].text);
  assert.deepEqual(t.posts[0].attachments_json, [{ ref: 'exp_done' }]);
  assert.equal(report.deletedObjectBytes, 0);
  assert.ok(report.detachments.length >= 2);
  for (const count of Object.values(report.counts))
    assert.equal(count.original, count.removed + count.retained);
  assert.equal(planSnapshot(snapshot).nonResumableWork.length, 0);
  assert.deepEqual(derive(source), { snapshot, report });
});

test('unknown states and contradictory finished domain/workflow records fail closed', () => {
  for (const change of [
    (s) => {
      s.history.tables.experiments[0].status = 'mystery';
    },
    (s) => {
      s.history.tables.workflow_instances[0].workflow = 'unknown';
    },
    (s) => {
      s.history.tables.workflow_instances[1].outcome = '';
    },
    (s) => {
      s.history.tables.workflow_instances[1].state = 'running';
      s.history.tables.workflow_instances[1].outcome = '';
    },
  ]) {
    const source = fixture();
    change(source);
    assert.throws(() => derive(source));
  }
});

test('failed and abandoned work remain history; parent removal never deletes completed work', () => {
  const source = fixture();
  source.history.tables.experiments[0].status = 'abandoned';
  Object.assign(source.history.tables.workflow_instances[1], {
    state: 'abandoned',
    outcome: 'abandoned',
  });
  const { snapshot } = derive(source);
  assert.equal(snapshot.history.tables.experiments[0].status, 'abandoned');
  assert.equal(snapshot.history.tables.workflow_instances[0].parent_id, null);
});

test('original source identity cannot be reused or derived twice', () => {
  const source = fixture();
  assert.throws(() =>
    pruneLegacySnapshot(source, { sourceId: 'original', sourceSnapshotSha256: hash }),
  );
  assert.throws(() =>
    pruneLegacySnapshot(derive(source).snapshot, { sourceId: 'again', sourceSnapshotSha256: hash }),
  );
});

test('a completed-result reply survives removal of a progress post and JSON prose remains literal', () => {
  const source = fixture();
  source.history.tables.posts[1].in_reply_to = 'post_pending';
  source.history.tables.posts[1].thread_root = 'post_pending';
  source.history.tables.workflow_instances[1].data_json.note = 'exp_pending';
  const { snapshot } = derive(source);
  assert.equal(snapshot.history.tables.posts[0].in_reply_to, null);
  assert.equal(snapshot.history.tables.posts[0].thread_root, null);
  assert.equal(snapshot.history.tables.workflow_instances[0].data_json.note, 'exp_pending');
});

test('complete figures cannot be lost through an incomplete parent upload', () => {
  const source = fixture();
  source.history.tables.artifact_figures.push(
    row('artifact_figures', {
      id: 'figure_complete',
      artifact_id: 'artifact_upload',
      status: 'complete',
      content_sha256: hash,
      size_bytes: 4,
    }),
  );
  assert.throws(() => derive(source), { code: 'legacy_prune_finished' });
});

test('numeric audit event pointers are detached without removing a completed history entry', () => {
  const source = fixture();
  source.history.tables.events.push(
    row('events', { id: 42, project_id: 'p', target_id: 'exp_pending', target_type: 'experiment' }),
  );
  source.history.tables.workflow_history[0].event_id = 42;
  const { snapshot } = derive(source);
  assert.equal(snapshot.history.tables.events.length, 0);
  assert.equal(snapshot.history.tables.workflow_history.length, 1);
  assert.equal(snapshot.history.tables.workflow_history[0].event_id, null);
});

test('unfinished lens links are removed even when the reflection itself is retained', () => {
  const source = fixture();
  source.history.tables.workflow_instances.push(
    row('workflow_instances', {
      id: 'lens_pending',
      project_id: 'p',
      workflow: 'reflection_lens',
      state: 'reflecting',
      outcome: '',
      parent_id: 'reflection_done',
    }),
  );
  source.history.tables.research_artifact_links.push(
    row('research_artifact_links', {
      id: 'lens_link',
      project_id: 'p',
      target_id: 'reflection_done',
      target_type: 'reflection',
      artifact_id: 'artifact_shared',
      lens_id: 'lens_pending',
    }),
  );
  const { snapshot } = derive(source);
  assert.ok(
    !snapshot.history.tables.research_artifact_links.some((item) => item.id === 'lens_link'),
  );
  assert.equal(snapshot.history.tables.reflections[0].id, 'reflection_done');
});
