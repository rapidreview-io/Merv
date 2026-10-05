import { check, digest, type Scope, type Transaction } from '@merv/contracts';

/** The project creator owns its managed allowance. Readers, agents and later
 * collaborators never select a payer or mint a new allowance by opening a project. */
export async function managedAccountSubject(
  scope: Scope,
  projectId: string,
  tx: Transaction,
): Promise<string> {
  const owner = await scope.projectCreator(projectId, tx);
  check(owner, 'compute_account_missing', 'This project has no managed billing account', 409);
  return `merv_account_${digest([owner.issuer, owner.subject])}`;
}
