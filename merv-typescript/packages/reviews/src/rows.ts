import type { ReviewRequest } from '@merv/contracts';

export function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export interface ReviewRow {
  id: string;
  project_id: string;
  subject_id: string;
  subject_revision: number;
  producer_id: string;
  administrative_actor_id: string;
  pinned_input_ids: string;
  excluded_actor_ids: string | null;
  required_criteria: string | null;
  provenance_json: string | null;
  artifact_ids: string;
  criteria: string;
  format_version: 2;
  manifest: string;
  snapshot_hash: string;
  status: ReviewRequest['status'];
  reviewer_id: string | null;
  claim_id: string | null;
  claim_generation: number;
  /** The open claim's review.started event, when it was taken, and whether a leased agent took it. */
  claim_event_id: number | null;
  claimed_at: string | null;
  claimed_by_agent: boolean;
  owner_override: boolean;
  recovery_json: string | null;
  verdict: ReviewRequest['verdict'];
  return_to: string | null;
  notes: string | null;
  synopsis: string | null;
  findings_json: string;
  evidence_json: string;
  created_at: string;
}
export const hydrate = (row: ReviewRow): ReviewRequest => ({
  ...(row.provenance_json == null ? {} : { provenance: JSON.parse(row.provenance_json) }),
  id: row.id,
  projectId: row.project_id,
  subjectId: row.subject_id,
  subjectRevision: row.subject_revision,
  producerId: row.producer_id,
  administrativeActorId: row.administrative_actor_id,
  pinnedInputIds: JSON.parse(row.pinned_input_ids),
  ...(row.excluded_actor_ids == null
    ? {}
    : { excludedActorIds: JSON.parse(row.excluded_actor_ids) }),
  ...(row.required_criteria == null ? {} : { requiredCriteria: JSON.parse(row.required_criteria) }),
  artifactIds: JSON.parse(row.artifact_ids),
  criteria: JSON.parse(row.criteria),
  formatVersion: row.format_version,
  snapshotHash: row.snapshot_hash,
  status: row.status,
  reviewerId: row.reviewer_id,
  claimId: row.claim_id,
  claimGeneration: row.claim_generation,
  ...(row.owner_override ? { override: true } : {}),
  recovery: row.recovery_json ? JSON.parse(row.recovery_json) : null,
  verdict: row.verdict,
  ...(row.return_to == null ? {} : { returnTo: row.return_to }),
  notes: row.notes,
  synopsis: row.synopsis,
  findings: JSON.parse(row.findings_json),
  evidence: JSON.parse(row.evidence_json),
  createdAt: row.created_at,
});
