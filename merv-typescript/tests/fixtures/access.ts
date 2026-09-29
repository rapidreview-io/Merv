import type { ToolPolicy } from '@merv/contracts';

/** Explicit permissive policy for transport-only fixtures; authorization has separate integration tests. */
export const fixtureAccess: ToolPolicy = {
  granted: async () => () => true,
  require: async () => {},
  replace: () => {},
};
