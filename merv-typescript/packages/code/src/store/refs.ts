/** The workspace driver that checks out Code's repository: the capability a runner carrying it
 * advertises, and the key of the execution policies it serves. */
export const CODE_DRIVER = 'code.v2';

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
/** Where a unit's result is kept. The `accepted` segment is persisted in repositories and stays. */
export const resultRef = (unitId: string) => `refs/merv/accepted/${unitRef(unitId)}`;
/** The local branch a writer's checkout stands on; the mirror publishes it under the same name. */
export const workBranch = (unitId: string) => `merv/work/${unitRef(unitId)}`;

/** An opaque retained commit identity supplied by a repository consumer. */
export const retainedRef = (key: string) => `refs/merv/retained/${unitRef(key)}`;

/** Explicit retention destinations stay inside Code's namespace and obey Git ref syntax. */
export const validRetentionRef = (ref: string): boolean =>
  /^refs\/merv\/[A-Za-z0-9._/-]+$/.test(ref) &&
  !ref.includes('..') &&
  !ref.includes('//') &&
  !ref.endsWith('/') &&
  ref
    .split('/')
    .every((part) => !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'));
