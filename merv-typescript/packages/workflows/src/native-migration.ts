import {
  canonical,
  check,
  digest,
  now,
  type Sql,
  type State,
  type Transaction,
} from '@merv/contracts';
import { readPinned } from './pinned.js';

/** A retained revision boundary, not a rewrite of the published protocol or its evidence. */
export const nativeMigrationSchema = `
CREATE TABLE wf_protocol_migrations (
 project_id TEXT NOT NULL,instance_id TEXT NOT NULL,source_revision BIGINT NOT NULL,
 source_version BIGINT NOT NULL,target_revision BIGINT NOT NULL,target_version BIGINT NOT NULL,
 source_json TEXT NOT NULL,source_hash TEXT NOT NULL,actor_id TEXT NOT NULL,reason TEXT NOT NULL,
 created_at TEXT NOT NULL,PRIMARY KEY(instance_id,source_revision),UNIQUE(instance_id,target_revision)
);
CREATE FUNCTION wf_protocol_migrations_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN RAISE EXCEPTION 'Workflow protocol migrations are immutable and retained'; END; $merv$;
CREATE TRIGGER wf_protocol_migrations_guard BEFORE UPDATE OR DELETE ON wf_protocol_migrations
FOR EACH ROW EXECUTE FUNCTION wf_protocol_migrations_guard();
CREATE TRIGGER wf_protocol_migrations_no_truncate BEFORE TRUNCATE ON wf_protocol_migrations
FOR EACH STATEMENT EXECUTE FUNCTION wf_protocol_migrations_guard();`;

export const initializeNativeMigrations = (state: State) =>
  state.migrate('workflow_native_git', [{ version: 1, sql: nativeMigrationSchema }]);

export interface NativeMigrationInput {
  projectId: string;
  instanceId: string;
  expectedRevision: number;
  fromVersion: number;
  toVersion: number;
  actorId: string;
  reason: string;
}
export interface NativeMigrationRow {
  id: string;
  project_id: string;
  workflow: string;
  version: number;
  state: string;
  revision: number;
  data_json: string;
  created_at: string;
  updated_at: string;
}

/** Read-only source evidence for an offline plan, before the migration ledger exists. */
export async function nativeAdmissionSnapshot(
  sql: Sql,
  projectId: string,
  instanceIds: readonly string[],
) {
  if (!instanceIds.length) return { blockers: [], starts: [], limits: {} };
  const placeholders = instanceIds.map(() => '?').join(',');
  const blockers = await sql.all<{
    instance_id: string;
    provider: string;
    blocker_key: string;
    revision: number | null;
    code: string;
    since: string;
    updated_at: string;
  }>(
    `SELECT * FROM wf_blockers WHERE project_id=? AND instance_id IN (${placeholders}) ORDER BY instance_id,provider,blocker_key`,
    projectId,
    ...instanceIds,
  );
  const starts = await sql.all(
    `SELECT * FROM wf_work_starts WHERE project_id=? AND instance_id IN (${placeholders}) ORDER BY instance_id,revision`,
    projectId,
    ...instanceIds,
  );
  const limits: Record<string, { count: number; hash: string }> = {};
  for (const [name, order] of [
    ['wf_history', 'instance_id,revision'],
    ['wf_limit_grants', 'instance_id,request_id'],
  ] as const) {
    const rows = await sql.all(
      `SELECT * FROM ${name} WHERE project_id=? AND instance_id IN (${placeholders}) ORDER BY ${order}`,
      projectId,
      ...instanceIds,
    );
    limits[name] = { count: rows.length, hash: digest(rows) };
  }
  return {
    limits,
    blockers: blockers.map((row) => ({
      instanceId: row.instance_id,
      provider: row.provider,
      key: row.blocker_key,
      revision: row.revision,
      code: row.code,
      since: row.since,
      updatedAt: row.updated_at,
      hash: digest(row),
    })),
    starts,
  };
}

/** Only idle producing nodes, or customer requests that have not started execution. */
export function nativeMigrationTarget(
  row: Pick<NativeMigrationRow, 'workflow' | 'version' | 'state'>,
): number | null {
  const version = Number(row.version);
  if (
    row.workflow === 'experiment' &&
    [40, 41, 42, 43, 44].includes(version) &&
    row.state === 'planned'
  )
    return 45;
  if (row.workflow === 'task' && [2, 43, 44].includes(version) && row.state === 'in_progress')
    return 46;
  if (
    row.workflow === 'service_experiment' &&
    [1, 3, 4].includes(version) &&
    ['planning', 'ready', 'awaiting_payment'].includes(row.state)
  )
    return version === 1 ? 6 : 5;
  return null;
}

/**
 * Called only by the offline cutover or after a genuine legacy artifact-review revision.
 * The caller owns authorization and the transaction. No evidence, refs, pins, payments,
 * dependency contracts or Code declaration provenance are edited here.
 */
