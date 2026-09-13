import type { AccessPolicy } from '@merv/access/types';

/** Explicit permissive policy for transport-only fixtures; authorization has separate integration tests. */
export const fixtureAccess: AccessPolicy = {
  allows: () => true,
  require: () => {},
  replace: () => {},
};
