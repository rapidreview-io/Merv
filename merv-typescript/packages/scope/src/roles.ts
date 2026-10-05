import type { Permission, Role } from '@merv/contracts';

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

/** An actor with the person it acts for, if any; append `WHERE …` on `a`. */
export const ACTOR_WITH_MEMBER = `SELECT a.*,m.issuer AS user_issuer,m.subject AS user_subject FROM actors a
  LEFT JOIN member_actors m ON m.actor_id=a.id`;
