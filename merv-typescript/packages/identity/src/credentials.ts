import { randomBytes } from 'node:crypto';
import { check, newId, sha256Hex, type Sql, type State, type Transaction } from '@merv/contracts';

/** The one token digest. Owners store and compare only this. */
export const tokenDigest = sha256Hex;

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

interface Row {
  id: string;
  token_hash: string;
  owner: string;
  subject: string;
  kind: string;
  created_at: string;
  expires_at: string | null;
  hard_deadline: string | null;
  revoked_at: string | null;
}

const migration = `
CREATE TABLE identity_credentials (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  owner TEXT NOT NULL,
  subject TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  hard_deadline TEXT,
  revoked_at TEXT,
  CONSTRAINT identity_credentials_expiry CHECK (
    hard_deadline IS NULL OR (expires_at IS NOT NULL AND expires_at <= hard_deadline)
  )
);
CREATE INDEX identity_credentials_subject ON identity_credentials(owner,subject,kind);
CREATE OR REPLACE FUNCTION identity_credentials_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.token_hash IS DISTINCT FROM OLD.token_hash OR
     NEW.owner IS DISTINCT FROM OLD.owner OR NEW.subject IS DISTINCT FROM OLD.subject OR
     NEW.kind IS DISTINCT FROM OLD.kind OR NEW.created_at IS DISTINCT FROM OLD.created_at OR
     NEW.hard_deadline IS DISTINCT FROM OLD.hard_deadline OR
     (OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) OR
     (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND NEW.expires_at IS DISTINCT FROM OLD.expires_at) OR
     (NEW.expires_at IS DISTINCT FROM OLD.expires_at AND
       (OLD.expires_at IS NULL OR NEW.expires_at IS NULL OR NEW.expires_at <= OLD.expires_at)) THEN
    RAISE EXCEPTION USING MESSAGE = 'Identity credential authority is immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER identity_credentials_immutable BEFORE UPDATE ON identity_credentials
FOR EACH ROW EXECUTE FUNCTION identity_credentials_guard();
CREATE OR REPLACE FUNCTION identity_credentials_no_delete() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Identity credential history is retained', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER identity_credentials_no_delete BEFORE DELETE ON identity_credentials
FOR EACH ROW EXECUTE FUNCTION identity_credentials_no_delete();
`;

const find = async (sql: Sql, tokenHash: string) =>
  await sql.get<Row>('SELECT * FROM identity_credentials WHERE token_hash=?', tokenHash);
/** The one validity rule: not revoked, and neither the expiry nor the hard deadline reached. */
const live = (row: Row, now: string) =>
  row.revoked_at === null &&
  (row.expires_at === null || row.expires_at > now) &&
  (row.hard_deadline === null || row.hard_deadline > now);
const record = (row: Row): Credential =>
  Object.freeze({
    id: row.id,
    tokenHash: row.token_hash,
    owner: row.owner,
    subject: row.subject,
    kind: row.kind,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    hardDeadline: row.hard_deadline,
    revokedAt: row.revoked_at,
  });
const identifier = (value: string) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
const validHash = (value: string) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const validToken = (value: string) =>
  typeof value === 'string' && value.length >= 16 && value.length <= 512 && /^[!-~]+$/.test(value);
const validDate = (value: string | null) =>
  value === null ||
  (typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value);

/** A shared hash-only credential ledger. Lifecycle services remain responsible for live authority. */
export class CredentialStore {
  constructor(
    private readonly state: State,
    private readonly clock: () => number = Date.now,
  ) {}

  async initialize(): Promise<void> {
    await this.state.migrate('identity-credentials', [{ version: 1, sql: migration }]);
  }

  private now(): string {
    return new Date(this.clock()).toISOString();
  }

  private async write<T>(tx: Transaction | undefined, fn: (tx: Transaction) => Promise<T>) {
    if (tx) {
      this.state.assertTransaction(tx);
      return await fn(tx);
    }
    return await this.state.transaction(fn);
  }

