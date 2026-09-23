/** Types of the managed-runner binding, kept free of runtime imports for the public type module. */
import type { DelegationSource, Transaction } from '@merv/contracts';
import type { RunnerPlatform, Session } from './types.js';

export interface ManagedRunnerBindingIdentity {
  allocationId: string;
  epoch: number;
  source: DelegationSource;
  runtimeProfileId: string;
  platform: RunnerPlatform;
  capabilities: string[];
  expiresAt: string;
}
export type ManagedRunnerValidator = {
  current(binding: ManagedRunnerBindingIdentity, tx: Transaction): Promise<boolean>;
  admits(allocationId: string, epoch: number, tx: Transaction): Promise<boolean>;
};
export type ManagedEnrollmentInput = Omit<ManagedRunnerBindingIdentity, 'capabilities'> & {
  capabilities?: string[];
};
export interface ManagedRunnerInspection {
  runnerId: string | null;
  session: {
    id: string;
    instanceId: string;
    expectedRevision: number;
    status: 'offered' | 'active' | 'released' | 'expired';
    closedAt: string | null;
    outcome: Session['outcome'];
    releaseAcknowledged: boolean;
    capturePending: boolean;
  } | null;
}
