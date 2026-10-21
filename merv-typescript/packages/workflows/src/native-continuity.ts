import type { Sql } from '@merv/contracts';

export interface NativeRevisionContinuity {
  source(instanceId: string, revision: number): number;
  current(instanceId: string, revision: number): number;
  updatedAt(instanceId: string, revision: number, updatedAt: string): string;
}

/** Scheduling continuity only. Never use this to authorize a lease, action or credential.
 * The original and migrated revision are equivalent only while the workflow still stands
 * at that exact migration boundary. Any ordinary revision ends the equivalence. */
export async function nativeRevisionContinuity(
  sql: Sql,
  projectId: string,
): Promise<NativeRevisionContinuity> {
  const rows = await sql.all<{
    instance_id: string;
    source_revision: number;
    target_revision: number;
    updated_at: string;
  }>(
    `SELECT m.instance_id,m.source_revision,m.target_revision,m.source_json::jsonb ->> 'updated_at' AS updated_at
     FROM wf_protocol_migrations m JOIN wf_instances i ON i.id=m.instance_id AND i.project_id=m.project_id
     WHERE m.project_id=? AND i.revision=m.target_revision AND i.version=m.target_version`,
    projectId,
  );
  const byId = new Map(rows.map((row) => [row.instance_id, row]));
  return {
    source(id, revision) {
      const row = byId.get(id);
      return row && revision === Number(row.target_revision)
        ? Number(row.source_revision)
        : revision;
    },
    current(id, revision) {
      const row = byId.get(id);
      return row && revision === Number(row.source_revision)
        ? Number(row.target_revision)
        : revision;
    },
    updatedAt(id, revision, updatedAt) {
      const row = byId.get(id);
      return row && revision === Number(row.target_revision) ? row.updated_at : updatedAt;
    },
  };
}

/** Internal SQL aliases only. Provider opinions follow a protocol migration, not a user edit. */
export const retainedRevisionSql = (instance: string, record: string) =>
  `(${record}.revision IS NULL OR ${record}.revision=${instance}.revision OR EXISTS (
    SELECT 1 FROM wf_protocol_migrations m WHERE m.project_id=${instance}.project_id AND m.instance_id=${instance}.id
    AND m.source_revision=${record}.revision AND m.target_revision=${instance}.revision AND m.target_version=${instance}.version))`;
