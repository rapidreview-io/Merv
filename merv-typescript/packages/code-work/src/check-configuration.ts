import { z } from 'zod';
import {
  canonical,
  check,
  digest,
  idSchema,
  newId,
  now,
  recorded,
  type Caller,
  type Scope,
  type Sql,
  type State,
} from '@merv/contracts';
import { codeAdmissionLimitsSchema } from '@merv/code/store/protocol';
import { parseCodeInput } from '@merv/code/input';
import { OperationJournal } from '@merv/code/operation-journal';
import type { CodeStore } from '@merv/code/store/operations';
import type { CodeRepositoryConfigureInput } from './types.js';
import type { CodeCheckSpec, CodeStoreLimits } from './models.js';

/** The largest merged tree a project check may ship, so one upload is one page of parts. */
export const CODE_CHECK_SOURCE_MAX_BYTES = 128 * 1024 * 1024;
/**
 * How much longer than the command's own timeout a check is given: the archive, the upload,
 * provisioning a machine, restoring a snapshot, polling and tearing down all happen outside
 * the command, and a deadline that does not cover them turns every check into a re-rental.
 * It must also exceed the allowance an adapter adds to the command's timeout for setup on
 * the machine, or the lease and the reservation would end under a job still inside its own.
 */
export const CODE_CHECK_SLACK_SECONDS = 1500;

export const codeCheckSpecSchema = z
  .object({
    command: z.string().trim().min(1).max(4000),
    timeoutSeconds: z.number().int().min(30).max(3600),
    image: z
      .object({
        provider: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
        offerId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
        snapshotId: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
          .nullable(),
      })
      .strict(),
  })
  .strict() satisfies z.ZodType<CodeCheckSpec>;

const { denyGlobs, secretExemptGlobs } = codeAdmissionLimitsSchema.shape;
export const codeRepositoryConfigureInputSchema = z
  .object({
    denyGlobs,
    secretExemptGlobs,
    /**
     * Stated on every call, never defaulted: the lists here replace what was set, so a check
     * that could be left out would let an operator editing one glob switch verification off
     * and have every later base seal unchecked without anybody having typed that.
     */
    check: codeCheckSpecSchema.nullable(),
    requestId: idSchema,
  })
  .strict() satisfies z.ZodType<CodeRepositoryConfigureInput>;

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
