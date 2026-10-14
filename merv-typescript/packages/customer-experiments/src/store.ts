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
}
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
    const record = await this.get(id);
    const supplied = Buffer.from(digest(bearer));
    check(
      roles.some((role) =>
        timingSafeEqual(supplied, Buffer.from(digest(this.token(record, role)))),
      ),
      'unauthorized',
      'This credential cannot access this experiment',
      401,
    );
    // Customer bookmarks remain usable to monitor the run and retrieve its results.
    // The external agent's capability still expires after the bounded intake period.
    const customer =
      roles.includes('customer') &&
      timingSafeEqual(supplied, Buffer.from(digest(this.token(record, 'customer'))));
    check(
      customer || Date.parse(record.expiresAt) > Date.now(),
      'access_expired',
      'Experiment agent access has expired',
      401,
    );
    return record;
  }
}
