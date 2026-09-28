import { check, type Sql, type Transaction } from '@merv/contracts';
import type { Credential, CredentialStore } from '@merv/identity/credentials';

/** The ledger kinds Scope owns: independent actor credentials and user keys. */
export type LedgerKind = 'actor' | 'user-key';

/** One Scope credential row as the ledger records it: `subject` is the Scope row id. */
export interface ScopeRow {
  subject: string;
  kind: LedgerKind;
  token_hash: string;
  expires_at: string | null;
  revoked_at: string | null;
}

const denied = 'Invalid or expired credential';

/** Scope's only door to Identity's credential ledger. Scope rows are provenance; the ledger
 * co-decides liveness, and only for rows it records as Scope's own. */
export class Ledger {
  constructor(private readonly store: CredentialStore) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  /** Mints a token; the returned hash is the one Scope stores (no second digest). */
  async issue(
    kind: LedgerKind,
    subject: string,
    expiresAt: string | null,
    tx: Transaction,
  ): Promise<{ token: string; tokenHash: string }> {
    const { token, credential } = await this.store.issue(
      {
        owner: 'scope',
        subject,
        kind,
        prefix: kind === 'user-key' ? 'mk_' : '',
        expiresAt,
        hardDeadline: expiresAt,
      },
      tx,
    );
    return { token, tokenHash: credential.tokenHash };
  }

  /** Liveness of one Scope row: kind, owner and subject must all agree (401 otherwise). */
  async live(tokenHash: string, kind: LedgerKind, subject: string, sql: Sql): Promise<Credential> {
    const credential = await this.store.authenticateHash(tokenHash, kind, sql);
    check(
      credential.owner === 'scope' && credential.subject === subject,
      'unauthorized',
      denied,
      401,
    );
    return credential;
  }

  /** A bearer token's ledger row; callers still match its subject against their row id. */
  async authenticate(token: string, kind: LedgerKind): Promise<Credential> {
    const credential = await this.store.authenticate(token, kind);
    check(credential.owner === 'scope', 'unauthorized', denied, 401);
    return credential;
  }

  /** Revokes a Scope row in the ledger. A hash the ledger never recorded is left as it is. */
  async revoke(tokenHash: string, tx: Transaction): Promise<void> {
    await this.store.revoke(tokenHash, 'scope', tx);
  }

  /** Records one Scope row in the ledger, with its expiry and any revocation (the boot pass). */
  async adopt(row: ScopeRow, tx: Transaction): Promise<void> {
    await this.store.adopt(
      {
        owner: 'scope',
        subject: row.subject,
        kind: row.kind,
        tokenHash: row.token_hash,
        expiresAt: row.expires_at,
        hardDeadline: row.expires_at,
        revokedAt: row.revoked_at,
      },
      tx,
    );
  }
}
