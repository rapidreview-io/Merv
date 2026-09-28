import { check, MervError, type Sql, type State, type Transaction } from '@merv/contracts';
import type { Credential, CredentialStore } from '@merv/identity/credentials';

/** The ledger kinds Scope owns: independent actor credentials and user keys. */
export type LedgerKind = 'actor' | 'user-key';

/** One Scope credential row as the ledger records it: `subject` is the Scope row id. */
interface ScopeRow {
  subject: string;
  kind: LedgerKind;
  token_hash: string;
  expires_at: string | null;
  revoked_at: string | null;
}

const denied = 'Invalid or expired credential';
/** Scope rows whose hash the ledger does not record. A hash the ledger holds for another authority
 * is excluded too, so it cannot stop boot; `live` and `authenticate` keep it refused. */
const missing = `SELECT x.* FROM (
    SELECT id AS subject,'actor' AS kind,token_hash,expires_at,revoked_at FROM actor_credentials
    UNION ALL SELECT id,'user-key',token_hash,expires_at,revoked_at FROM user_keys) x
  WHERE NOT EXISTS (SELECT 1 FROM identity_credentials i WHERE i.token_hash=x.token_hash)`;

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

  /** Revokes a Scope credential in the ledger, first adopting a row an older image wrote after this
   * instance's boot pass, so the revocation is recorded even then. adopt is idempotent on the
   * hash and refuses one another authority holds (409); revoke keeps an earlier revocation.
   * Returns the ledger row as it was BEFORE this revocation. */
  async retire(
    kind: LedgerKind,
    row: { id: string; token_hash: string; expires_at: string | null },
    tx: Transaction,
  ): Promise<Credential> {
    const before = await this.store.adopt(
      {
        owner: 'scope',
        subject: row.id,
        kind,
        tokenHash: row.token_hash,
        expiresAt: row.expires_at,
        hardDeadline: row.expires_at,
      },
      tx,
    );
    await this.store.revoke(row.token_hash, 'scope', tx);
    return before;
  }

  /** The boot pass: adopts the Scope rows the ledger does not record yet, such as rows an older
   * image wrote, with their expiry and any revocation. It runs on every boot, not once, so rows
   * written during a rolling deploy are still picked up. It does not carry a Scope revocation onto
   * a row the ledger already holds: every Scope revocation retires its ledger row in the same
   * transaction, and Scope's own revoked_at is checked on every use as well. */
  async adoptMissing(state: State): Promise<void> {
    // Steady state: one scan with an indexed anti-join on the reader pool, and no writer lock.
    if (!(await state.read((sql) => sql.all(missing))).length) return;
    await state.transaction(async (tx) => {
      // Re-read under the lock: another instance may have adopted some rows meanwhile.
      for (const row of await tx.all<ScopeRow>(missing))
        try {
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
        } catch (error) {
          // Only the ledger's own validation names the row; State and connection errors pass through.
          if (
            error instanceof MervError &&
            (error.code === 'invalid_credential' || error.code === 'credential_conflict')
          )
            throw new MervError(
              'scope_ledger_adoption',
              `Scope credential ${row.subject} cannot be adopted into the credential ledger: ${error.message}`,
              500,
            );
          throw error;
        }
    });
  }
}
