import { MervError } from '@merv/contracts';
import type { ToolPolicy } from '@merv/contracts';

/** Explicit permissive policy for transport-only fixtures; authorization has separate integration tests. */
export const fixtureAccess: ToolPolicy = {
  allows: async () => true,
  require: async () => {},
  replace: () => {},
  registerSessions: () => {
    throw new Error('Session integration requires a real Scope tool policy');
  },
  allowsTool: async (caller) => !caller.session,
  prepare: async (caller, tool, input) => {
    if (caller.session)
      throw new MervError('session_unavailable', 'No fixture session provider', 503);
    return { caller, tool, input };
  },
  validate: async (caller) => {
    if (caller.session)
      throw new MervError('session_unavailable', 'No fixture session provider', 503);
  },
  cancel: () => {},
  run: async (invocation, handler) => {
    if (invocation.caller.session)
      throw new MervError('session_unavailable', 'No fixture session provider', 503);
    return handler(invocation.caller, invocation.input);
  },
};
