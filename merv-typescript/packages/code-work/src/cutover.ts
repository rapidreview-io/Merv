import { check, now, type Sql } from '@merv/contracts';
import { legacyArtifactReviewEligible } from '@merv/tasks/legacy-artifact-review';

/** Read-only preflight: a new runtime never silently changes an in-flight published protocol. */
export async function gitCutover(sql: Sql) {
  const oldWork = await sql.all<{
    project_id: string;
    id: string;
    workflow: string;
    version: number;
    state: string;
  }>(`
    SELECT i.project_id,i.id,i.workflow,i.version,i.state FROM wf_instances i
    JOIN wf_definitions d ON d.name=i.workflow AND d.version=i.version
    WHERE ((i.workflow='experiment' AND i.version<45) OR (i.workflow='task' AND i.version<46) OR (i.workflow='service_experiment' AND i.version<5))
    AND NOT jsonb_exists(d.definition_json::jsonb -> 'terminal', i.state) ORDER BY i.project_id,i.id`);
  const legacyWork: typeof oldWork = [];
  const retainedArtifactReviews: typeof oldWork = [];
  for (const row of oldWork) {
    const retained =
      row.workflow === 'task' &&
      Number(row.version) === 2 &&
      (await legacyArtifactReviewEligible(sql, row.project_id, row.id));
    (retained ? retainedArtifactReviews : legacyWork).push(row);
  }
  const transfers = await sql.all<{ project_id: string; id: string; kind: string }>(`
    SELECT project_id,id,kind FROM code_operations WHERE status='prepared'
    AND kind IN ('upload','import','export') ORDER BY project_id,id`);
  const commands = await sql.all<{ project_id: string; id: string; status: string }>(`
    SELECT project_id,id,status FROM code_commands WHERE status IN ('queued','dispatched') ORDER BY project_id,id`);
  const writers = await sql.all<{
    project_id: string;
    unit_id: string;
    writer_session_id: string | null;
  }>(`
    SELECT project_id,unit_id,writer_session_id FROM code_workspaces
    WHERE writer_state IN ('reserved','active','closing','recovery_required') ORDER BY project_id,unit_id`);
  const tables = await sql.get<{ fleet: string | null; managed: string | null }>(
    "SELECT to_regclass('fleet_allocations')::text AS fleet, to_regclass('session_managed_runners')::text AS managed",
  );
  const allocations = tables?.fleet
    ? await sql.all<{ project_id: string; id: string; phase: string }>(
        "SELECT project_id,id,phase FROM fleet_allocations WHERE phase<>'released' AND data_json::jsonb #>> '{owner,kind}'='workflow' ORDER BY project_id,id",
      )
    : [];
  const managedRunners = tables?.managed
    ? await sql.all<{ project_id: string; allocation_id: string; runner_id: string | null }>(
        'SELECT project_id,allocation_id,runner_id FROM session_managed_runners WHERE runner_released_at IS NULL AND control_expires_at>? ORDER BY project_id,allocation_id',
        now(),
      )
    : [];
  return {
    ready:
      !legacyWork.length &&
      !transfers.length &&
      !commands.length &&
      !writers.length &&
      !allocations.length &&
      !managedRunners.length,
    legacyWork,
    retainedArtifactReviews,
    transfers,
    commands,
    writers,
    allocations,
    managedRunners,
  };
}
export async function requireGitCutover(sql: Sql) {
  const status = await gitCutover(sql);
  check(
    status.ready,
    'code_legacy_drain_required',
    `Git cutover requires draining ${status.legacyWork.length} legacy work units, ${status.transfers.length} transfers, ${status.commands.length} queued commands and ${status.writers.length} writers, ${status.allocations.length} workflow allocations and ${status.managedRunners.length} live managed runners on the previous runtime`,
    409,
  );
  return status;
}
