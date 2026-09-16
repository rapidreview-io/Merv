import { z } from 'zod';
import {
  canonical,
  check,
  digest,
  now,
  type Caller,
  type Data,
  type Json,
  type Scope,
  type State,
} from '@merv/contracts';

/** Schema 81 only. These are research projections, never SELECT * or resumable workflows. */
export const legacyHistoryTables = {
  projects: {
    columns: [
      'created_at',
      'id',
      'name',
      'status',
      'summary',
      'hard_stop_rationale',
      'hard_stop_reflection_id',
      'stopped_at',
    ],
    keys: ['id'],
    parents: [],
  },
  claims: {
    columns: ['confidence', 'created_at', 'id', 'project_id', 'scope', 'statement', 'status'],
    keys: ['id'],
    parents: [],
  },
  experiments: {
    columns: [
      'attempt_index',
      'conclusion',
      'created_at',
      'details',
      'id',
      'intent',
      'name',
      'project_id',
      'revision_context',
      'status',
      'updated_at',
    ],
    keys: ['id'],
    parents: [],
  },
  experiment_claims: {
    columns: ['claim_id', 'experiment_id'],
    keys: ['experiment_id', 'claim_id'],
    parents: [
      ['experiment_id', 'experiments'],
      ['claim_id', 'claims'],
    ],
  },
  tasks: {
    columns: [
      'attempt_index',
      'created_at',
      'deliverables_json',
      'failed_by',
      'goal',
      'id',
      'name',
      'outcome',
      'project_id',
      'revision_context',
      'status',
      'updated_at',
    ],
    keys: ['id'],
    parents: [],
  },
  reflections: {
    columns: [
      'attempt_index',
      'corpus_json',
      'created_at',
      'created_seq',
      'id',
      'project_id',
      'published_at',
      'published_graph_version_id',
      'revision_context',
      'roster_json',
      'status',
      'title',
      'updated_at',
    ],
    keys: ['id'],
    parents: [],
  },
  reflection_claim_changes: {
    columns: ['claim_id', 'claim_key', 'created_at', 'op', 'reflection_id'],
    keys: ['reflection_id', 'claim_id'],
    parents: [
      ['reflection_id', 'reflections'],
      ['claim_id', 'claims'],
    ],
  },
  reflection_experiments: {
    columns: ['created_at', 'experiment_id', 'proposal_key', 'reflection_id'],
    keys: ['reflection_id', 'experiment_id'],
    parents: [
      ['reflection_id', 'reflections'],
      ['experiment_id', 'experiments'],
    ],
  },
  reflection_tasks: {
    columns: ['created_at', 'proposal_key', 'reflection_id', 'task_id'],
    keys: ['reflection_id', 'task_id'],
    parents: [
      ['reflection_id', 'reflections'],
      ['task_id', 'tasks'],
    ],
  },
  reflection_reserved_names: {
    columns: ['artifact_id', 'experiment_slots', 'name_lower', 'project_id', 'reflection_id'],
    keys: ['reflection_id', 'name_lower'],
    parents: [['reflection_id', 'reflections']],
  },
  node_dependencies: {
    columns: ['created_at', 'depends_on_id', 'node_id', 'project_id'],
    keys: ['node_id', 'depends_on_id'],
    parents: [],
  },
  consolidation_proposals: {
    columns: [
      'base_sha',
      'created_at',
      'created_by_session_id',
      'id',
      'project_id',
      'proposal_sha',
      'reflection_id',
      'revision',
      'summary',
      'validation_json',
    ],
    keys: ['id'],
    parents: [['reflection_id', 'reflections']],
  },
  consolidation_decisions: {
    columns: [
      'decided_at',
      'disposition',
      'experiment_id',
      'integration_kind',
      'proposal_id',
      'rationale',
      'source_sha',
      'superseded_by',
    ],
    keys: ['proposal_id', 'experiment_id'],
    parents: [
      ['proposal_id', 'consolidation_proposals'],
      ['experiment_id', 'experiments'],
    ],
  },
  project_candidates: {
    columns: [
      'created_at',
      'created_seq',
      'expected_sha256',
      'id',
      'name',
      'project_id',
      'source_experiment_id',
      'source_kind',
      'source_ref',
      'validation_json',
    ],
    keys: ['id'],
    parents: [],
  },
  litreview_sections: {
    columns: [
      'body',
      'created_at',
      'created_by',
      'created_seq',
      'id',
      'kind',
      'position',
      'project_id',
      'revision',
      'title',
      'tldr',
      'updated_at',
    ],
    keys: ['id'],
    parents: [],
  },
  papers: {
    columns: [
      'authors_json',
      'created_at',
      'created_by',
      'created_seq',
      'description',
      'fetch_status',
      'id',
      'norm_key',
      'project_id',
      'source_kind',
      'title',
      'updated_at',
      'url',
      'year',
    ],
    keys: ['id'],
    parents: [],
  },
  paper_links: {
    columns: [
      'created_at',
      'created_by',
      'id',
      'note',
      'paper_id',
      'project_id',
      'target_id',
      'target_type',
    ],
    keys: ['id'],
    parents: [['paper_id', 'papers']],
  },
  artifacts: {
    columns: [
      'content_sha256',
      'content_type',
      'created_at',
      'created_by',
      'created_seq',
      'discover_figures',
      'expires_at',
      'id',
      'max_bytes',
      'path',
      'project_id',
      'size_bytes',
      'status',
      'title',
      'updated_at',
    ],
    keys: ['id'],
    parents: [],
  },
  artifact_figures: {
    columns: [
      'artifact_id',
      'content_sha256',
      'expires_at',
      'id',
      'link_path',
      'size_bytes',
      'status',
    ],
    keys: ['id'],
    parents: [['artifact_id', 'artifacts']],
  },
  submissions: {
    columns: [
      'attempt_index',
      'created_at',
      'created_seq',
      'id',
      'project_id',
      'target_id',
      'target_type',
      'transition',
    ],
    keys: ['id'],
    parents: [],
  },
  research_artifact_links: {
    columns: [
      'active',
      'artifact_id',
      'attempt_index',
      'created_at',
      'created_seq',
      'id',
      'lens_id',
      'project_id',
      'role',
      'submission_id',
      'target_id',
      'target_type',
    ],
    keys: ['id'],
    parents: [['artifact_id', 'artifacts']],
  },
  research_submission_artifacts: {
    columns: ['link_id', 'submission_id'],
    keys: ['submission_id', 'link_id'],
    parents: [
      ['submission_id', 'submissions'],
      ['link_id', 'research_artifact_links'],
    ],
  },
  research_objects: {
    columns: [
      'content_sha256',
      'content_type',
      'created_at',
      'created_seq',
      'kind',
      'name',
      'notes',
      'object_created_at',
      'object_id',
      'producing_run',
      'project_id',
      'size_bytes',
      'source_uri',
      'status',
      'target_id',
      'target_type',
      'updated_at',
      'version',
    ],
    keys: ['object_id'],
    parents: [],
  },
  storage_objects: {
    columns: [
      'content_sha256',
      'content_type',
      'created_at',
      'created_by',
      'created_seq',
      'expires_at',
      'id',
      'kind',
      'last_accessed_at',
      'name',
      'namespace',
      'notes',
      'producing_experiment_id',
      'producing_run',
      'project_id',
      'size_bytes',
      'source_uri',
      'status',
      'updated_at',
      'version',
    ],
    keys: ['id'],
    parents: [],
  },
  reviews: {
    columns: [
      'created_at',
      'created_seq',
      'evidence_json',
      'findings_json',
      'id',
      'notes',
      'project_id',
      'request_id',
      'return_to',
      'role',
      'session_id',
      'submission_id',
      'synopsis',
      'target_id',
      'target_snapshot_id',
      'target_type',
      'verdict',
    ],
    keys: ['id'],
    parents: [
      ['request_id', 'review_requests'],
      ['session_id', 'review_sessions'],
    ],
  },
  review_requests: {
    columns: [
      'attempt_index',
      'created_at',
      'created_seq',
      'expires_at',
      'id',
      'producer_session_id',
      'project_id',
      'reason',
      'revision_context',
      'role',
      'status',
      'target_id',
      'target_snapshot_id',
      'target_type',
      'updated_at',
    ],
    keys: ['id'],
    parents: [],
  },
  review_sessions: {
    columns: [
      'caller_session_id',
      'created_at',
      'declared_agent',
      'id',
      'independence',
      'request_id',
      'status',
    ],
    keys: ['id'],
    parents: [['request_id', 'review_requests']],
  },
  posts: {
    columns: [
      'attachments_json',
      'author_handle',
      'author_role',
      'created_at',
      'created_seq',
      'embed_content_type',
      'embed_sha256',
      'id',
      'image_content_type',
      'image_sha256',
      'in_reply_to',
      'kind',
      'link_preview_json',
      'link_url',
      'project_id',
      'quote_of',
      'ref',
      'text',
      'thread_index',
      'thread_root',
    ],
    keys: ['id'],
    parents: [],
  },
  feed_authors: {
    columns: [
      'bio',
      'handle',
      'last_posted_at',
      'project_id',
      'registered_at',
      'role',
      'session_id',
    ],
    keys: ['project_id', 'handle'],
    parents: [],
  },
  post_reactions: {
    columns: ['created_at', 'kind', 'post_id', 'project_id'],
    keys: ['project_id', 'post_id', 'kind'],
    parents: [['post_id', 'posts']],
  },
  workflow_instances: {
    columns: [
      'child_key',
      'created_at',
      'data_json',
      'id',
      'outcome',
      'parent_id',
      'parent_revision',
      'project_id',
      'revision',
      'started_revision',
      'state',
      'updated_at',
      'version',
      'workflow',
    ],
    keys: ['id'],
    parents: [],
  },
  workflow_history: {
    columns: [
      'action',
      'after_json',
      'created_at',
      'event_id',
      'from_state',
      'id',
      'instance_id',
      'project_id',
      'revision',
    ],
    keys: ['id'],
    parents: [['instance_id', 'workflow_instances']],
  },
  workflow_actions: {
    columns: [
      'attempts',
      'created_at',
      'data_json',
      'delivered_at',
      'event_id',
      'id',
      'instance_id',
      'kind',
      'next_attempt_at',
      'project_id',
      'revision',
      'status',
    ],
    keys: ['id'],
    parents: [['instance_id', 'workflow_instances']],
  },
  events: {
    columns: ['created_at', 'id', 'payload_json', 'project_id', 'target_id', 'target_type', 'type'],
    keys: ['id'],
    parents: [],
  },
  agent_workspaces: {
    columns: [
      'base_sha',
      'branch',
      'commit_count',
      'deletions',
      'files_changed',
      'head_sha',
      'insertions',
      'instance_id',
      'project_id',
      'updated_at',
    ],
    keys: ['project_id', 'instance_id'],
    parents: [],
  },
  workspace_advances: {
    columns: [
      'ancestry_json',
      'bound_at',
      'diffstat_json',
      'expected_sha',
      'id',
      'instance_id',
      'intended_at',
      'observed_sha',
      'proposal_id',
      'proposal_parents_json',
      'runner_id',
      'status',
      'target_sha',
    ],
    keys: ['id'],
    parents: [
      ['instance_id', 'reflections'],
      ['proposal_id', 'consolidation_proposals'],
    ],
  },
} as const;

