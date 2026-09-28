import type { Permission, Role } from '@merv/contracts';

export const roles: readonly Role[] = ['operator', 'producer', 'reviewer', 'reader'];
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

/** A service's role follows from its provider; scope@9's trigger holds the same rule. */
export const serviceRole = (provider: string): 'producer' | 'reviewer' =>
  provider === 'fleet-review' ? 'reviewer' : 'producer';

/** An actor with the person it acts for, if any; append `WHERE …` on `a`. */
export const ACTOR_WITH_MEMBER = `SELECT a.*,m.issuer AS user_issuer,m.subject AS user_subject FROM actors a
  LEFT JOIN member_actors m ON m.actor_id=a.id`;
