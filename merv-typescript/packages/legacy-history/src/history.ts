import { z } from 'zod';
import { check, type Caller, type Data, type Scope, type State } from '@merv/contracts';

/** Types retained by the immutable schema-81 archive; no live workflow continuation. */
export const legacyHistoryTypes = [
  'projects',
  'claims',
  'experiments',
  'experiment_claims',
  'tasks',
  'reflections',
  'reflection_claim_changes',
  'reflection_experiments',
  'reflection_tasks',
  'reflection_reserved_names',
  'node_dependencies',
  'consolidation_proposals',
  'consolidation_decisions',
  'project_candidates',
  'litreview_sections',
  'papers',
  'paper_links',
  'artifacts',
  'artifact_figures',
  'submissions',
  'research_artifact_links',
  'research_submission_artifacts',
  'research_objects',
  'storage_objects',
  'reviews',
  'review_requests',
  'review_sessions',
  'posts',
  'feed_authors',
  'post_reactions',
  'workflow_instances',
  'workflow_history',
  'workflow_actions',
  'events',
  'agent_workspaces',
  'workspace_advances',
] as const;
export type LegacyHistoryType = (typeof legacyHistoryTypes)[number];

interface LegacyHistoryRecord {
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
interface LegacyHistorySummaryRow {
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
const recordType = z.enum(legacyHistoryTypes);
const maxDetailBytes = 4 * 1024 * 1024;

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
function withFileRetention<
  T extends { type: LegacyHistoryType; fileRetention?: LegacyHistoryFileRetention },
>(record: T): T {
  return record.type === 'artifacts' && !record.fileRetention
    ? { ...record, fileRetention: { status: 'unverified' } }
    : record;
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
/** Anyone who reads the project reads its archive; the archive widens nothing else. */
export class LegacyHistoryReader {
  constructor(
    private readonly state: State,
    private readonly scope: Pick<Scope, 'require'>,
  ) {}
  private async authorize(caller: Caller) {
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
