import type { ToolPolicy } from '@merv/contracts';

/** Explicit permissive policy for transport-only fixtures; authorization has separate integration tests. */
export const fixtureAccess: ToolPolicy = {
  allows: async () => true,
  require: async () => {},
  replace: () => {},
};
