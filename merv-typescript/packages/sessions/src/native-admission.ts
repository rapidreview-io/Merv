import { digest, type Sql } from '@merv/contracts';

/** Read on the migration plan/apply transaction. Hash the selected work's admission
 * facts and project gates/accounting; never return question text, runner secrets or frozen packets.
 * Original revisions stay in the hash so migrating the workflow cannot rewrite this history. */
export async function nativeAdmissionSnapshot(
  sql: Sql,
  projectId: string,
  instanceIds: readonly string[],
) {
  const ids = JSON.stringify([...new Set(instanceIds)].sort());
  const selected = 'instance_id IN (SELECT jsonb_array_elements_text(?::jsonb))';
  const facts = async (query: string) => {
    const rows = await sql.all(query, projectId, ids);
    return { count: rows.length, hash: digest(rows) };
  };
  const dispatch =
    (await sql.get<{
      enabled: number;
      own_machines: number;
      updated_at: string;
      updated_by: string;
    }>(
      'SELECT enabled,own_machines,updated_at,updated_by FROM project_session_dispatch WHERE project_id=?',
      projectId,
    )) ?? null;
  const budgets = await sql.all(
    'SELECT scope_id,max_wall_ms,max_tokens,updated_at,updated_by FROM session_budgets WHERE project_id=? ORDER BY scope_id',
    projectId,
  );
  // Project and dependency budgets include work outside the converted set. A late usage
  // report or server-work settlement can change admission without changing any workflow.
  const usage = await sql.all(
    `SELECT session_id,instance_id,started_at,closed_at,wall_ms,input_tokens,output_tokens,reported_at
     FROM session_usage WHERE project_id=? AND kind='work' ORDER BY session_id`,
    projectId,
  );
  const serviceWork = await sql.all(
    `SELECT provider,operation_id,execution_epoch,sponsors_json,started_at,deadline,settled_at,outcome,wall_ms
     FROM session_service_work WHERE project_id=? ORDER BY provider,operation_id,execution_epoch`,
    projectId,
  );
  return {
    dispatch,
    budgets: { count: budgets.length, hash: digest(budgets) },
    accounting: {
      usage: { count: usage.length, hash: digest(usage) },
      serviceWork: { count: serviceWork.length, hash: digest(serviceWork) },
    },
    holds:
      await facts(`SELECT instance_id,revision,attempts,last_code,last_message,last_session_id,first_at,last_at,held_at
      FROM session_dispatch_holds WHERE project_id=? AND ${selected} ORDER BY instance_id,revision`),
    questions:
      await facts(`SELECT id,thread_id,session_id,instance_id,revision,question,asked_at,answered_at,answer_message_id
      FROM session_questions WHERE project_id=? AND ${selected} ORDER BY id`),
    waits:
      await facts(`SELECT id,thread_id,session_id,instance_id,revision,reason,targets_json,created_at,wait_until,settled_at,outcome
      FROM session_compute_waits WHERE project_id=? AND ${selected} ORDER BY id`),
    closures:
      await facts(`SELECT session_id,instance_id,revision,kind,outcome,started_at,closed_at,wall_ms,input_tokens,output_tokens,reported_at
      FROM session_usage WHERE project_id=? AND ${selected} ORDER BY session_id`),
    receipts:
      await facts(`SELECT d.session_id,d.runner_id,d.platform_json FROM session_dispatch_receipts d
      JOIN worker_sessions s ON s.id=d.session_id WHERE s.project_id=? AND s.${selected} ORDER BY d.session_id`),
    sessions:
      await facts(`SELECT id,instance_id,revision,thread_id,runner_id,owner_hash,kind,status,activated_at,closed_at,outcome
      FROM worker_sessions WHERE project_id=? AND ${selected} ORDER BY _merv_rowid`),
    conversations: await facts(`SELECT id,instance_id,status,latest_session_id,uploaded_at
      FROM session_threads WHERE project_id=? AND ${selected} ORDER BY id`),
  };
}
