import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { check, digest, type State, type Transaction } from '@merv/contracts';
import type { DataRequirement, ExperimentPlan, ValidatedDataset } from './types.js';

export interface UploadRecord {
  id: string;
  requirement: DataRequirement;
  requirementHash: string;
  filename: string;
  sha256: string;
  size: number;
  status: 'pending' | 'validated' | 'invalid';
  validation?: ValidatedDataset;
  error?: string;
}
export interface RequestRecord {
  id: string;
  clientRequest: string;
  title: string;
  createdAt: string;
  expiresAt: string;
  projectId?: string;
  experimentId?: string;
  conversationId?: string;
  /** The request files the intake agent was last told of (keys and ETags), for its next turn. */
  toldFiles?: string[];
  bucketReady?: boolean;
  draft?: ExperimentPlan;
  uploads: UploadRecord[];
  checkout?: {
    contractHash: string;
    generation: number;
    id?: string;
    previousId?: string;
    url?: string;
    expiresAt?: number;
  };
  notifiedContract?: string;
  /** Queued transactionally with payment; retried until the submission email is sent. */
  submissionEmailPending?: boolean;
  email?: string;
  submissionKey?: string;
  notifiedSubmission?: string;
  /** Worker questions the service answered to resume this request's paid run. */
  resumed?: string[];
}
/** The customer's browser sign-in, which service_experiment@3 requires beside the capability. */
export interface IdentityBinding {
  issuer: string;
  subject: string;
  boundAt: string;
}
/** A proposed plan waits for its customer to approve it, an approved one for their payment. */
const WAITS = new Map<string, 'approval' | 'payment'>([
  ['ready', 'approval'],
  ['awaiting_payment', 'payment'],
]);
export class RequestStore {
  constructor(
    readonly state: State,
    private readonly key: string,
  ) {
    check(
      Buffer.byteLength(key) >= 32,
      'customer_configuration',
      'Customer access key needs at least 32 bytes',
      503,
    );
  }
  async initialize() {
    await this.state.migrate('customer-experiment-access', {
      1: `
      CREATE TABLE customer_experiment_requests(id TEXT PRIMARY KEY, client_request TEXT NOT NULL UNIQUE, data_json TEXT NOT NULL);
      CREATE TABLE customer_experiment_stripe_events(event_id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES customer_experiment_requests(id), received_at TEXT NOT NULL);
    `,
      // service_experiment@3: the browser (a Supabase anonymous user) acting as the customer.
      // POST /session binds it once; only an explicit take-over, with the capability, moves it.
      2: `
      CREATE TABLE customer_experiment_identities(request_id TEXT PRIMARY KEY REFERENCES customer_experiment_requests(id), issuer TEXT NOT NULL, subject TEXT NOT NULL, bound_at TEXT NOT NULL);
    `,
    });
  }
  async create(clientRequest: string, title: string, maxDaily: number): Promise<RequestRecord> {
    return this.state.transaction(async (tx) => {
      const old = await tx.get<{ data_json: string }>(
        'SELECT data_json FROM customer_experiment_requests WHERE client_request=?',
        clientRequest,
      );
      if (old) {
        const value = JSON.parse(old.data_json) as RequestRecord;
        check(
          value.title === title,
          'request_conflict',
          'Request ID already has a different title',
          409,
        );
        return value;
      }
      const today = new Date().toISOString().slice(0, 10);
      const rows = await tx.all<{ data_json: string }>(
        'SELECT data_json FROM customer_experiment_requests',
      );
      check(
        rows.filter((r) => (JSON.parse(r.data_json) as RequestRecord).createdAt.startsWith(today))
          .length < maxDaily,
        'intake_capacity',
        'New experiment intake is at capacity today',
        429,
      );
      const record: RequestRecord = {
        id: `ce_${randomBytes(16).toString('hex')}`,
        clientRequest,
        title,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
        uploads: [],
      };
      await tx.run(
        'INSERT INTO customer_experiment_requests(id,client_request,data_json) VALUES(?,?,?)',
        record.id,
        clientRequest,
        JSON.stringify(record),
      );
      return record;
    });
  }
  async get(id: string, tx?: Transaction): Promise<RequestRecord> {
    const read = async (sql: Pick<Transaction, 'get'>) => {
      const row = await sql.get<{ data_json: string }>(
        'SELECT data_json FROM customer_experiment_requests WHERE id=?',
        id,
      );
      check(row, 'not_found', 'Experiment request not found', 404);
      return JSON.parse(row.data_json) as RequestRecord;
    };
    return tx ? read(tx) : this.state.read(read);
  }
  async mutate<T>(
    id: string,
    fn: (r: RequestRecord, tx: Transaction) => Promise<T> | T,
  ): Promise<T> {
    return this.state.transaction(async (tx) => {
      const record = await this.get(id, tx);
      const value = await fn(record, tx);
      await tx.run(
        'UPDATE customer_experiment_requests SET data_json=? WHERE id=?',
        JSON.stringify(record),
        id,
      );
      return value;
    });
  }
  async list(): Promise<RequestRecord[]> {
    return this.state.read(async (sql) =>
      (
        await sql.all<{ data_json: string }>('SELECT data_json FROM customer_experiment_requests')
      ).map((r) => JSON.parse(r.data_json)),
    );
  }
  /**
   * Platform admin read, never exposed through a tool or a machine key: each named experiment's
   * customer, by its browser sign-in, else the email it gave, and the move of theirs its state
   * waits on. Never a capability, a checkout or an idempotency key.
   */
  async customers(work: readonly { id: string; state: string }[]) {
    const rows = await this.state.read((sql) =>
      sql.all<{
        id: string;
        requestId: string;
        issuer: string | null;
        subject: string | null;
        email: string | null;
      }>(
        `SELECT r.data_json::jsonb->>'experimentId' AS id,r.id AS "requestId",i.issuer,i.subject,r.data_json::jsonb->>'email' AS email
        FROM customer_experiment_requests r LEFT JOIN customer_experiment_identities i ON i.request_id=r.id
        WHERE r.data_json::jsonb->>'experimentId' IN (SELECT jsonb_array_elements_text(?::jsonb))`,
        JSON.stringify(work.map(({ id }) => id)),
      ),
    );
    const states = new Map(work.map(({ id, state }) => [id, state]));
    return new Map(
      rows.map((row) => [row.id, { ...row, waits: WAITS.get(states.get(row.id)!) ?? null }]),
    );
  }
  token(record: RequestRecord, role: 'agent' | 'customer'): string {
    const mac = createHmac('sha256', this.key)
      .update(`${record.id}:${record.expiresAt}:${role}`)
      .digest('base64url');
    return `ce_${role}_${mac}`;
  }
  async authorize(
    id: string,
    bearer: string,
    roles: ('agent' | 'customer')[],
  ): Promise<RequestRecord> {
    return (await this.authorizeRole(id, bearer, roles)).record;
  }
  /** As authorize, also naming which capability the bearer is. */
  async authorizeRole(
    id: string,
    bearer: string,
    roles: ('agent' | 'customer')[],
  ): Promise<{ record: RequestRecord; role: 'agent' | 'customer' }> {
    const record = await this.get(id);
    const supplied = Buffer.from(digest(bearer));
    const role = roles.find((role) =>
      timingSafeEqual(supplied, Buffer.from(digest(this.token(record, role)))),
    );
    check(role, 'unauthorized', 'This credential cannot access this experiment', 401);
    // Customer bookmarks remain usable to monitor the run and retrieve its results.
    // The external agent's capability still expires after the bounded intake period.
    check(
      role === 'customer' || Date.parse(record.expiresAt) > Date.now(),
      'access_expired',
      'Experiment agent access has expired',
      401,
    );
    return { record, role };
  }
  async binding(id: string): Promise<IdentityBinding | null> {
    const row = await this.state.read((sql) =>
      sql.get<{ issuer: string; subject: string; bound_at: string }>(
        'SELECT issuer,subject,bound_at FROM customer_experiment_identities WHERE request_id=?',
        id,
      ),
    );
    return row ? { issuer: row.issuer, subject: row.subject, boundAt: row.bound_at } : null;
  }
  /** Binds the request to `identity` unless one is bound already (or `takeOver` moves it there);
   *  answers whichever is bound. */
  async bind(
    id: string,
    identity: { issuer: string; subject: string },
    takeOver = false,
  ): Promise<IdentityBinding> {
    await this.state.transaction((tx) =>
      tx.run(
        'INSERT INTO customer_experiment_identities(request_id,issuer,subject,bound_at) VALUES(?,?,?,?) ON CONFLICT(request_id) DO ' +
          (takeOver
            ? 'UPDATE SET issuer=excluded.issuer,subject=excluded.subject,bound_at=excluded.bound_at'
            : 'NOTHING'),
        id,
        identity.issuer,
        identity.subject,
        new Date().toISOString(),
      ),
    );
    return (await this.binding(id))!;
  }
}
