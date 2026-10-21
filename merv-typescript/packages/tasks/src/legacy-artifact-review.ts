import {
  canonical,
  check,
  digest,
  type Sql,
  type WorkflowDefinition,
  type WorkflowExecutionPolicy,
} from '@merv/contracts';
import { validateDefinition } from '@merv/workflows/definition';
import { executionFingerprint, validateExecution } from '@merv/workflows/execution-policy';
import { grant, reference, reviewGrants, target } from '@merv/workflows/rules';

/** The published artifact-only contract. Only existing pending reviews may resume it. */
export const ARTIFACT_TASK_WORKFLOW: WorkflowDefinition = {
  name: 'task',
  version: 2,
  managed: true,
  initial: 'in_progress',
  states: ['done', 'failed', 'in_progress', 'in_review'],
  terminal: ['done', 'failed'],
  edges: [
    { from: 'in_progress', action: 'mark_failed', to: 'failed' },
    { from: 'in_progress', action: 'submit_delivery', to: 'in_review' },
    { from: 'in_review', action: 'accept', to: 'done' },
    { from: 'in_review', action: 'fail_review', to: 'failed' },
    { from: 'in_review', action: 'mark_failed', to: 'failed' },
    { from: 'in_review', action: 'reissue_review', to: 'in_review' },
    { from: 'in_review', action: 'revise', to: 'in_progress' },
  ],
};

export const artifactReview = (version: number) => version === 2;

/** Keep both historical manifests byte-equivalent; the producer admission remains closed. */
export function artifactTaskExecution(purpose: 'work' | 'review'): WorkflowExecutionPolicy {
  const task = { taskId: target('instanceId') };
  const revision = { expectedRevision: target('revision') };
  const assignment = {
    ...task,
    ...revision,
    purpose: { kind: 'literal' as const, value: purpose },
    ...(purpose === 'review' ? { claimId: reference('claimId') } : {}),
  };
  return {
    readOnly: purpose === 'review',
    tools: [
      grant(
        'workflow.status_and_next',
        { instanceId: target('instanceId') },
        {
          instanceId: { kind: 'oneOf', name: 'dependencies' },
        },
      ),
      grant('workflow.assignment', { instanceId: target('instanceId') }),
      grant('task.get', task),
      grant('task.context', assignment),
      grant('task.checkpoint', {
        ...assignment,
        artifactIds: { kind: 'subset', name: 'artifacts' },
      }),
      grant('artifact.get', { artifactId: { kind: 'oneOf', name: 'artifacts' } }),
      grant('artifact.read', { artifactId: { kind: 'oneOf', name: 'artifacts' } }),
      grant('review.get', { reviewId: reference('reviewId') }),
      ...(purpose === 'work'
        ? [
            grant('artifact.create', {}),
            grant('task.submit_delivery', { taskId: reference('producerTaskId'), ...revision }),
            grant('task.mark_failed', { ...task, ...revision }),
          ]
        : reviewGrants().filter((tool) => tool.name !== 'review.release')),
    ],
  };
}

/** Also used by cutover: this exception cannot turn a legacy Git delivery into artifacts. */
export async function legacyArtifactReviewEligible(
  sql: Sql,
  projectId: string,
  instanceId: string,
): Promise<boolean> {
  // Preflight runs before application registration. It must establish the same exact pinned
  // contract here instead of relying on Tasks.initialize to reject a different historical v2.
  const contracts = await sql.all<{
    definition_json: string;
    fingerprint: string;
    success_json: string;
    state: string;
    manifest_json: string;
    execution_hash: string;
  }>(`SELECT d.definition_json,d.fingerprint,s.success_json,e.state,e.manifest_json,e.fingerprint AS execution_hash
    FROM wf_definitions d JOIN wf_success_states s ON s.workflow=d.name AND s.version=d.version
    JOIN wf_execution_policies e ON e.workflow=d.name AND e.version=d.version
    WHERE d.name='task' AND d.version=2`);
  if (contracts.length !== 2) return false;
  const definition = validateDefinition(ARTIFACT_TASK_WORKFLOW);
  try {
    if (
      !contracts.every((row) => {
        if (!['in_progress', 'in_review'].includes(row.state)) return false;
        const execution = validateExecution(
          artifactTaskExecution(row.state === 'in_review' ? 'review' : 'work'),
        );
        return (
          row.fingerprint === digest(definition) &&
          canonical(JSON.parse(row.definition_json)) === canonical(definition) &&
          canonical(JSON.parse(row.success_json)) === canonical(['done']) &&
          row.execution_hash === executionFingerprint(execution) &&
          canonical(JSON.parse(row.manifest_json)) === canonical(execution)
        );
      })
    )
      return false;
  } catch {
    return false;
  }
  const row = await sql.get<{
    data_json: string;
    brief_id: string;
    delivery_ids: string;
    artifact_ids: string;
  }>(
    `SELECT i.data_json,t.brief_id,t.delivery_ids,r.artifact_ids
    FROM wf_instances i JOIN tasks t ON t.id=i.id AND t.project_id=i.project_id
    JOIN reviews r ON r.id=t.review_id AND r.project_id=i.project_id AND r.subject_id=i.id
    WHERE i.project_id=? AND i.id=? AND i.workflow='task' AND i.version=2 AND i.state='in_review'
      AND t.evidence_version=2 AND r.format_version=2 AND r.subject_revision=i.revision
      AND r.status IN ('requested','started') AND r.provenance_json IS NULL
      AND NOT EXISTS(SELECT 1 FROM code_workspaces w WHERE w.project_id=i.project_id AND w.unit_id=i.id)
      AND NOT EXISTS(SELECT 1 FROM code_units u WHERE u.project_id=i.project_id AND u.unit_id=i.id
        AND (u.base_json IS NOT NULL OR u.acceptance_json IS NOT NULL))
      AND NOT EXISTS(SELECT 1 FROM wf_leases l WHERE l.project_id=i.project_id AND l.instance_id=i.id
        AND l.released_at IS NULL AND l.state<>'in_review')`,
    projectId,
    instanceId,
  );
  if (!row) return false;
  const data = JSON.parse(row.data_json);
  const delivery = JSON.parse(row.delivery_ids) as string[];
  const artifacts = JSON.parse(row.artifact_ids) as string[];
  return (
    data.deliveryCode == null &&
    data.deliveryCodeArtifactId == null &&
    data.workspace == null &&
    delivery.length > 0 &&
    artifacts.includes(row.brief_id) &&
    delivery.every((id) => artifacts.includes(id))
  );
}

export async function requireArtifactReview(
  sql: Sql,
  projectId: string,
  instanceId: string,
): Promise<void> {
  check(
    await legacyArtifactReviewEligible(sql, projectId, instanceId),
    'legacy_artifact_review_unavailable',
    'Only an existing artifact-only task review with its original evidence can resume this contract',
    409,
  );
}