export type LegacyHistoryType = keyof typeof legacyHistoryTables;
const types = Object.keys(legacyHistoryTables) as LegacyHistoryType[];
export const legacyHistoryProjectionVersion = 2;
export const legacyHistoryExportSpec = {
  schemaVersion: 81,
  projectionVersion: legacyHistoryProjectionVersion,
  tables: legacyHistoryTables,
  excludedColumns: {
    projects: ['tenant_id', 'settings_json'],
    artifacts: ['upload_token'],
    artifact_figures: ['upload_token'],
    review_requests: ['capability_hash'],
    review_sessions: ['tenant_id'],
    project_candidates: ['idempotency_key', 'request_digest'],
    storage_objects: ['upload_id'],
    workflow_instances: ['start_key', 'start_fingerprint'],
    workflow_history: ['command_key', 'command_fingerprint'],
    workflow_actions: ['lease_token', 'lease_until', 'last_error'],
    workspace_advances: ['error'],
  },
  excludedTables: [
    'api_tokens',
    'sync_leases',
    'research_artifacts', // Compatibility view; its artifacts and links are exported separately.

    'agent_identities',
    'agent_runner_pairing_attempts',
    'agent_runner_pairings',
    'agent_runners',
    'agent_session_traces',
    'agent_sessions',
    'feed_upload_tokens',
    'mcp_sessions',
    'oauth_authorization_codes',
    'oauth_clients',
    'oauth_refresh_tokens',
    'project_api_keys',
    'project_members',
    'remote_sandbox_links',
    'schema_migrations',
    'storage_completion_tokens',
    'tenants',
    'tool_calls',
  ],
  consistency: {
    postgres:
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; check schema 81; read every projected table and source count through the same connection; COMMIT.',
    sqlite:
      'Use the SQLite backup API to make one consistent backup; verify schema 81 and read every projected table and count from that immutable backup.',
    scope:
      'Export all allowlisted tables for the selected projects. Resolve child ownership through every declared parent; include empty table arrays. No live table-by-table HTTP export.',
    secrets:
      'Exclude listed columns/tables. Apply projectLegacyHistoryRow to each row: known structured credential fields are omitted recursively. User-authored prose is retained as research content, not declared secret-free.',
    objects:
      'Rows preserve object metadata and references only. Copy and verify actual bytes separately; this archive never certifies their availability.',
  },
} as const;

