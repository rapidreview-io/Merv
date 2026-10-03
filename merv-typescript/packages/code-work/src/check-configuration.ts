import {
  canonical,
  check,
  codeRepositoryConfigureInputSchema,
  digest,
  newId,
  now,
  recorded,
  type Caller,
  type CodeCheckSpec,
  type CodeStoreLimits,
  type Scope,
  type Sql,
  type State,
} from '@merv/contracts';
import { parseCodeInput } from '@merv/code/input';
import { OperationJournal } from '@merv/code/operation-journal';
import type { CodeStore } from '@merv/code/store/operations';

export async function initializeCheckConfiguration(state: State): Promise<void> {
  await state.migrate('code_research_check_configuration', [
    {
      version: 1,
      sql: `
CREATE TABLE code_research_check_configuration(project_id TEXT PRIMARY KEY,check_json TEXT NOT NULL);
INSERT INTO code_research_check_configuration(project_id,check_json)
SELECT project_id,COALESCE(limits_json::jsonb->'check','null'::jsonb)::text FROM code_projects;
`,
    },
  ]);
}
export async function projectCheck(sql: Sql, projectId: string): Promise<CodeCheckSpec | null> {
  const row = await sql.get<{ check_json: string }>(
    'SELECT check_json FROM code_research_check_configuration WHERE project_id=?',
    projectId,
  );
  return row ? JSON.parse(row.check_json) : null;
}
export async function configureWorkRepository(
  state: State,
  scope: Scope,
  store: CodeStore,
  caller: Caller,
  value: unknown,
): Promise<CodeStoreLimits> {
  caller = structuredClone(caller);
  const { requestId, ...body } = parseCodeInput(codeRepositoryConfigureInputSchema, value);
  return state.transaction(async (tx) => {
    await scope.require(caller, 'admin', tx);
    check(
      !caller.session,
      'session_forbidden',
      'A leased worker cannot configure this repository',
      403,
    );
    const journal = new OperationJournal(
      tx,
      caller.projectId,
      `actor:${caller.actorId}`,
      requestId,
      digest(body),
    );
    const previous = await journal.previous();
    if (previous) return JSON.parse(previous.result_json) as CodeStoreLimits;
    const limits = await store.setAdmission(
      caller,
      { denyGlobs: body.denyGlobs, secretExemptGlobs: body.secretExemptGlobs },
      tx,
    );
    await tx.run(
      'INSERT INTO code_research_check_configuration(project_id,check_json) VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET check_json=EXCLUDED.check_json',
      caller.projectId,
      canonical(body.check),
    );
    const result = { ...limits, check: body.check };
    const operationId = newId('cop');
    await journal.complete(operationId, 'configure', body, result, now());
    await recorded(state, tx, caller, 'code.repository_configured', caller.projectId, {
      operationId,
      check: body.check ? 'configured' : 'none',
      denyGlobs: limits.denyGlobs.length,
      secretExemptGlobs: limits.secretExemptGlobs.length,
    });
    return result;
  });
}