  private input(input: Omit<CredentialInput, 'token' | 'prefix'>): void {
    check(
      identifier(input.owner) && identifier(input.subject) && identifier(input.kind),
      'invalid_credential',
      'Invalid credential identity',
    );
    const deadline = input.hardDeadline ?? null;
    check(
      validDate(input.expiresAt) && validDate(deadline),
      'invalid_credential',
      'Invalid credential deadline',
    );
    check(
      deadline === null || (input.expiresAt !== null && input.expiresAt <= deadline),
      'invalid_credential',
      'Credential expiry exceeds its hard deadline',
    );
  }

  async issue(
    input: CredentialInput,
    tx?: Transaction,
  ): Promise<{ token: string; credential: Credential }> {
    this.input(input);
    check(
      input.token === undefined || input.prefix === undefined,
      'invalid_credential',
      'Supply either an existing token or a prefix',
    );
    check(
      input.prefix === undefined ||
        input.prefix === '' ||
        /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(input.prefix),
      'invalid_credential',
      'Invalid credential prefix',
    );
    const token = input.token ?? `${input.prefix ?? 'mi_'}${randomBytes(32).toString('base64url')}`;
    check(validToken(token), 'invalid_credential', 'Invalid credential token');
    check(
      input.expiresAt === null || input.expiresAt > this.now(),
      'invalid_credential',
      'Credential has already expired',
    );
    const tokenHash = tokenDigest(token);
    const credential = await this.write(tx, async (sql) => {
      const id = newId('identity_credential');
      const createdAt = this.now();
      const inserted = await sql.run(
        'INSERT INTO identity_credentials(id,token_hash,owner,subject,kind,created_at,expires_at,hard_deadline,revoked_at) VALUES(?,?,?,?,?,?,?,?,NULL) ON CONFLICT(token_hash) DO NOTHING',
        id,
        tokenHash,
        input.owner,
        input.subject,
        input.kind,
        createdAt,
        input.expiresAt,
        input.hardDeadline ?? null,
      );
      check(
        inserted.changes === 1,
        'credential_conflict',
        'Credential token was already issued',
        409,
      );
      return record({
        id,
        token_hash: tokenHash,
        owner: input.owner,
        subject: input.subject,
        kind: input.kind,
        created_at: createdAt,
        expires_at: input.expiresAt,
        hard_deadline: input.hardDeadline ?? null,
        revoked_at: null,
      });
    });
    return { token, credential };
  }

  async adopt(
    input: Omit<CredentialInput, 'token' | 'prefix'> & {
      tokenHash: string;
      revokedAt?: string | null;
    },
    tx?: Transaction,
  ): Promise<Credential> {
    this.input(input);
    check(
      validHash(input.tokenHash) && validDate(input.revokedAt ?? null),
      'invalid_credential',
      'Invalid credential history',
    );
    return await this.write(tx, async (sql) => {
      const id = newId('identity_credential');
      const createdAt = this.now();
      await sql.run(
        'INSERT INTO identity_credentials(id,token_hash,owner,subject,kind,created_at,expires_at,hard_deadline,revoked_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(token_hash) DO NOTHING',
        id,
        input.tokenHash,
        input.owner,
        input.subject,
        input.kind,
        createdAt,
        input.expiresAt,
        input.hardDeadline ?? null,
        input.revokedAt ?? null,
      );
      let row = await find(sql, input.tokenHash);
      check(
        row &&
          row.owner === input.owner &&
          row.subject === input.subject &&
          row.kind === input.kind,
        'credential_conflict',
        'Credential token belongs to another authority',
        409,
      );
      // Carry a revocation the owner recorded later. Adoption never revives or extends.
      if (input.revokedAt && row.revoked_at === null)
        row = (await sql.get<Row>(
          'UPDATE identity_credentials SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL RETURNING *',
          input.revokedAt,
          input.tokenHash,
        ))!;
      return record(row);
    });
  }

