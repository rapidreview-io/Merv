import type { Caller, DelegationSource, Permission, Role } from '@merv/contracts/scope-models';

// Scope's role and delegation rules: pure, so any unit may run them.

/** The roles a worker session's actor or an agent may hold: never an operator's. */
export const workerRoles: readonly Exclude<Role, 'operator'>[] = ['producer', 'reviewer', 'reader'];

export const permits = (role: Role, permission: Permission): boolean =>
  permission === 'read' ||
  role === 'operator' ||
  (permission === 'write' && role === 'producer') ||
  (permission === 'review' && role === 'reviewer');

/** The permission a worker role's delegator must hold to hand that role on. */
export const needs = (role: Exclude<Role, 'operator'>): Permission =>
  role === 'producer' ? 'write' : role === 'reviewer' ? 'review' : 'read';

/** The caller a delegation source acts as, for work done later on its behalf. */
export function sourceCaller(source: DelegationSource): Caller {
  const base = { actorId: source.actorId, projectId: source.projectId };
  if (source.kind === 'actor') return { ...base, credentialId: source.credentialId };
  if (source.kind === 'key')
    return { ...base, key: { id: source.keyId, membershipId: source.membershipId } };
  if (source.kind === 'service') return { ...base, service: { vouchedBy: source.vouchedBy } };
  // Delegation follows the captured membership epoch, not the original short-lived login JWT.
  return {
    ...base,
    human: {
      issuer: source.issuer,
      subject: source.subject,
      membershipId: source.membershipId,
      expiresAt: '9999-12-31T23:59:59.999Z',
    },
  };
}
/** When a delegation lapses by itself: a person's never, a service's with its voucher's. */
export const delegationEnd = (source: DelegationSource): number =>
  source.kind === 'service'
    ? delegationEnd(source.vouchedBy)
    : source.kind !== 'human' && source.expiresAt
      ? Date.parse(source.expiresAt)
      : Infinity;