export interface LegacyHistorySnapshot {
  sourceId: string;
  schemaVersion: 81;
  projectionVersion: 2;
  capturedAt: string;
  consistency: 'postgres-repeatable-read-read-only' | 'sqlite-consistent-backup';
  projectIds: string[];
  tables: Record<LegacyHistoryType, Data[]>;
}
export interface LegacyHistoryRecord {
  type: LegacyHistoryType;
  id: string;
  hash: string;
  historical: true;
  data: Data;
  fileRetention?: LegacyHistoryFileRetention;
}
export type LegacyHistoryFileRetention =
  | { status: 'verified'; artifactId: string }
  | {
      status: 'metadata-only';
      reason: 'legacy-lineage-without-retained-bytes';
      auditSha256: string;
    }
  | { status: 'unverified' };
export type LegacyHistoryArtifactRetentionEntry = {
  projectId: string;
  id: string;
  hash: string;
  size: number;
} & Exclude<LegacyHistoryFileRetention, { status: 'unverified' }>;
/** Trusted offline preparation output, never a browser-supplied availability claim. */
export interface LegacyHistoryArtifactRetention {
  auditSha256?: string;
  artifacts: LegacyHistoryArtifactRetentionEntry[];
}
interface FileRetentionCounts {
  verified: number;
  metadataOnly: number;
  unverified: number;
}
interface ArtifactRetentionReceipt {
  fingerprint: string;
  auditSha256?: string;
  counts: FileRetentionCounts;
  projectCounts: Record<string, FileRetentionCounts>;
}
export interface LegacyHistorySummaryRow {
  type: LegacyHistoryType;
  id: string;
  hash: string;
  historical: true;
  label: string;
  status?: string;
  createdAt?: string;
  fileRetention?: LegacyHistoryFileRetention;
}
export interface LegacyHistoryReceipt {
  sourceId: string;
  fingerprint: string;
  capturedAt: string;
  importedAt: string;
  historical: true;
  schemaVersion: 81;
  projectionVersion: 2;
  counts: Record<LegacyHistoryType, number>;
  projectCounts: Record<string, Record<LegacyHistoryType, number>>;
  retention: typeof retention;
  artifactRetention?: ArtifactRetentionReceipt;
}
const retention = {
  records: 'immutable-projected-research-history',
  credentials: 'excluded',
  toolLedger: 'excluded',
  nativeWorkflowContinuation: 'not-imported',
  objectBytes: 'not-verified-by-history-import',
  json: 'canonicalized-with-structured-secret-fields-excluded',
} as const;
const identifier = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const recordType = z.enum(types as [LegacyHistoryType, ...LegacyHistoryType[]]);
const metadataSchema = z
  .object({
    sourceId: identifier,
    schemaVersion: z.literal(81),
    projectionVersion: z.literal(legacyHistoryProjectionVersion),
    capturedAt: z.string().datetime({ offset: true }),
    consistency: z.enum(['postgres-repeatable-read-read-only', 'sqlite-consistent-backup']),
    projectIds: z.array(identifier).min(1),
    tables: z.record(z.array(z.record(z.unknown()))),
  })
  .strict();
