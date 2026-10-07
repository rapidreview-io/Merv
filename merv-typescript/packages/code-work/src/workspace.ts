import { CODE_DRIVER } from '@merv/contracts';
import type { WorkflowWorkspacePolicy } from '@merv/contracts';

/**
 * The checkout a step of Code-managed work runs in. Work keeps one persistent checkout per
 * unit on the base it was given, which the server, not the session, moves central; a review
 * reads an ephemeral checkout of the code under review and keeps nothing. A step that only
 * reads the base its work was given, such as a design written against the code that will run,
 * gets the same ephemeral checkout of that base (`read`).
 */
export function codeWorkspace(
  purpose: 'work' | 'review' | 'read',
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
        base: purpose === 'read' ? 'reference:base' : 'reference:code',
        retain: false,
        driver: CODE_DRIVER,
      };
}
