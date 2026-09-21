import { createService } from '@merv/contracts';
import { postgresMigrations } from './index.postgres.js';
import type { Context } from 'cordis';
import {
  check,
  type Caller,
  type Scope,
  type Sql,
  type State,
  type Transaction,
} from '@merv/contracts';
import { z } from 'zod';
import type { Claim, Claims } from './types.js';

export type { Claim, ClaimConfidence, Claims, ClaimStatus } from './types.js';
const claimIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
interface ClaimRow {
  id: string;
  project_id: string;
  statement: string;
  scope: string;
  status: Claim['status'];
  confidence: Claim['confidence'];
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}
const hydrate = (row: ClaimRow): Claim => ({
  id: row.id,
  projectId: row.project_id,
  statement: row.statement,
  scope: row.scope,
  status: row.status,
  confidence: row.confidence,
  revision: row.revision,
  createdBy: row.created_by,
  updatedBy: row.updated_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Read-only archive for research claims created before paper-based authorship. */
export class ClaimService implements Claims {
  private closed = false;
  /** Complete storage migrations before publishing this service. */
  initialize!: () => Promise<void>;
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
  ) {
    this.initialize = async () => {
      await state.migrate('claims', [
        {
          version: 1,
          postgres: postgresMigrations[1],
          sql: `
CREATE TABLE claims (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, statement TEXT NOT NULL, scope TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','active','supported','weakened','contradicted','abandoned')),
  confidence TEXT NOT NULL CHECK(confidence IN ('low','medium','high')),
  revision INTEGER NOT NULL CHECK(revision>=0), created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX claims_project ON claims(project_id,created_at,id);
CREATE TRIGGER claims_identity_immutable BEFORE UPDATE OF id,project_id,created_by,created_at ON claims
BEGIN SELECT RAISE(ABORT,'Claim identity is immutable'); END;
CREATE TRIGGER claims_no_delete BEFORE DELETE ON claims
BEGIN SELECT RAISE(ABORT,'Claims are retained'); END;
CREATE TABLE claim_commands (
  project_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
  input_hash TEXT NOT NULL, result_json TEXT NOT NULL,
  PRIMARY KEY(project_id,actor_id,request_id)
);
CREATE TRIGGER claim_commands_no_update BEFORE UPDATE ON claim_commands
BEGIN SELECT RAISE(ABORT,'Claim command receipts are immutable'); END;
CREATE TRIGGER claim_commands_no_delete BEFORE DELETE ON claim_commands
BEGIN SELECT RAISE(ABORT,'Claim command receipts are retained'); END;
`,
        },
      ]);
    };
  }

  async get(caller: Caller, claimId: string, transaction?: Transaction): Promise<Claim> {
    caller = this.capture(caller);
    if (transaction) this.state.assertTransaction(transaction);
    await this.scope.require(caller, 'read', transaction);
    check(
      typeof claimId === 'string' && claimIdSchema.safeParse(claimId).success,
      'invalid_claim_input',
      'A valid claim ID is required',
    );
    const read = async (sql: Sql) => {
      const row = await sql.get<ClaimRow>(
        'SELECT * FROM claims WHERE project_id=? AND id=?',
        caller.projectId,
        claimId,
      );
      check(row, 'claim_not_found', 'Claim not found in this project', 404);
      return hydrate(row);
    };
    return transaction ? await read(transaction) : await this.state.read(read);
  }

  async list(caller: Caller, transaction?: Transaction): Promise<Claim[]> {
    caller = this.capture(caller);
    if (transaction) this.state.assertTransaction(transaction);
    await this.scope.require(caller, 'read', transaction);
    const read = async (sql: Sql) =>
      (
        await sql.all<ClaimRow>(
          'SELECT * FROM claims WHERE project_id=? ORDER BY created_at,id',
          caller.projectId,
        )
      ).map(hydrate);
    return transaction ? await read(transaction) : await this.state.read(read);
  }

  close(): void {
    this.closed = true;
  }
  private capture(caller: Caller): Caller {
    check(!this.closed, 'claims_unavailable', 'Claims is unavailable', 503);
    return structuredClone(caller);
  }
}

export const claimsPlugin = {
  name: 'merv-claims',
  inject: ['state', 'scope'],
  async apply(ctx: Context) {
    await ctx.effect(async function* () {
      const claims = await createService(new ClaimService(ctx.state, ctx.scope));
      yield () => claims.close();
      yield ctx.provide('claims', claims);
    });
  },
};
export default claimsPlugin;
