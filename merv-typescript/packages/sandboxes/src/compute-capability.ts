import type { WorkflowExecutionPolicy } from '@merv/contracts';

/**
 * Compute as a capability of a leased assignment, for any workflow. Pure: units import it to
 * render guidance, and Sandboxes applies the same rule when it attaches a launch connection.
 * See docs/COMPUTE_CAPABILITY.md.
 */
export type ComputeProfile = 'execute' | 'check' | 'none';
export const COMPUTE_PROFILES: readonly ComputeProfile[] = ['execute', 'check', 'none'];

/**
 * The profile of one assignment. A unit may name it with the `computeProfile` reference;
 * otherwise a writable assignment with a persistent workspace executes and every other one
 * checks. An override that names no profile grants nothing.
 */
export function computeProfile(
  policy: WorkflowExecutionPolicy,
  override?: unknown,
): ComputeProfile {
  if (override !== undefined)
    return COMPUTE_PROFILES.includes(override as ComputeProfile)
      ? (override as ComputeProfile)
      : 'none';
  return !policy.readOnly && policy.workspace?.mode === 'persistent' ? 'execute' : 'check';
}

/** A string epoch a unit may set in workflow data; anything else falls back to the revision. */
const epochPattern = /^[\x21-\x7e]{1,256}$/;
/**
 * The work's compute epoch: workflow data `computeEpoch` when the unit sets one, else the
 * revision. Machines and jobs started under an older epoch are cancelled.
 */
export function computeEpoch(data: Record<string, unknown>, revision: number): string {
  const value = data.computeEpoch;
  return typeof value === 'string' && epochPattern.test(value) ? value : String(revision);
}

/** Assignment overlay only; tool schemas and operational instructions come from native MCP. */
export function computeGuidance(profile: ComputeProfile): string {
  if (profile === 'none') return '';
  return (
    '\nUse the native Sandboxes MCP connection for this work. Inspect existing machines and jobs before renting or rerunning: rentals and accepted jobs survive worker handoff. Keep stable idempotency keys only when recovering the same request. New or revised work needs a new key, even within the same attempt. Save useful paths and progress for your successor; release unused machines. Retain important files through explicit workflow Capture nodes; captured files register as Merv artifact collections without another upload. Native outputs shortcuts also create a temporary Snapshot, whose artifact_id is not a Merv collection ID and may incur a second upload. Check capture outcomes and use artifact.read for registered evidence; a Snapshot alone does not count as retained evidence. Files only on a machine disappear on release or expiry.' +
    (profile === 'check'
      ? ' This assignment permits brief verification only: jobs on existing rentals need a positive timeout of at most 300 seconds. Do not run long or full workloads, change submitted evidence, or treat a short check as design approval. SSH also remains for brief checks; a certificate does not make arbitrary commands safe.'
      : ' Execute only the authorized work and plan, within the account allowance. Emit unbuffered progress and inspect native job output and exit status.')
  );
}
