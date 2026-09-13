import type { Caller } from '@merv/contracts';
import type {} from 'cordis';

export interface CredentialBinding {
  id: string;
  projectId: string;
  actorId: string;
  mountId: string;
  secretRef: string;
  headers?: Record<string, string>;
}
export interface ResolvedCredential {
  readonly identityKey: string;
  /** Explicit server-side access; callers must not serialize or log these headers. */
  headers(): Readonly<Record<string, string>>;
}
export interface CredentialProvider {
  resolve(caller: Caller, mountId: string): ResolvedCredential;
  /** Trusted in-process configuration replacement; never an agent-facing operation. */
  replace(bindings: CredentialBinding[]): void;
}
export interface CredentialsConfig {
  bindings?: CredentialBinding[];
}
declare module 'cordis' {
  interface Context {
    credentials: CredentialProvider;
  }
}
