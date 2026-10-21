import { digest, type Sql } from '@merv/contracts';

/** Retained admission inputs, not a prediction from deployment configuration. The caller
 * owns a read-only snapshot. No migration ledger or live service is needed on the old DB. */
export async function nativeAdmissionSnapshot(
  sql: Sql,
  projectId: string,
  instanceIds: readonly string[],
) {
  const gates = {
    fleet_holds: 'SELECT name,until FROM fleet_holds ORDER BY name',
    fleet_project_limits:
      'SELECT project_id,machines FROM fleet_project_limits ORDER BY project_id',
    fleet_usd_limits: 'SELECT person,usd FROM fleet_usd_limits ORDER BY person',
    fleet_model_limits: 'SELECT person,tokens FROM fleet_model_limits ORDER BY person',
    fleet_model_caps: 'SELECT person,tokens FROM fleet_model_caps ORDER BY person',
    fleet_model_usage: 'SELECT person,day,tokens FROM fleet_model_usage ORDER BY person,day',
    fleet_model_blockers:
      'SELECT person,day,required_tokens FROM fleet_model_blockers ORDER BY person,day',
  };
  const tables = [
    'fleet_allocations',
    'fleet_workflow_retry_grants',
    'session_managed_runners',
    'session_managed_assignments',
    ...Object.keys(gates),
  ];
  const available = new Set(
    (
      await sql.all<{ name: string; relation: string | null }>(
        'SELECT name,to_regclass(name)::text AS relation FROM jsonb_array_elements_text(?::jsonb) AS t(name)',
        JSON.stringify(tables),
      )
    )
      .filter((row) => row.relation !== null)
      .map((row) => row.name),
  );
  const ids = [...new Set(instanceIds)].sort();
  // Select only scheduling facts. Allocation JSON can contain delegation and bootstrap
  // material; neither those bytes nor credentials belong in an operator's plan.
  const all = available.has('fleet_allocations')
    ? await sql.all<
        {
          id: string;
          project_id: string;
          owner_id: string;
          owner_kind: string;
        } & Record<string, unknown>
      >(`SELECT id,project_id,source_hash,request_id,input_hash,phase,created_at,
    data_json::jsonb #>> '{owner,kind}' AS owner_kind,
    data_json::jsonb #>> '{owner,id}' AS owner_id,
    data_json::jsonb ->> 'epoch' AS epoch,
    data_json::jsonb ->> 'intent' AS intent,
    data_json::jsonb ->> 'updatedAt' AS updated_at,
    data_json::jsonb ->> 'deadlineAt' AS deadline_at,
    data_json::jsonb ->> 'releaseBy' AS release_by,
    data_json::jsonb ->> 'retryAt' AS retry_at,
    data_json::jsonb ->> 'error' AS error,
    data_json::jsonb ->> 'failures' AS failures,
    data_json::jsonb ->> 'person' AS person,
    data_json::jsonb ->> 'usdPerHour' AS usd_per_hour,
    data_json::jsonb ->> 'seconds' AS seconds,
    data_json::jsonb ->> 'createAttempted' AS create_attempted,
    data_json::jsonb ->> 'shutdownRequired' AS shutdown_required,
    data_json::jsonb ->> 'shutdownAcknowledged' AS shutdown_acknowledged,
    COALESCE(data_json::jsonb -> 'runtime' <> 'null'::jsonb,FALSE) AS had_runtime,
    data_json::jsonb #>> '{runtime,state}' AS runtime_state,
    data_json::jsonb #>> '{runtime,launch,deliveryState}' AS launch_state
    FROM fleet_allocations
    ORDER BY created_at,id`)
    : [];
  const allocations = all.filter(
    (row) =>
      row.project_id === projectId &&
      row.owner_kind === 'workflow' &&
      ids.some((id) => row.owner_id === `work:${id}` || row.owner_id.startsWith(`${id}:`)),
  );
  const allocated = allocations.map((row) => row.id);
  const bindings =
    available.has('session_managed_runners') && allocated.length
      ? await sql.all(
          `SELECT allocation_id,epoch,runner_id,bound_session_id,runner_released_at
       FROM session_managed_runners WHERE allocation_id IN (${allocated.map(() => '?').join(',')}) ORDER BY allocation_id`,
          ...allocated,
        )
      : [];
  const claims =
    available.has('session_managed_assignments') && allocated.length
      ? await sql.all(
          `SELECT allocation_id,ordinal,session_id,bound_at,release_ack_at,settled_at
       FROM session_managed_assignments WHERE allocation_id IN (${allocated.map(() => '?').join(',')}) ORDER BY allocation_id,ordinal`,
          ...allocated,
        )
      : [];
  const grants =
    available.has('fleet_workflow_retry_grants') && ids.length
      ? await sql.all(
          `SELECT id,project_id,instance_id,expected_revision,prior_allocations,request_id,input_hash,actor_id,created_at
       FROM fleet_workflow_retry_grants WHERE project_id=? AND instance_id IN (${ids.map(() => '?').join(',')}) ORDER BY instance_id,expected_revision,id`,
          projectId,
          ...ids,
        )
      : [];
  const shared: Record<string, { present: boolean; count: number; hash: string }> = {
    allocations: {
      present: available.has('fleet_allocations'),
      count: all.length,
      hash: digest(all),
    },
  };
  for (const [table, query] of Object.entries(gates)) {
    const rows = available.has(table) ? await sql.all(query) : [];
    shared[table] = { present: available.has(table), count: rows.length, hash: digest(rows) };
  }
  return {
    allocations,
    bindings,
    claims,
    grants,
    shared,
    present: Object.fromEntries(tables.map((table) => [table, available.has(table)])),
  };
}
