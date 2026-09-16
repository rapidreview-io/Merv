import type { VerifiedIdentity } from '@merv/contracts';
import type {} from 'cordis';

export interface IdentityConfiguration {
  enabled: boolean;
  login?: { url: string; publishableKey: string };
}

export interface IdentityProvider {
  verify(token: string): Promise<VerifiedIdentity>;
  configuration(): IdentityConfiguration;
}

/** Trusted deployment configuration; secrets are environment references only. */
export interface IdentityConfig {
  supabaseUrl?: string;
  mode?: 'jwks' | 'hs256';
  secretEnv?: string;
  publishableKeyEnv?: string;
  audience?: string;
  allowLocalHttp?: boolean;
}

declare module 'cordis' {
  interface Context {
    identity: IdentityProvider;
  }
}
