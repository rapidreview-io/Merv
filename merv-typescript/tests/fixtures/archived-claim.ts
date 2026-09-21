import { newId, now, type Caller, type State } from '@merv/contracts';
import type { Claim } from '@merv/claims/types';

/** Seed retained pre-retirement data; this is deliberately not an application write API. */
export async function seedArchivedClaim(
  state: State,
  caller: Caller,
  input: {
    statement: string;
    scope?: string;
    status?: Claim['status'];
    confidence?: Claim['confidence'];
    requestId?: string;
  },
): Promise<Claim> {
  const at = now();
  const claim: Claim = {
    id: newId('claim'),
    projectId: caller.projectId,
    statement: input.statement,
    scope: input.scope ?? '',
    status: input.status ?? 'active',
    confidence: input.confidence ?? 'medium',
    revision: 0,
    createdBy: caller.actorId,
    updatedBy: caller.actorId,
    createdAt: at,
    updatedAt: at,
  };
  await state.transaction((tx) =>
    tx.run(
      'INSERT INTO claims(id,project_id,statement,scope,status,confidence,revision,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      claim.id,
      claim.projectId,
      claim.statement,
      claim.scope,
      claim.status,
      claim.confidence,
      claim.revision,
      claim.createdBy,
      claim.updatedBy,
      at,
      at,
    ),
  );
  return claim;
}
