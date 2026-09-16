import { createService } from '@merv/contracts';
import { postgresMigrations } from './index.postgres.js';
import type { Context } from 'cordis';
import {
  check,
  digest,
  eventSource,
  inTransaction,
  newId,
  now,
  type Caller,
  type Scope,
  type Sql,
  type State,
  type Transaction,
} from '@merv/contracts';
import { claimCreateSchema, claimIdSchema, claimUpdateSchema, parseClaimInput } from './input.js';
import type { Claim, ClaimCreate, Claims, ClaimUpdate } from './types.js';

export type {
  Claim,
  ClaimConfidence,
  ClaimCreate,
  Claims,
  ClaimStatus,
  ClaimUpdate,
} from './types.js';
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

/** Research assertions are project facts; their status is not a work-item lifecycle. */
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

  async create(caller: Caller, value: ClaimCreate, transaction?: Transaction): Promise<Claim> {
    this.ensureOpen();
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      const input = parseClaimInput(claimCreateSchema, value);
      return await this.command(caller, 'create', input, tx, async () => {
        const createdAt = now();
        const claim: Claim = {
          id: newId('claim'),
          projectId: caller.projectId,
          statement: input.statement,
          scope: input.scope,
          status: 'active',
          confidence: input.confidence,
          revision: 0,
          createdBy: caller.actorId,
          updatedBy: caller.actorId,
          createdAt,
          updatedAt: createdAt,
        };
        await tx.run(
          'INSERT INTO claims(id,project_id,statement,scope,status,confidence,revision,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          claim.id,
          claim.projectId,
          claim.statement,
          claim.scope,
          claim.status,
          claim.confidence,
          claim.revision,
          claim.createdBy,
          claim.updatedBy,
          claim.createdAt,
          claim.updatedAt,
        );
        await this.record(caller, null, claim, tx);
        return claim;
      });
    });
  }

  async update(caller: Caller, value: ClaimUpdate, transaction?: Transaction): Promise<Claim> {
    this.ensureOpen();
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      const input = parseClaimInput(claimUpdateSchema, value);
      return await this.command(caller, 'update', input, tx, async () => {
        const before = await this.get(caller, input.claimId, tx);
        check(
          before.revision === input.expectedRevision,
          'claim_revision_conflict',
          'The claim changed; read its current revision before updating',
          409,
        );
        check(
          before.revision < Number.MAX_SAFE_INTEGER,
          'claim_revision_conflict',
          'Claim revision is exhausted',
          409,
        );
        const after: Claim = {
          ...before,
          status: input.status ?? before.status,
          confidence: input.confidence ?? before.confidence,
          revision: before.revision + 1,
          updatedBy: caller.actorId,
          updatedAt: now(),
        };
        const result = await tx.run(
          'UPDATE claims SET status=?,confidence=?,revision=?,updated_by=?,updated_at=? WHERE id=? AND project_id=? AND revision=?',
          after.status,
          after.confidence,
          after.revision,
          after.updatedBy,
          after.updatedAt,
          after.id,
          after.projectId,
          before.revision,
        );
        check(
          result.changes === 1,
          'claim_revision_conflict',
          'The claim changed while updating',
          409,
        );
        await this.record(caller, before, after, tx);
        return after;
      });
    });
  }

  async get(caller: Caller, claimId: string, transaction?: Transaction): Promise<Claim> {
    this.ensureOpen();
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
    this.ensureOpen();
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

  private async command(
    caller: Caller,
    operation: string,
    input: { requestId: string },
    tx: Transaction,
    execute: () => Claim | Promise<Claim>,
  ): Promise<Claim> {
    const hash = digest({ operation, input });
    const previous = await tx.get<{ input_hash: string; result_json: string }>(
      'SELECT input_hash,result_json FROM claim_commands WHERE project_id=? AND actor_id=? AND request_id=?',
      caller.projectId,
      caller.actorId,
      input.requestId,
    );
    if (previous) {
      check(
        previous.input_hash === hash,
        'request_conflict',
        'requestId was already used with different claim input',
        409,
      );
      return JSON.parse(previous.result_json) as Claim;
    }
    const claim = await execute();
    await this.scope.require(caller, 'write', tx);
    await tx.run(
      'INSERT INTO claim_commands(project_id,actor_id,request_id,input_hash,result_json) VALUES(?,?,?,?,?)',
      caller.projectId,
      caller.actorId,
      input.requestId,
      hash,
      JSON.stringify(claim),
    );
    return claim;
  }

  private async record(
    caller: Caller,
    before: Claim | null,
    after: Claim,
    tx: Transaction,
  ): Promise<void> {
    await this.state.appendEvent(tx, {
      projectId: caller.projectId,
      actorId: caller.actorId,
      type: before ? 'claim.updated' : 'claim.created',
      subjectId: after.id,
      data: {
        before: before
          ? { status: before.status, confidence: before.confidence, revision: before.revision }
          : null,
        statement: after.statement,
        scope: after.scope,
        status: after.status,
        confidence: after.confidence,
        revision: after.revision,
        ...eventSource(caller),
      },
    });
  }
  close(): void {
    this.closed = true;
  }
  private ensureOpen(): void {
    check(!this.closed, 'claims_unavailable', 'Claims is unavailable', 503);
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