const maxDetailBytes = 4 * 1024 * 1024;
const maxStoredRowBytes = 32 * 1024 * 1024;
const securityFields = new Set([
  'token',
  'secret',
  'secrets',
  'password',
  'passwd',
  'passphrase',
  'authorization',
  'proxy_authorization',
  'authentication',
  'auth',
  'credential',
  'credentials',
  'credential_json',
  'credentials_json',
  'capability',
  'capabilities',
  'bearer',
  'headers',
  'headers_json',
  'auth_header',
  'auth_headers',
  'authorization_header',
  'request_headers',
  'response_headers',
  'http_headers',
  'cookie',
  'cookies',
  'set_cookie',
  'api_key',
  'apikey',
  'x_api_key',
  'access_key_id',
  'accesskeyid',
  'api_access_key_id',
  'api_accesskeyid',
  'secret_access_key',
  'secretaccesskey',
  'private_key',
  'privatekey',
  'private_key_pem',
  'privatekeypem',
  'pem_private_key',
  'client_secret',
  'clientsecret',
  'secret_key',
  'signing_key',
  'device_code',
  'user_code',
]);
const credentialToken =
  /^(?:(?:access|refresh|bearer|session|csrf|id|api|oauth|oauth2|o_auth|upload|lease|completion|device|registration|invite|reset|verification|auth|authentication|reviewer|client|mcp|agent|actor|user|project|security|personal_access|api_access|mcp_session|x_auth|x_amz_security)_)?tokens?(?:_(?:hash|digest|fingerprint))?$/;
const securityDigest =
  /^(?:key|secret|password|passwd|passphrase|credential|credentials|capability|reviewer_capability|review_capability|session_capability|api_key|client_secret|secret_key|access_key_id|secret_access_key)(?:_(?:hash|digest|fingerprint))$/;
const accessKey = /^(?:(?:aws|s3|r2|api)_)?(?:access_key_id|secret_access_key)$/;
const privateKey =
  /(?:^|_)private_key(?:_pem)?(?:_(?:hash|digest|fingerprint))?$|^pem_private_key$/;
const normalizedKey = (key: string) =>
  key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-.\s]+/g, '_')
    .toLowerCase();
function sensitiveField(key: string, value: unknown): boolean {
  const field = normalizedKey(key);
  // Numeric token totals are research measurements; an opaque token is a credential.
  if (field === 'tokens' || field === 'completion_tokens')
    return typeof value !== 'number' || !Number.isFinite(value);
  return (
    securityFields.has(field) ||
    credentialToken.test(field) ||
    securityDigest.test(field) ||
    privateKey.test(field) ||
    accessKey.test(field) ||
    /^(?:reviewer|review|session)_capability$/.test(field)
  );
}

