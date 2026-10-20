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
  /** The directory's administrative record of one user, null when it has none; present only where
   *  the directory key is a service-role key (`directoryAdmin`). */
  directoryUser?(subject: string): Promise<DirectoryUser | null>;
}

/** What the directory says about one account, as agent sign-in needs it. */
export interface DirectoryUser {
  email: string;
  anonymous: boolean;
  confirmed: boolean;
  banned: boolean;
  deleted: boolean;
}

/** Trusted deployment configuration; secrets are environment references only. */
export interface IdentityConfig {
  supabaseUrl?: string;
  mode?: 'jwks' | 'hs256';
  secretEnv?: string;
  publishableKeyEnv?: string;
  directoryKeyEnv?: string;
  /** The directory key must be a service-role key, which reads the admin API (agent sign-in). */
  directoryAdmin?: boolean;
  allowLocalHttp?: boolean;
}

declare module 'cordis' {
  interface Context {
    identity: IdentityProvider;
  }
}
