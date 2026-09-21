import type { State } from '@merv/contracts';

/**
 * A project already bound to its runner's repository. code.local.bind takes a signed-in human
 * administrator, which a fixture built on bootstrap actor credentials does not have, and its
 * authority and replay are covered in tests/code-units.test.ts; tests of the work that follows
 * a binding write the row that call leaves behind.
 */
export async function boundProject(
  state: State,
  projectId: string,
  mainOid: string,
  repositoryId = 'runner-private-repository',
): Promise<void> {
  const at = new Date().toISOString();
  await state.transaction(
    async (tx) =>
      await tx.run(
        'INSERT INTO code_projects (project_id,mode,repository_id,binding_json,main_json,limits_json,warnings_json,updated_at) VALUES (?,?,?,?,?,?,?,?)',
        projectId,
        'local',
        repositoryId,
        JSON.stringify({ boundAt: at, boundBy: 'fixture', operationId: 'cop_fixture' }),
        JSON.stringify({
          admittedAt: at,
          admittedBy: 'fixture',
          oid: mainOid,
          operationId: 'cop_fixture',
        }),
        '{}',
        '[]',
        at,
      ),
  );
}
