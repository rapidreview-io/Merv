import { createHash } from 'node:crypto';
import { canonical, check } from '@merv/contracts';
import { legacyHistoryTables, planLegacyHistory } from '../dist/src/legacy-history.js';

// These are the schema-81 workflow definitions, not a guess based on parent status.
const terminal = {
  experiment: { complete: 'completed', abandoned: 'abandoned', failed: 'failed' },
  task: { done: 'completed', failed: 'failed' },
  reflection: { published: 'published', abandoned: 'abandoned' },
  reflection_lens: { submitted: 'submitted' },
  review: { submitted: 'submitted', superseded: 'superseded' },
  research_wave: { completed: 'completed', needs_replanning: 'needs_replanning' },
  project_synthesis: {},
};
const pending = {
  experiment: ['planned', 'design_review', 'running', 'experiment_review'],
  task: ['in_progress', 'in_review'],
  reflection: [
    'reflecting',
    'synthesizing',
    'reflection_review',
    'consolidating',
    'consolidation_review',
  ],
  reflection_lens: ['reflecting'],
  review: ['requested', 'started'],
  research_wave: ['working'],
  project_synthesis: ['waiting', 'writing'],
};
const domainKinds = {
  experiments: 'experiment',
  tasks: 'task',
  reflections: 'reflection',
  review_requests: 'review',
};
const sha = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const key = (table, row) => canonical(legacyHistoryTables[table].keys.map((field) => row[field]));
const entity = (project, id) => `${project}\0${id}`;

