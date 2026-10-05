import type { Json } from '@merv/contracts';

export interface NativeMachineReads {
  list(projectId: string): Promise<Json[]>;
  record(projectId: string, id: string): Promise<Json | null>;
}

/** The work kinds the native service accepts; every workflow maps to one (nativeWorkKind). */
export type NativeWorkKind = 'task' | 'experiment';
/** The native application Sandboxes pins, attaches, fences, closes and revokes work through
 * (docs/COMPUTE_CAPABILITY.md). */
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
