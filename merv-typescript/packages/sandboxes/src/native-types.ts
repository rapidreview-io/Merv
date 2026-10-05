import type { Json } from '@merv/contracts';

export interface NativeMachineReads {
  list(projectId: string): Promise<Json[]>;
  record(projectId: string, id: string): Promise<Json | null>;
}

/** The work kinds the native service accepts; every workflow maps to one (nativeWorkKind). */
export type NativeWorkKind = 'task' | 'experiment';
/** The profiles a native assignment is issued with; `none` issues no assignment. */
export type NativeComputeProfile = 'execute' | 'check';

/**
 * What a unit may still ask Sandboxes directly. Sandboxes pins, attaches, fences, closes and
 * revokes native work itself (docs/COMPUTE_CAPABILITY.md); `connected` remains only for the
 * units' version selection until the older compute path is retired.
 */
export interface NativeSandboxesConfig {
  applicationId: string;
  applicationSecretEnv: string;
  encryptionKeyEnv: string;
  publicOrigin: string;
  managed?: { namespace: string; tokenEnv: string };
}

export interface NativeConnectionStatus {
  url: string | null;
  available: boolean;
  connected: boolean;
  connectionId: string | null;
  accountId: string | null;
  memberId: string | null;
  connectedAt: string | null;
  funding?: 'managed' | 'personal';
  managedAvailable?: boolean;
  allowance?: Json;
}
