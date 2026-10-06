import { check, type Sql, type Transaction } from '@merv/contracts';
import type { Credential, CredentialStore } from '@merv/identity/credentials';

/** The ledger kinds Scope owns: independent actor credentials and user keys. */
export type LedgerKind = 'actor' | 'user-key';

const denied = 'Invalid or expired credential';

/** Scope's only door to Identity's credential ledger. Scope rows are provenance; the ledger alone
 * decides liveness, and only for rows it records as Scope's own. */
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

  /** Liveness of one Scope row, which the ledger alone decides. Kind, owner and subject must all
   * agree (401 otherwise); a row of this credential that is no longer live is refused as
   * `refusal` says, 401 by default. */
  async live(
    tokenHash: string,
    kind: LedgerKind,
    subject: string,
    sql: Sql,
    refusal = { code: 'unauthorized', message: denied, status: 401 },
  ): Promise<Credential> {
    const credential = await this.store.read(tokenHash, sql);
    check(
      credential?.owner === 'scope' && credential.subject === subject && credential.kind === kind,
      'unauthorized',
      denied,
      401,
    );
    check(this.store.isLive(credential), refusal.code, refusal.message, refusal.status);
    return credential;
  }

  /** A hash's ledger row, live or not, whoever owns it; undefined when the ledger never held it. */
  async held(tokenHash: string, sql: Sql): Promise<Credential | undefined> {
    return await this.store.read(tokenHash, sql);
  }

  /** A bearer token's ledger row; callers still match its subject against their row id. */
  async authenticate(token: string, kind: LedgerKind): Promise<Credential> {
    const credential = await this.store.authenticate(token, kind);
    check(credential.owner === 'scope', 'unauthorized', denied, 401);
    return credential;
  }

  /** Revokes a Scope credential in the ledger and returns its ledger row as it was BEFORE this
   * revocation, which rotation checks; undefined when the ledger holds no row for it, which then
   * never authenticates. A hash another authority holds is refused (409); revoke keeps an
   * earlier revocation. */
  async retire(
    kind: LedgerKind,
    row: { id: string; token_hash: string },
    tx: Transaction,
  ): Promise<Credential | undefined> {
    const before = await this.store.read(row.token_hash, tx);
    check(
      !before || (before.owner === 'scope' && before.subject === row.id && before.kind === kind),
      'credential_conflict',
      'Credential token belongs to another authority',
      409,
    );
    await this.store.revoke(row.token_hash, 'scope', tx);
    return before;
  }
}