  async authenticate(
    token: string,
    kind: string | string[],
    tx?: Transaction,
  ): Promise<Credential> {
    check(validToken(token), 'unauthorized', 'Invalid credential', 401);
    return await this.authenticateHash(tokenDigest(token), kind, tx);
  }

  /** Recheck a credential on a prepared caller in the authorization transaction. */
  async authenticateHash(
    tokenHash: string,
    kind: string | string[],
    sql?: Sql,
  ): Promise<Credential> {
    const kinds = Array.isArray(kind) ? kind : [kind];
    check(
      validHash(tokenHash) && kinds.length > 0 && kinds.every(identifier),
      'unauthorized',
      'Invalid credential',
      401,
    );
    const lookup = async (reader: Sql) => {
      const row = await find(reader, tokenHash);
      check(
        row && kinds.includes(row.kind) && live(row, this.now()),
        'unauthorized',
        'Invalid or expired credential',
        401,
      );
      return record(row);
    };
    return sql ? await lookup(sql) : await this.state.read(lookup);
  }

  async renew(
    tokenHash: string,
    owner: string,
    expiresAt: string,
    tx?: Transaction,
  ): Promise<Credential> {
    check(
      validHash(tokenHash) && identifier(owner) && validDate(expiresAt) && expiresAt !== null,
      'invalid_credential',
      'Invalid credential renewal',
    );
    return await this.write(tx, async (sql) => {
      const row = await find(sql, tokenHash);
      const now = this.now();
      check(row && row.owner === owner, 'credential_forbidden', 'Credential owner mismatch', 403);
      check(
        row.hard_deadline !== null,
        'invalid_credential',
        'Only a credential with a hard deadline can be renewed',
      );
      check(
        live(row, now) && row.expires_at !== null,
        'unauthorized',
        'Credential cannot be renewed',
        401,
      );
      check(
        expiresAt > now && expiresAt <= row.hard_deadline,
        'invalid_credential',
        'Renewal exceeds the hard deadline',
      );
      if (expiresAt <= row.expires_at) return record(row);
      const renewed = await sql.get<Row>(
        'UPDATE identity_credentials SET expires_at=? WHERE token_hash=? AND owner=? AND revoked_at IS NULL AND expires_at<? RETURNING *',
        expiresAt,
        tokenHash,
        owner,
        expiresAt,
      );
      check(renewed, 'credential_conflict', 'Credential changed during renewal', 409);
      return record(renewed);
    });
  }

  /** Idempotent; keeps the first revocation time. A hash never issued or adopted returns undefined. */
  async revoke(
    tokenHash: string,
    owner: string,
    tx?: Transaction,
  ): Promise<Credential | undefined> {
    check(
      validHash(tokenHash) && identifier(owner),
      'invalid_credential',
      'Invalid credential revocation',
    );
    return await this.write(tx, async (sql) => {
      const row = await sql.get<Row>(
        'UPDATE identity_credentials SET revoked_at=COALESCE(revoked_at,?) WHERE token_hash=? AND owner=? RETURNING *',
        this.now(),
        tokenHash,
        owner,
      );
      if (row) return record(row);
      check(
        !(await find(sql, tokenHash)),
        'credential_forbidden',
        'Credential owner mismatch',
        403,
      );
      return undefined;
    });
  }

  async revokeSubject(
    owner: string,
    subject: string,
    kind: string,
    tx?: Transaction,
  ): Promise<void> {
    check(
      identifier(owner) && identifier(subject) && identifier(kind),
      'invalid_credential',
      'Invalid credential owner or subject',
    );
    await this.write(tx, async (sql) => {
      await sql.run(
        'UPDATE identity_credentials SET revoked_at=? WHERE owner=? AND subject=? AND kind=? AND revoked_at IS NULL',
        this.now(),
        owner,
        subject,
        kind,
      );
    });
  }
}
