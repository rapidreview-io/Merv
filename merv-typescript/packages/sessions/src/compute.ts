import type { WorkflowExecutionPolicy } from '@merv/contracts';

export type ComputeProfile = 'execute' | 'plan' | 'check' | 'none';

export function computeProfile(
  policy: WorkflowExecutionPolicy,
  override?: unknown,
): ComputeProfile {
  if (override !== undefined)
    return override === 'execute' || override === 'plan' || override === 'check'
      ? override
      : 'none';
  return !policy.readOnly && policy.workspace?.mode === 'persistent' ? 'execute' : 'check';
}

export function computeEpoch(data: Record<string, unknown>, revision: number): string {
  const value = data.computeEpoch;
  return typeof value === 'string' && /^[\x21-\x7e]{1,256}$/.test(value) ? value : String(revision);
}

export function computeGuidance(profile: ComputeProfile): string {
  if (profile === 'none') return '';
  return (
    'Use the Sandboxes MCP connection for this work. Inspect existing machines and jobs before renting or rerunning: rentals and accepted jobs survive worker handoff within the same compute epoch. Keep stable idempotency keys only when recovering the same request. New or revised work needs a new key. Save useful paths and progress for your successor; release unused machines. Retain important files through workflow Capture nodes; verified captures register as Merv artifact collections. Check capture outcomes and use artifact.read for registered evidence. A Snapshot alone does not count as retained evidence. Files only on a machine disappear on release or expiry.' +
    (profile === 'check'
      ? ' Use compute for brief verification only, with job timeouts of at most 300 seconds. Do not run full workloads or change submitted evidence.'
      : profile === 'plan'
        ? " Measure what the design needs instead of guessing: rent machines, GPUs included, and storage for bounded feasibility probes such as loading the pinned model and timing a few training steps for memory and step time. Keep each probe within an hour and a few dollars, release machines when done, and retain the measurements as plan or feasibility evidence. Do not run full training or evaluation, and keep no probe checkpoint as the experiment's model."
        : ' Execute only the authorized work and plan, within the account allowance. Emit unbuffered progress and inspect job output and exit status.')
  );
}
