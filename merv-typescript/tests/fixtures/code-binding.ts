import type { State, Transaction } from '@merv/contracts';

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
  /** The repositories this project was bound to before, as a rebind would have left them. */
  previous: { repositoryId: string }[] = [],
): Promise<void> {
  const at = new Date().toISOString();
  await state.transaction(
    async (tx) =>
      await tx.run(
        'INSERT INTO code_projects (project_id,mode,repository_id,binding_json,main_json,limits_json,warnings_json,updated_at) VALUES (?,?,?,?,?,?,?,?)',
        projectId,
        'local',
        repositoryId,
        JSON.stringify({
          boundAt: at,
          boundBy: 'fixture',
          operationId: 'cop_fixture',
          ...(previous.length
            ? {
                previous: previous.map((entry) => ({
                  ...entry,
                  boundBy: 'fixture',
                  boundAt: at,
                  operationId: 'cop_fixture',
                  reboundBy: 'fixture',
                  reboundAt: at,
                  reason: 'fixture',
                })),
              }
            : {}),
        }),
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

/**
 * Main named as `mainOid`, the project bound to `repositoryId` first where it is not yet, as
 * code.local.bind once did; only preparing a linked repository moves main now. Work already
 * pinned keeps its base. `stored` says Code's own repository holds that commit; `changed` runs in
 * the same transaction, as Code's own notice of the move did (CodeWriterService.changed).
 */
export async function moveMain(
  state: State,
  projectId: string,
  mainOid: string,
  {
    repositoryId = 'runner-private-repository',
    stored = true,
    changed,
  }: { repositoryId?: string; stored?: boolean; changed?: (tx: Transaction) => Promise<void> } = {},
): Promise<void> {
  const at = new Date().toISOString();
  const main = JSON.stringify({
    admittedAt: at,
    admittedBy: 'fixture',
    oid: mainOid,
    operationId: 'cop_fixture',
    ...(stored && { stored: true }),
  });
  await state.transaction(async (tx) => {
    const moved = await tx.run(
      'UPDATE code_projects SET main_json=?,updated_at=? WHERE project_id=?',
      main,
      at,
      projectId,
    );
    if (!moved.changes)
      await tx.run(
        'INSERT INTO code_projects (project_id,mode,repository_id,binding_json,main_json,limits_json,warnings_json,updated_at) VALUES (?,?,?,?,?,?,?,?)',
        projectId,
        'local',
        repositoryId,
        JSON.stringify({
          boundAt: at,
          boundBy: 'fixture',
          operationId: 'cop_fixture',
          managed: true,
        }),
        main,
        '{}',
        '[]',
        at,
      );
    await changed?.(tx);
  });
}

/** Code's required settings, its repository root under a directory the test removes. */
export const codeConfig = (root: string) => ({
  repositories: { root, quotaBytes: 1024 ** 3, reservedFreeBytes: 1 },
});