export async function migrateNativeWorkflow(tx: Transaction, input: NativeMigrationInput) {
  const { projectId, instanceId, expectedRevision, fromVersion, toVersion, actorId, reason } =
    input;
  check(
    actorId.trim() && reason.trim() && reason.length <= 2000,
    'invalid_migration',
    'Migration requires an actor and a specific reason',
  );
  const replay = await tx.get<{
    source_version: number;
    target_revision: number;
    target_version: number;
    actor_id: string;
    reason: string;
  }>(
    'SELECT source_version,target_revision,target_version,actor_id,reason FROM wf_protocol_migrations WHERE project_id=? AND instance_id=? AND source_revision=?',
    projectId,
    instanceId,
    expectedRevision,
  );
  if (replay) {
    check(
      Number(replay.source_version) === fromVersion &&
        Number(replay.target_version) === toVersion &&
        replay.actor_id === actorId &&
        replay.reason === reason,
      'migration_conflict',
      'This revision already has a different migration',
      409,
    );
    return { revision: Number(replay.target_revision), version: toVersion };
  }
  const row = await tx.get<NativeMigrationRow>(
    'SELECT * FROM wf_instances WHERE id=? AND project_id=? FOR UPDATE',
    instanceId,
    projectId,
  );
  check(
    row && Number(row.version) === fromVersion && Number(row.revision) === expectedRevision,
    'revision_conflict',
    'Workflow changed since migration was planned',
    409,
  );
  check(
    nativeMigrationTarget(row) === toVersion,
    'migration_unsupported',
    'This workflow state has no native Git migration',
    409,
  );
  const [before, after] = await Promise.all([
    readPinned(tx, row.workflow, fromVersion),
    readPinned(tx, row.workflow, toVersion),
  ]);
  const graph = (value: NonNullable<typeof before>) => ({ ...value.definition, version: 0 });
  check(
    before &&
      after &&
      canonical(graph(before)) === canonical(graph(after)) &&
      canonical(before.successStates) === canonical(after.successStates),
    'migration_contract_conflict',
    'Migration must preserve the complete workflow graph and success semantics',
    409,
  );
  const leases = await tx.all<{ state: string; revision: number; review_id: string | null }>(
    'SELECT state,revision,review_id FROM wf_leases WHERE project_id=? AND instance_id=? AND released_at IS NULL',
    projectId,
    instanceId,
  );
  for (const lease of leases) {
    // A real v2 revise may still hold its now-stale read-only review lease until handoff.
    const revised =
      fromVersion === 2 &&
      row.workflow === 'task' &&
      lease.state === 'in_review' &&
      Number(lease.revision) === expectedRevision - 1 &&
      lease.review_id &&
      (await tx.get(
        "SELECT id FROM reviews WHERE id=? AND project_id=? AND subject_id=? AND subject_revision=? AND status='submitted' AND verdict='needs_changes'",
        lease.review_id,
        projectId,
        instanceId,
        lease.revision,
      ));
    check(revised, 'migration_busy', 'A workflow lease still owns this work', 409);
  }
  check(
    !(await tx.get(
      "SELECT unit_id FROM code_workspaces WHERE project_id=? AND unit_id=? AND writer_state IN ('reserved','active','closing','recovery_required')",
      projectId,
      instanceId,
    )),
    'migration_busy',
    'A Code writer still owns this work',
    409,
  );
  check(
    !(await tx.get(
      "SELECT id FROM reviews WHERE project_id=? AND subject_id=? AND status IN ('requested','started')",
      projectId,
      instanceId,
    )),
    'migration_review_pending',
    'An unfinished review must retain its exact protocol',
    409,
  );
  const at = now(),
    revision = expectedRevision + 1;
  const source = { ...row, version: Number(row.version), revision: Number(row.revision) };
  await tx.run(
    'INSERT INTO wf_protocol_migrations(project_id,instance_id,source_revision,source_version,target_revision,target_version,source_json,source_hash,actor_id,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    projectId,
    instanceId,
    expectedRevision,
    fromVersion,
    revision,
    toVersion,
    canonical(source),
    digest(source),
    actorId,
    reason,
    at,
  );
  const changed = await tx.run(
    'UPDATE wf_instances SET version=?,revision=?,updated_at=? WHERE project_id=? AND id=? AND version=? AND revision=?',
    toVersion,
    revision,
    at,
    projectId,
    instanceId,
    fromVersion,
    expectedRevision,
  );
  check(changed.changes === 1, 'revision_conflict', 'Workflow changed during migration', 409);
  const data = { fromVersion, toVersion, sourceRevision: expectedRevision, revision, reason };
  await tx.run(
    'INSERT INTO wf_history(instance_id,project_id,revision,action,actor_id,request_id,from_state,to_state,data_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    instanceId,
    projectId,
    revision,
    'migrate_native_git',
    actorId,
    `native-git:${instanceId}:${expectedRevision}`,
    row.state,
    row.state,
    canonical(data),
    at,
  );
  await tx.run(
    'INSERT INTO events(project_id,actor_id,type,subject_id,data_json,created_at) VALUES(?,?,?,?,?,?)',
    projectId,
    actorId,
    'workflow.protocol_migrated',
    instanceId,
    canonical({ ...data, workflow: row.workflow, state: row.state }),
    at,
  );
  return { revision, version: toVersion };
}

/** Migration alone must not hide unsubmitted output from the visit being resumed. */
export async function nativeRecoveryRevision(
  sql: Sql,
  projectId: string,
  instanceId: string,
  revision: number,
): Promise<number | null> {
  const row = await sql.get<{ source_revision: number }>(
    'SELECT source_revision FROM wf_protocol_migrations WHERE project_id=? AND instance_id=? AND target_revision=?',
    projectId,
    instanceId,
    revision,
  );
  return row ? Number(row.source_revision) : null;
}
