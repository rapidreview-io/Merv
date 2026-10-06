import type { WorkflowWorkspacePolicy } from '@merv/contracts';
import { CODE_DRIVER } from '@merv/code/store/refs';

export { CODE_DRIVER };

/**
 * The checkout a step of Code-managed work runs in. Work keeps one persistent checkout per
 * unit on the base it was given, which the server, not the session, moves central; a review
 * reads an ephemeral checkout of the code under review and keeps nothing.
 */
export function codeWorkspace(
  purpose: 'work' | 'review',
  namespace: string,
): WorkflowWorkspacePolicy {
  return purpose === 'work'
    ? {
        mode: 'persistent',
        namespace,
        base: 'reference:base',
        perBase: false,
        retain: true,
        advancesCentral: false,
        driver: CODE_DRIVER,
      }
    : {
        mode: 'ephemeral',
        namespace,
        base: 'reference:code',
        retain: false,
        driver: CODE_DRIVER,
      };
}
