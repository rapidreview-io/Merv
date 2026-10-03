import { check, digest, type Sql } from '@merv/contracts';

/** The project creator owns its managed allowance. Readers, agents and later
 * collaborators never select a payer or mint a new allowance by opening a project. */
export async function managedAccountSubject(projectId: string, tx: Sql): Promise<string> {
  const owner = await tx.get<{ issuer: string; subject: string }>(
    'SELECT issuer,subject FROM user_project_requests WHERE project_id=?',
    projectId,
  );
  check(owner, 'compute_account_missing', 'This project has no managed billing account', 409);
  return `merv_account_${digest([owner.issuer, owner.subject])}`;
}
