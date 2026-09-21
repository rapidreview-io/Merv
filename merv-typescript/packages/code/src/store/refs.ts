/**
 * A unit id as one segment of a ref name. Git forbids `..`, a trailing dot and `.lock`; an id
 * that would break those rules is carried encoded, and the prefix is reserved so that a
 * literal id can never collide with an encoded one. A workspace driver derives the same name.
 */
export const unitRef = (unitId: string): string =>
  unitId.includes('..') ||
  unitId.endsWith('.') ||
  unitId.endsWith('.lock') ||
  unitId.startsWith('encoded-') ||
  !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(unitId)
    ? `encoded-${Buffer.from(unitId).toString('base64url')}`
    : unitId;
export const workRef = (unitId: string) => `refs/merv/work/${unitRef(unitId)}`;
export const acceptedRef = (unitId: string) => `refs/merv/accepted/${unitRef(unitId)}`;
/** The local branch a writer's checkout stands on; the mirror publishes it under the same name. */
export const workBranch = (unitId: string) => `merv/work/${unitRef(unitId)}`;
