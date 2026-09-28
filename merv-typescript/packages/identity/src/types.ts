import type { Sql, Transaction, VerifiedIdentity } from '@merv/contracts';
import type {} from 'cordis';

export interface Credential {
  id: string;
  tokenHash: string;
  owner: string;
  subject: string;
  kind: string;
  createdAt: string;
  expiresAt: string | null;
  hardDeadline: string | null;
  revokedAt: string | null;
}

export interface CredentialInput {
  owner: string;
  subject: string;
  kind: string;
  token?: string;
  prefix?: string;
  expiresAt: string | null;
  hardDeadline?: string | null;
}

export interface CredentialAuthority {
  issue(
    input: CredentialInput,
    tx?: Transaction,
  ): Promise<{ token: string; credential: Credential }>;
  adopt(
    input: Omit<CredentialInput, 'token' | 'prefix'> & {
      tokenHash: string;
      revokedAt?: string | null;
    },
    tx?: Transaction,
  ): Promise<Credential>;
  authenticate(token: string, kind: string | string[], tx?: Transaction): Promise<Credential>;
  authenticateHash(tokenHash: string, kind: string | string[], sql?: Sql): Promise<Credential>;
  renew(tokenHash: string, owner: string, expiresAt: string, tx?: Transaction): Promise<Credential>;
  revoke(tokenHash: string, owner: string, tx?: Transaction): Promise<Credential | undefined>;
  revokeSubject(owner: string, subject: string, kind: string, tx?: Transaction): Promise<void>;
}

export interface IdentityConfiguration {
  enabled: boolean;
  login?: { url: string; publishableKey: string };
}

export interface IdentityProvider {
  verify(token: string): Promise<VerifiedIdentity>;
  configuration(): IdentityConfiguration;
  /** Present when State is loaded; lifecycle owners also use the same store directly. */
  credentials?: CredentialAuthority;
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
