import type { VerifiedIdentity } from '@merv/contracts';
import type {} from 'cordis';

export interface IdentityConfiguration {
  enabled: boolean;
  login?: { url: string; publishableKey: string };
}

export interface IdentityProvider {
  /** Anonymous users are refused unless `allowAnonymous`: only a caller that binds a browser,
   *  never an account, opts in. */
  verify(token: string, options?: { allowAnonymous?: boolean }): Promise<VerifiedIdentity>;
  configuration(): IdentityConfiguration;
  findUserByEmail?(email: string): Promise<{ issuer: string; subject: string } | null>;
}

/** Trusted deployment configuration; secrets are environment references only. */
export interface IdentityConfig {
  supabaseUrl?: string;
  mode?: 'jwks' | 'hs256';
  secretEnv?: string;
  publishableKeyEnv?: string;
  directoryKeyEnv?: string;
  audience?: string;
  allowLocalHttp?: boolean;
}

declare module 'cordis' {
  interface Context {
    identity: IdentityProvider;
  }
}
