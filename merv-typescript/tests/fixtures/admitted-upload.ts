import type { State } from '@merv/contracts';

/**
 * What Code records once it admitted a session's upload for a commit command: the one thing a
 * commit receipt succeeds on. For tests of what a succeeded command means, not of uploads.
 */
export async function admitUpload(
  state: State,
  command: { id: string; projectId: string; sessionId: string; instanceId: string },
  head: string,
): Promise<void> {
  await state.transaction((tx) =>
    tx.run(
      "INSERT INTO code_operations(id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at,unit_id) VALUES (?,?,?,?,'upload','hash','{}','completed',?,'now','now',?)",
      `cop_admitted_${command.id}`,
      command.projectId,
      `session:${command.sessionId}`,
      command.id,
      JSON.stringify({ head }),
      command.instanceId,
    ),
  );
}