/** Pure offline derivation. Never writes the legacy DB or deletes object-store bytes. */
export function pruneLegacySnapshot(input, { sourceId, sourceSnapshotSha256 }) {
  check(
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(sourceId) && sourceId !== input.foundation.sourceId,
    'legacy_prune_source',
    'A distinct valid derived source ID is required',
  );
  check(
    /^[a-f0-9]{64}$/.test(sourceSnapshotSha256),
    'legacy_prune_source',
    'Source snapshot hash is required',
  );
  planLegacyHistory(input.history);
  check(
    !input.metadata.derivation,
    'legacy_prune_source',
    'Derive from the original export, not another derivation',
  );
  const snapshot = structuredClone(input);
  const tables = snapshot.history.tables;
  // Schema-81 primary IDs are global within each table. Refuse a projection
  // that violates that assumption before following parent IDs without a project column.
  for (const rows of Object.values(tables)) {
    const ids = rows.filter((row) => row.id).map((row) => row.id);
    check(new Set(ids).size === ids.length, 'legacy_prune_identity', 'Ambiguous source primary ID');
  }
  const removed = Object.fromEntries(Object.keys(tables).map((name) => [name, new Map()]));
  const protectedRows = new Set();
  const removedEntities = new Set();
  const removedIds = Object.fromEntries(Object.keys(tables).map((name) => [name, new Set()]));
  const detachments = [];
  const isRemoved = (table, id) => removedIds[table].has(id);
  const removedRef = (row, id) =>
    typeof id === 'string' && removedEntities.has(entity(row.project_id, id));
  function drop(table, row, reason) {
    const id = key(table, row);
    if (removed[table].has(id)) return false;
    check(
      !protectedRows.has(`${table}:${id}`),
      'legacy_prune_finished',
      'Refusing to remove finished independent work',
    );
    removed[table].set(id, { row, reason });
    const entityId = row.id ?? row.object_id;
    if (entityId) removedIds[table].add(entityId);
    if (row.project_id && typeof entityId === 'string')
      removedEntities.add(entity(row.project_id, entityId));
    return true;
  }
  function finished(kind, state) {
    check(
      Object.hasOwn(terminal, kind) &&
        (Object.hasOwn(terminal[kind], state) || pending[kind].includes(state)),
      'legacy_prune_state',
      'Unknown workflow kind or state; review the removal policy',
    );
    return Object.hasOwn(terminal[kind], state);
  }
  for (const [table, kind] of Object.entries(domainKinds)) {
    for (const row of tables[table]) {
      if (!finished(kind, row.status)) drop(table, row, 'unfinished-domain-work');
      else if (table !== 'review_requests') protectedRows.add(`${table}:${key(table, row)}`);
    }
  }
  for (const row of tables.workflow_instances) {
    const done = finished(row.workflow, row.state);
    check(
      done ? row.outcome === terminal[row.workflow][row.state] : !row.outcome,
      'legacy_prune_state',
      'Workflow state and outcome disagree',
    );
    if (!done) drop('workflow_instances', row, 'unfinished-workflow');
    else if (['experiment', 'task', 'reflection', 'research_wave'].includes(row.workflow))
      protectedRows.add(`workflow_instances:${key('workflow_instances', row)}`);
  }
  // Completed uploads are independent evidence and can be shared by many work items.
  // Keep all completed files; remove incomplete upload metadata only. Never delete bytes.
  for (const table of ['artifacts', 'artifact_figures'])
    for (const row of tables[table])
      if (row.status !== 'complete') drop(table, row, 'incomplete-upload');
      else protectedRows.add(`${table}:${key(table, row)}`);

  let changed;
  do {
    changed = false;
    for (const [table, rows] of Object.entries(tables))
      for (const row of rows) {
        if (removed[table].has(key(table, row))) continue;
        const parent = legacyHistoryTables[table].parents.find(
          ([field, target]) => row[field] && isRemoved(target, row[field]),
        );
        let reason = parent ? `removed-parent:${parent[0]}` : undefined;
        // Domain and workflow rows representing the same work must agree about removal.
        if (Object.hasOwn(domainKinds, table) || table === 'workflow_instances') {
          if (removedRef(row, row.id)) reason = 'removed-work-identity';
        }
        for (const field of [
          'target_id',
          'target_snapshot_id',
          'lens_id',
          'submission_id',
          'artifact_id',
          'source_experiment_id',
          'source_ref',
          'producing_experiment_id',
        ])
          if (removedRef(row, row[field])) reason = `removed-reference:${field}`;
        if (
          table === 'node_dependencies' &&
          (removedRef(row, row.node_id) || removedRef(row, row.depends_on_id))
        )
          reason = 'removed-dependency-endpoint';
        if (table === 'agent_workspaces' && removedRef(row, row.instance_id))
          reason = 'removed-workspace-owner';
        if (
          table === 'workflow_instances' &&
          ['review', 'reflection_lens'].includes(row.workflow) &&
          removedRef(row, row.parent_id)
        )
          reason = 'removed-dependent-workflow-parent';
        if (table === 'posts' && removedRef(row, row.ref)) reason = 'removed-post-subject';
        if (reason) changed = drop(table, row, reason) || changed;
      }
  } while (changed);

  // Completed children survive an unfinished parent. Structured links are detached;
  // ordinary prose is retained verbatim, even if it mentions an old identifier.
  const referenceField = (field) =>
    /^(?:id|ref|subject|target|parent|children|dependencies|depends_on)$|_(?:id|ids|ref|refs)$/.test(
      field,
    );
  function cleanJson(value, row, field = '') {
    if (referenceField(field) && removedRef(row, value)) return undefined;
    if (Array.isArray(value))
      return value.map((item) => cleanJson(item, row, field)).filter((item) => item !== undefined);
    if (value && typeof value === 'object') {
      if (
        ['id', 'ref', 'target_id', 'experiment_id', 'task_id', 'reflection_id'].some((field) =>
          removedRef(row, value[field]),
        )
      )
        return undefined;
      return Object.fromEntries(
        Object.entries(value)
          .filter(([name]) => !removedRef(row, name))
          .flatMap(([name, item]) => {
            const clean = cleanJson(item, row, name);
            return clean === undefined ? [] : [[name, clean]];
          }),
      );
    }
    return value;
  }
  for (const [table, rows] of Object.entries(tables)) {
    tables[table] = rows
      .filter((row) => !removed[table].has(key(table, row)))
      .map((row) => {
        const before = sha(row);
        const fields = [];
        const detach = (field, value = null) => {
          row[field] = value;
          fields.push(field);
        };
        if (table === 'workflow_instances' && removedRef(row, row.parent_id)) {
          detach('parent_id');
          detach('parent_revision');
          detach('child_key');
        }
        if (table === 'posts')
          for (const field of ['in_reply_to', 'quote_of', 'thread_root'])
            if (removedRef(row, row[field])) detach(field);
        if (
          table === 'projects' &&
          removedEntities.has(entity(row.id, row.hard_stop_reflection_id))
        )
          detach('hard_stop_reflection_id');
        if (
          table === 'consolidation_decisions' &&
          isRemoved('consolidation_proposals', row.superseded_by)
        )
          detach('superseded_by');
        // Event pointers are audit links, not ownership; a retained completed history entry stays.
        if (
          ['workflow_history', 'workflow_actions'].includes(table) &&
          isRemoved('events', row.event_id)
        )
          detach('event_id');
        for (const field of Object.keys(row).filter((name) => name.endsWith('_json'))) {
          const clean = cleanJson(row[field], row, field) ?? null;
          if (canonical(clean) !== canonical(row[field])) detach(field, clean);
        }
        if (fields.length)
          detachments.push({
            table,
            key: key(table, row),
            fields,
            beforeSha256: before,
            afterSha256: sha(row),
          });
        return row;
      });
  }
  const retainedIds = new Set(tables.artifacts.map((row) => row.id));
  snapshot.foundation.artifacts = snapshot.foundation.artifacts.filter((row) =>
    retainedIds.has(row.id),
  );
  snapshot.foundation.sourceId = sourceId;
  snapshot.history.sourceId = sourceId;
  const counts = Object.fromEntries(
    Object.entries(input.history.tables).map(([table, rows]) => [
      table,
      {
        original: rows.length,
        removed: removed[table].size,
        retained: tables[table].length,
      },
    ]),
  );
  for (const [table, value] of Object.entries(counts)) {
    check(
      value.original === value.removed + value.retained,
      'legacy_prune_count',
      'Removal counts do not reconcile',
    );
    snapshot.sourceCounts[table] = value.retained;
  }
  planLegacyHistory(snapshot.history);
  for (const [table, rows] of Object.entries(tables))
    for (const row of rows) {
      for (const field of [
        'target_id',
        'target_snapshot_id',
        'lens_id',
        'submission_id',
        'artifact_id',
        'source_experiment_id',
        'source_ref',
        'producing_experiment_id',
        'node_id',
        'depends_on_id',
        'parent_id',
        'ref',
        'in_reply_to',
        'quote_of',
        'thread_root',
        'instance_id',
        'proposal_id',
        'reflection_id',
        'link_id',
        'superseded_by',
        'event_id',
      ])
        check(
          !removedRef(row, row[field]),
          'legacy_prune_reference',
          `Retained ${table} points at removed work`,
        );
      for (const [field, target] of legacyHistoryTables[table].parents)
        check(
          !isRemoved(target, row[field]),
          'legacy_prune_reference',
          'Retained parent points at removed record',
        );
      if (table === 'projects')
        check(
          !removedEntities.has(entity(row.id, row.hard_stop_reflection_id)),
          'legacy_prune_reference',
          'Retained project points at removed reflection',
        );
      if (table === 'consolidation_decisions')
        check(
          !isRemoved('consolidation_proposals', row.superseded_by),
          'legacy_prune_reference',
          'Retained decision points at removed proposal',
        );
      if (['workflow_history', 'workflow_actions'].includes(table))
        check(
          !isRemoved('events', row.event_id),
          'legacy_prune_reference',
          'Retained history points at removed event',
        );
      for (const field of Object.keys(row).filter((name) => name.endsWith('_json')))
        check(
          canonical(cleanJson(row[field], row, field) ?? null) === canonical(row[field]),
          'legacy_prune_reference',
          'Retained JSON contains a removed structural reference',
        );
    }
  check(
    tables.workflow_instances.every((row) => row.outcome),
    'legacy_prune_unfinished',
    'Unfinished workflow remains',
  );
  const report = {
    policy: 'schema81-remove-unfinished-v1',
    sourceId,
    originalSourceId: input.foundation.sourceId,
    sourceSnapshotSha256,
    counts,
    removed: Object.fromEntries(
      Object.entries(removed).map(([table, values]) => [
        table,
        [...values.entries()].map(([key, value]) => ({ key, reason: value.reason })),
      ]),
    ),
    detachments,
    deletedObjectBytes: 0,
    completedUploads: 'retained independently, including shared evidence',
    dependentHistory:
      'Reviews, lens submissions and audit records about removed work are removed with their subject; completed experiments, tasks and reflections remain independent.',
    discussion:
      'Posts whose direct subject is removed are removed; other posts survive with reply and quote links detached.',
    sourceDatabaseChanged: false,
    prose: 'retained verbatim',
  };
  snapshot.metadata.derivation = {
    policy: report.policy,
    originalSourceId: report.originalSourceId,
    sourceSnapshotSha256,
    reportSha256: createHash('sha256')
      .update(canonical(report) + '\n')
      .digest('hex'),
  };
  return { snapshot, report };
}