/** Fixed projection before export. It never returns excluded values or their hashes. */
export function projectLegacyHistoryRow(type: LegacyHistoryType, input: unknown): Data {
  check(
    Object.hasOwn(legacyHistoryTables, type),
    'invalid_legacy_history',
    'Unknown history record type',
  );
  check(
    input !== null && typeof input === 'object' && !Array.isArray(input),
    'invalid_legacy_history',
    'History row must be an object',
  );
  const raw = input as Record<string, unknown>;
  const clean = (value: unknown, depth = 0): Json => {
    check(depth <= 100, 'invalid_legacy_history', 'History JSON exceeds its nesting limit');
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number') {
      check(
        Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)),
        'invalid_legacy_history',
        'History numbers must be finite and exact',
      );
      return value;
    }
    if (Array.isArray(value)) return value.map((child) => clean(child, depth + 1));
    check(
      value !== null &&
        typeof value === 'object' &&
        [Object.prototype, null].includes(Object.getPrototypeOf(value)),
      'invalid_legacy_history',
      'History values must be JSON',
    );
    const result: Data = {};
    for (const [key, child] of Object.entries(value)) {
      if (sensitiveField(key, child) || ['__proto__', 'constructor', 'prototype'].includes(key))
        continue;
      result[key] = clean(child, depth + 1);
    }
    return result;
  };
  const row: Data = {};
  for (const column of legacyHistoryTables[type].columns) {
    check(
      Object.hasOwn(raw, column),
      'invalid_legacy_history',
      `Missing projected column in ${type}`,
    );
    let value = raw[column];
    if (column.endsWith('_json') && typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        check(false, 'invalid_legacy_history', `Invalid JSON column in ${type}`);
      }
    }
    row[column] = clean(value);
  }
  return row;
}

const emptyCounts = () =>
  Object.fromEntries(types.map((type) => [type, 0])) as Record<LegacyHistoryType, number>;
const sourceKey = (type: LegacyHistoryType, row: Data): string => {
  const values = legacyHistoryTables[type].keys.map((key) => {
    const value = row[key];
    check(
      (typeof value === 'string' && value.length > 0) ||
        (typeof value === 'number' && Number.isSafeInteger(value)),
      'invalid_legacy_history',
      `Invalid source key in ${type}`,
    );
    return value;
  });
  return values.length === 1 ? String(values[0]) : canonical(values);
};
interface PlannedRecord extends LegacyHistoryRecord {
  projectId: string;
  json: string;
}
export function planLegacyHistory(input: unknown) {
  const parsed = metadataSchema.safeParse(input);
  check(parsed.success, 'invalid_legacy_history', 'Legacy history snapshot is invalid');
  const snapshot = parsed.data;
  check(
    Object.keys(snapshot.tables).length === types.length &&
      types.every((type) => Object.hasOwn(snapshot.tables, type)),
    'invalid_legacy_history',
    'Every fixed history table must appear exactly once',
  );
  const projects = new Set(snapshot.projectIds);
  check(
    projects.size === snapshot.projectIds.length,
    'invalid_legacy_history',
    'Duplicate project in snapshot',
  );
  const records = new Map<LegacyHistoryType, Map<string, PlannedRecord>>();
  const counts = emptyCounts();
  let totalBytes = 0;
  for (const type of types) {
    const rows = new Map<string, PlannedRecord>();
    records.set(type, rows);
    for (const raw of snapshot.tables[type]) {
      const allowed = new Set<string>(legacyHistoryTables[type].columns);
      check(
        Object.keys(raw).every((key) => allowed.has(key)),
        'invalid_legacy_history',
        `Unexpected or excluded column in ${type}`,
      );
      const data = projectLegacyHistoryRow(type, raw);
      const id = sourceKey(type, data),
        json = canonical(data);
      check(
        id.length <= 2000,
        'invalid_legacy_history',
        'Source key exceeds the history lookup limit',
      );
      totalBytes += Buffer.byteLength(json);
      check(
        Buffer.byteLength(json) <= maxStoredRowBytes && totalBytes <= 256 * 1024 * 1024,
        'legacy_history_too_large',
        'Legacy history exceeds the bounded archive import size',
        413,
      );
      check(!rows.has(id), 'invalid_legacy_history', `Duplicate source record in ${type}`);
      rows.set(id, { type, id, hash: digest(data), historical: true, data, json, projectId: '' });
      counts[type]++;
    }
  }
  const resolving = new Set<PlannedRecord>();
  const owner = (record: PlannedRecord): string => {
    if (record.projectId) return record.projectId;
    check(!resolving.has(record), 'invalid_legacy_history', 'Cyclic source ownership');
    resolving.add(record);
    const { type, data } = record;
    let project = type === 'projects' ? data.id : data.project_id;
    check(
      project === undefined || typeof project === 'string',
      'invalid_legacy_history',
      'Invalid source project',
    );
    for (const [field, parentType] of legacyHistoryTables[type].parents) {
      const parent = records.get(parentType as LegacyHistoryType)!.get(String(data[field]));
      check(parent, 'invalid_legacy_history', `Missing parent for ${type}`);
      const parentProject = owner(parent);
      check(
        project === undefined || project === parentProject,
        'legacy_history_cross_project',
        'Source relationship crosses projects',
        409,
      );
      project = parentProject;
    }
    check(
      typeof project === 'string' && projects.has(project) && records.get('projects')!.has(project),
      'invalid_legacy_history',
      'History row has no selected project',
    );
    record.projectId = project;
    resolving.delete(record);
    return project;
  };
  const projectCounts = Object.fromEntries(
    [...projects].sort().map((project) => [project, emptyCounts()]),
  );
  const normalized: PlannedRecord[] = [];
  for (const type of types)
    for (const record of [...records.get(type)!.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )) {
      projectCounts[owner(record)][type]++;
      normalized.push(record);
    }
  check(
    records.get('projects')!.size === projects.size,
    'invalid_legacy_history',
    'Every selected project must have its source record',
  );
  const fingerprint = digest({
    sourceId: snapshot.sourceId,
    schemaVersion: 81,
    projectionVersion: legacyHistoryProjectionVersion,
    capturedAt: snapshot.capturedAt,
    consistency: snapshot.consistency,
    projectIds: [...projects].sort(),
    records: normalized.map(({ type, id, projectId, hash }) => ({ type, id, projectId, hash })),
  });
  return {
    sourceId: snapshot.sourceId,
    capturedAt: snapshot.capturedAt,
    fingerprint,
    records: normalized,
    counts,
    projectCounts,
  };
}

const tables = `CREATE TABLE legacy_history_imports (
  source_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, receipt TEXT NOT NULL
);
CREATE TABLE legacy_history_records (
  source_id TEXT NOT NULL REFERENCES legacy_history_imports(source_id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  record_type TEXT NOT NULL, source_key TEXT NOT NULL, content_hash TEXT NOT NULL,
  data_json TEXT NOT NULL, summary_json TEXT NOT NULL, detail_bytes INTEGER NOT NULL,
  PRIMARY KEY(source_id,record_type,source_key)
);
CREATE INDEX legacy_history_project_records ON legacy_history_records(source_id,project_id,record_type,source_key);`;
export async function initializeLegacyHistory(state: State): Promise<void> {
  await state.migrate('legacy-history', [
    {
      version: 1,
      sql:
        tables +
        ['legacy_history_imports', 'legacy_history_records']
          .map(
            (table) => `
CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Legacy history is immutable'); END;
CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Legacy history is retained'); END;`,
          )
          .join(''),
      postgres:
        tables +
        `
CREATE FUNCTION legacy_history_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN RAISE EXCEPTION USING MESSAGE='Legacy history is immutable', ERRCODE='23514'; END; $merv$;
` +
        ['legacy_history_imports', 'legacy_history_records']
          .map(
            (table) =>
              `CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION legacy_history_immutable_guard();`,
          )
          .join('\n'),
    },
  ]);
}
const retentionIdentity = {
  projectId: z.string().min(1).max(200),
  id: z.string().min(1).max(2000),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative().safe(),
};
const artifactRetentionSchema = z
  .object({
    auditSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    artifacts: z.array(
      z.discriminatedUnion('status', [
        z
          .object({
            ...retentionIdentity,
            status: z.literal('verified'),
            artifactId: z.string().min(1).max(2000),
          })
          .strict(),
        z
          .object({
            ...retentionIdentity,
            status: z.literal('metadata-only'),
            reason: z.literal('legacy-lineage-without-retained-bytes'),
            auditSha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      ]),
    ),
  })
  .strict();
const unverifiedRetentionFingerprint = digest({ status: 'unverified' });
/** Reused by the offline importer and reconciliation; the source archive remains unchanged. */
export function planLegacyHistoryArtifactRetention(
  plan: ReturnType<typeof planLegacyHistory>,
  input?: LegacyHistoryArtifactRetention,
) {
  const byId = new Map<string, LegacyHistoryFileRetention>();
  const complete = new Map(
    plan.records
      .filter((r) => r.type === 'artifacts' && r.data.status === 'complete')
      .map((r) => [r.id, r]),
  );
  let fingerprint = unverifiedRetentionFingerprint;
  let auditSha256: string | undefined;
  if (input !== undefined) {
    const parsed = artifactRetentionSchema.safeParse(input);
    check(parsed.success, 'invalid_legacy_retention', 'Invalid artifact retention receipt');
    const retained = parsed.data;
    auditSha256 = retained.auditSha256;
    check(
      retained.artifacts.length === complete.size,
      'invalid_legacy_retention',
      'Retention must classify every complete source artifact exactly once',
    );
    for (const entry of retained.artifacts) {
      const record = complete.get(entry.id);
      check(
        record &&
          !byId.has(entry.id) &&
          record.projectId === entry.projectId &&
          record.data.content_sha256 === entry.hash &&
          record.data.size_bytes === entry.size,
        'invalid_legacy_retention',
        'Retention does not match its exact source artifact',
      );
      if (entry.status === 'verified') {
        check(
          entry.artifactId === entry.id,
          'invalid_legacy_retention',
          'Verified original artifacts must preserve their source IDs',
        );
        byId.set(entry.id, { status: 'verified', artifactId: entry.artifactId });
      } else {
        check(
          auditSha256 === entry.auditSha256,
          'invalid_legacy_retention',
          'Metadata-only artifacts require the same explicit audit provenance',
        );
        byId.set(entry.id, {
          status: 'metadata-only',
          reason: entry.reason,
          auditSha256: entry.auditSha256,
        });
      }
    }
    fingerprint = digest({
      ...(auditSha256 ? { auditSha256 } : {}),
      artifacts: [...retained.artifacts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    });
  }
  const empty = (): FileRetentionCounts => ({ verified: 0, metadataOnly: 0, unverified: 0 });
  const projectCounts = Object.fromEntries(
    Object.keys(plan.projectCounts).map((p) => [p, empty()]),
  );
  const counts = empty();
  for (const record of plan.records) {
    if (record.type !== 'artifacts') continue;
    const envelope = byId.get(record.id) ?? { status: 'unverified' as const };
    byId.set(record.id, envelope);
    const key = envelope.status === 'metadata-only' ? 'metadataOnly' : envelope.status;
    counts[key]++;
    projectCounts[record.projectId][key]++;
  }
  const receipt: ArtifactRetentionReceipt = {
    fingerprint,
    ...(auditSha256 ? { auditSha256 } : {}),
    counts,
    projectCounts,
  };
  return { byId, receipt };
}
function withFileRetention<
  T extends { type: LegacyHistoryType; fileRetention?: LegacyHistoryFileRetention },
>(record: T): T {
  return record.type === 'artifacts' && !record.fileRetention
    ? { ...record, fileRetention: { status: 'unverified' } }
    : record;
}
function summary(
  record: LegacyHistoryRecord,
  fileRetention?: LegacyHistoryFileRetention,
): LegacyHistorySummaryRow {
  const { type, id, hash, data } = record;
  const label =
    [
      data.title,
      data.name,
      data.intent,
      data.goal,
      data.statement,
      data.action,
      data.role,
      data.kind,
    ].find((value) => typeof value === 'string' && value.length) ?? id;
  const result: LegacyHistorySummaryRow = {
    type,
    id,
    hash,
    historical: true,
    label: String(label).slice(0, 240),
  };
  if (typeof data.status === 'string') result.status = data.status.slice(0, 120);
  if (typeof data.created_at === 'string') result.createdAt = data.created_at;
  if (fileRetention) result.fileRetention = fileRetention;
  return result;
}

/** Trusted offline import only; never grants access, resumes work, or copies object bytes. */
export async function importLegacyHistory(
  state: State,
  input: unknown,
  options: { artifactRetention?: LegacyHistoryArtifactRetention } = {},
): Promise<LegacyHistoryReceipt> {
  const plan = planLegacyHistory(input);
  const artifactRetention = planLegacyHistoryArtifactRetention(plan, options.artifactRetention);
  await initializeLegacyHistory(state);
  return state.transaction(async (tx) => {
    const existing = await tx.get<{ fingerprint: string; receipt: string }>(
      'SELECT fingerprint,receipt FROM legacy_history_imports WHERE source_id=?',
      plan.sourceId,
    );
    if (existing) {
      const receipt = JSON.parse(existing.receipt) as LegacyHistoryReceipt;
      check(
        existing.fingerprint === plan.fingerprint &&
          (receipt.artifactRetention?.fingerprint ?? unverifiedRetentionFingerprint) ===
            artifactRetention.receipt.fingerprint,
        'legacy_history_conflict',
        'This source ID already identifies different history or artifact retention',
        409,
      );
      return receipt;
    }
    for (const projectId of Object.keys(plan.projectCounts))
      check(
        await tx.get('SELECT id FROM projects WHERE id=?', projectId),
        'legacy_history_project_missing',
        'Import the native project before its history',
        409,
      );
    const receipt: LegacyHistoryReceipt = {
      sourceId: plan.sourceId,
      fingerprint: plan.fingerprint,
      capturedAt: plan.capturedAt,
      importedAt: now(),
      schemaVersion: 81,
      projectionVersion: legacyHistoryProjectionVersion,
      historical: true,
      counts: plan.counts,
      projectCounts: plan.projectCounts,
      retention,
      artifactRetention: artifactRetention.receipt,
    };
    await tx.run(
      'INSERT INTO legacy_history_imports(source_id,fingerprint,receipt) VALUES(?,?,?)',
      plan.sourceId,
      plan.fingerprint,
      canonical(receipt),
    );
    for (const record of plan.records)
      await tx.run(
        'INSERT INTO legacy_history_records(source_id,project_id,record_type,source_key,content_hash,data_json,summary_json,detail_bytes) VALUES(?,?,?,?,?,?,?,?)',
        plan.sourceId,
        record.projectId,
        record.type,
        record.id,
        record.hash,
        record.json,
        canonical(
          summary(
            record,
            record.type === 'artifacts' ? artifactRetention.byId.get(record.id) : undefined,
          ),
        ),
        Buffer.byteLength(record.json),
      );
    return receipt;
  });
}

const sourceInput = z.object({ sourceId: identifier }).strict();
const listInput = z
  .object({
    sourceId: identifier,
    type: recordType,
    after: z.string().min(1).max(2000).optional(),
    limit: z.number().int().min(1).max(100).default(30),
  })
  .strict();
const detailInput = z
  .object({ sourceId: identifier, type: recordType, id: z.string().min(1).max(2000) })
  .strict();
function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  check(result.success, 'invalid_legacy_history_query', 'History query is invalid');
  return result.data;
}
/** Human project membership only. Archive reads cannot widen an agent's assignment authority. */
export class LegacyHistoryReader {
  constructor(
    private readonly state: State,
    private readonly scope: Pick<Scope, 'require'>,
  ) {}
  private async authorize(caller: Caller) {
    check(
      caller.human && !caller.session && !caller.key && !caller.credentialId,
      'legacy_history_member_required',
      'History requires a verified human project member',
      403,
    );
    await this.scope.require(caller, 'read');
  }
  async summary(caller: Caller, input: { sourceId: string }) {
    await this.authorize(caller);
    const { sourceId } = parse(sourceInput, input);
    const row = await this.state.read((sql) =>
      sql.get<{ receipt: string }>(
        'SELECT receipt FROM legacy_history_imports WHERE source_id=?',
        sourceId,
      ),
    );
    await this.authorize(caller);
    const receipt = row ? (JSON.parse(row.receipt) as LegacyHistoryReceipt) : undefined;
    check(
      receipt?.projectCounts[caller.projectId],
      'legacy_history_not_found',
      'History snapshot is unavailable in this project',
      404,
    );
    const { projectCounts: _all, counts: _global, artifactRetention, ...metadata } = receipt;
    return {
      ...metadata,
      counts: receipt.projectCounts[caller.projectId],
      ...(artifactRetention
        ? {
            artifactRetention: {
              fingerprint: artifactRetention.fingerprint,
              ...(artifactRetention.auditSha256
                ? { auditSha256: artifactRetention.auditSha256 }
                : {}),
              counts: artifactRetention.projectCounts[caller.projectId],
            },
          }
        : {}),
    };
  }
  async list(
    caller: Caller,
    input: { sourceId: string; type: LegacyHistoryType; after?: string; limit?: number },
  ): Promise<{ records: LegacyHistorySummaryRow[]; next?: string }> {
    await this.authorize(caller);
    const query = parse(listInput, input);
    const rows = await this.state.read((sql) =>
      sql.all<{ source_key: string; summary_json: string }>(
        'SELECT source_key,summary_json FROM legacy_history_records WHERE source_id=? AND project_id=? AND record_type=? AND source_key>? ORDER BY source_key LIMIT ?',
        query.sourceId,
        caller.projectId,
        query.type,
        query.after ?? '',
        query.limit + 1,
      ),
    );
    await this.authorize(caller);
    return {
      records: rows
        .slice(0, query.limit)
        .map((row) => withFileRetention(JSON.parse(row.summary_json) as LegacyHistorySummaryRow)),
      ...(rows.length > query.limit ? { next: rows[query.limit - 1].source_key } : {}),
    };
  }
  async detail(
    caller: Caller,
    input: { sourceId: string; type: LegacyHistoryType; id: string },
  ): Promise<LegacyHistoryRecord> {
    await this.authorize(caller);
    const query = parse(detailInput, input);
    const result = await this.state.read(async (sql) => {
      const metadata = await sql.get<{ detail_bytes: number }>(
        'SELECT detail_bytes FROM legacy_history_records WHERE source_id=? AND project_id=? AND record_type=? AND source_key=?',
        query.sourceId,
        caller.projectId,
        query.type,
        query.id,
      );
      const row =
        metadata && metadata.detail_bytes <= maxDetailBytes
          ? await sql.get<{ data_json: string; content_hash: string; summary_json: string }>(
              'SELECT data_json,content_hash,summary_json FROM legacy_history_records WHERE source_id=? AND project_id=? AND record_type=? AND source_key=?',
              query.sourceId,
              caller.projectId,
              query.type,
              query.id,
            )
          : undefined;
      return { metadata, row };
    });
    await this.authorize(caller);
    check(
      result.metadata,
      'legacy_history_not_found',
      'History record is unavailable in this project',
      404,
    );
    check(
      result.metadata.detail_bytes <= maxDetailBytes,
      'legacy_history_detail_too_large',
      'History record exceeds the interactive detail limit; its complete canonical content remains archived',
      413,
    );
    const { row } = result;
    check(row, 'legacy_history_not_found', 'History record is unavailable in this project', 404);
    const summary = withFileRetention(JSON.parse(row.summary_json) as LegacyHistorySummaryRow);
    return {
      type: query.type,
      id: query.id,
      hash: row.content_hash,
      historical: true,
      data: JSON.parse(row.data_json) as Data,
      ...(summary.fileRetention ? { fileRetention: summary.fileRetention } : {}),
    };
  }
}
