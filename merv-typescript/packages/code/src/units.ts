import {
  canonical,
  check,
  codeLocalBindInputSchema,
  digest,
  mapAsync,
  MervError,
  newId,
  now,
  recorded,
  type Caller,
  type CodeBasePin,
  type CodeLocalBindInput,
  type CodeProjectBinding,
  type CodeProjectStatus,
  type CodeUnit,
  type CodeUnitAcceptance,
  type CodeUnitAcceptInput,
  type Scope,
  type Sql,
  type State,
  type Transaction,
  type Workflows,
} from '@merv/contracts';
import { postgresMigrations } from './units.postgres.js';
import { parseCodeInput } from './input.js';
import type { CodeCapture, CodeCaptureRef, CodeCaptures, CodeUnits } from './types.js';

interface ProjectRow {
  project_id: string;
  repository_id: string;
  binding_json: string;
  main_json: string;
}
interface UnitRow {
  project_id: string;
  unit_id: string;
  workflow: string;
  version: number;
  declared_at: string;
  base_json: string | null;
  base_hash: string | null;
  base_lease_id: string | null;
  based_at: string | null;
  acceptance_json: string | null;
  acceptance_hash: string | null;
  accepted_at: string | null;
}
/** The hashed body of an acceptance. It carries no time, so a repeated acceptance is byte-equal. */
interface AcceptanceBody {
  formatVersion: 1;
  unitId: string;
  workflow: string;
  version: number;
  terminalRevision: number;
  submissionRef: string;
  reviewRef: string;
  acceptedBy: string;
  code: {
    ref: CodeCaptureRef;
    commit: string;
    tree: string | null;
    repositoryId: string;
    reviewAttached: boolean;
  } | null;
  storage: CodeUnitAcceptance['storage'];
}
/** The hashed body of a base pin. Lease and time stay outside it, so racing derivations agree. */
interface BaseBody {
  formatVersion: 1;
  kind: CodeBasePin['kind'];
  reference: string;
  repositoryId: string;
  /** The declared dependency ids the pin was derived from; they may not change afterwards. */
  dependencies: string[];
  sources: { unitId: string; acceptanceHash: string; terminalRevision: number }[];
  main: { oid: string; operationId: string } | null;
}
const unitColumns =
  'project_id,unit_id,workflow,version,declared_at,base_json,base_hash,base_lease_id,based_at,acceptance_json,acceptance_hash,accepted_at';
const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Units of work as Code knows them: one immutable base pin and at most one immutable
 * acceptance each, beside the project's local binding. Owners reach this only inside their
 * own transactions; they hand over capture references and never see what those resolve to.
 */
export class CodeUnitService implements CodeUnits {
  private closed = false;
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly workflows: Workflows,
    private readonly captures: CodeCaptures,
  ) {}

  /** Complete storage migrations before publishing this service. */
  async initialize(): Promise<void> {
    await this.state.migrate('code_units', [
      {
        version: 1,
        postgres: postgresMigrations[1],
        sql: `
CREATE TABLE code_projects (
  project_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('local')),
  repository_id TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  main_json TEXT NOT NULL,
  limits_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE code_units (
  project_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  workflow TEXT NOT NULL,
  version INTEGER NOT NULL,
  declared_at TEXT NOT NULL,
  base_json TEXT,
  base_hash TEXT,
  base_lease_id TEXT,
  based_at TEXT,
  acceptance_json TEXT,
  acceptance_hash TEXT,
  accepted_at TEXT,
  PRIMARY KEY (project_id,unit_id),
  CHECK ((base_json IS NULL)=(base_hash IS NULL) AND (base_json IS NULL)=(base_lease_id IS NULL) AND (base_json IS NULL)=(based_at IS NULL)),
  CHECK ((acceptance_json IS NULL)=(acceptance_hash IS NULL) AND (acceptance_json IS NULL)=(accepted_at IS NULL))
);
CREATE INDEX code_units_declared ON code_units(project_id,declared_at,unit_id);
CREATE TABLE code_edges (
  project_id TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  relation TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id,source_ref,relation,target_ref)
);
CREATE INDEX code_edges_target ON code_edges(project_id,target_ref,relation);
CREATE TABLE code_operations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  principal_scope TEXT NOT NULL,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared','completed','failed')),
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (project_id,principal_scope,request_id),
  CHECK (
    (status='prepared' AND result_json IS NULL AND error IS NULL AND completed_at IS NULL) OR
    (status='completed' AND result_json IS NOT NULL AND error IS NULL AND completed_at IS NOT NULL) OR
    (status='failed' AND result_json IS NULL AND error IS NOT NULL AND completed_at IS NOT NULL)
  )
);
CREATE TRIGGER code_projects_binding BEFORE UPDATE ON code_projects
  WHEN NEW.project_id IS NOT OLD.project_id OR NEW.mode IS NOT OLD.mode OR NEW.repository_id IS NOT OLD.repository_id OR NEW.binding_json IS NOT OLD.binding_json
  BEGIN SELECT RAISE(ABORT,'Code repository binding is immutable'); END;
CREATE TRIGGER code_projects_no_delete BEFORE DELETE ON code_projects
  BEGIN SELECT RAISE(ABORT,'Code repository bindings are retained'); END;
CREATE TRIGGER code_units_identity BEFORE UPDATE ON code_units
  WHEN NEW.project_id IS NOT OLD.project_id OR NEW.unit_id IS NOT OLD.unit_id OR NEW.workflow IS NOT OLD.workflow OR NEW.version IS NOT OLD.version OR NEW.declared_at IS NOT OLD.declared_at
  BEGIN SELECT RAISE(ABORT,'Code unit identity is immutable'); END;
CREATE TRIGGER code_units_base BEFORE UPDATE ON code_units
  WHEN OLD.base_json IS NOT NULL AND (NEW.base_json IS NOT OLD.base_json OR NEW.base_hash IS NOT OLD.base_hash OR NEW.base_lease_id IS NOT OLD.base_lease_id OR NEW.based_at IS NOT OLD.based_at)
  BEGIN SELECT RAISE(ABORT,'The base pin of a unit is immutable'); END;
CREATE TRIGGER code_units_acceptance BEFORE UPDATE ON code_units
  WHEN OLD.acceptance_json IS NOT NULL AND (NEW.acceptance_json IS NOT OLD.acceptance_json OR NEW.acceptance_hash IS NOT OLD.acceptance_hash OR NEW.accepted_at IS NOT OLD.accepted_at)
  BEGIN SELECT RAISE(ABORT,'The acceptance of a unit is immutable'); END;
CREATE TRIGGER code_units_no_delete BEFORE DELETE ON code_units
  BEGIN SELECT RAISE(ABORT,'Code units are retained'); END;
CREATE TRIGGER code_edges_no_update BEFORE UPDATE ON code_edges
  BEGIN SELECT RAISE(ABORT,'Code lineage is immutable'); END;
CREATE TRIGGER code_edges_no_delete BEFORE DELETE ON code_edges
  BEGIN SELECT RAISE(ABORT,'Code lineage is retained'); END;
CREATE TRIGGER code_operations_identity BEFORE UPDATE ON code_operations
  WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.principal_scope IS NOT OLD.principal_scope OR NEW.request_id IS NOT OLD.request_id OR NEW.kind IS NOT OLD.kind OR NEW.input_hash IS NOT OLD.input_hash OR NEW.payload_json IS NOT OLD.payload_json OR NEW.created_at IS NOT OLD.created_at
  BEGIN SELECT RAISE(ABORT,'Code operation identity is immutable'); END;
CREATE TRIGGER code_operations_result BEFORE UPDATE ON code_operations
  WHEN OLD.status <> 'prepared'
  BEGIN SELECT RAISE(ABORT,'A finished Code operation is immutable'); END;
CREATE TRIGGER code_operations_no_delete BEFORE DELETE ON code_operations
  BEGIN SELECT RAISE(ABORT,'Code operations are retained'); END;
`,
      },
    ]);
  }

  async declareUnit(caller: Caller, unitId: string, tx: Transaction): Promise<CodeUnit> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    caller = structuredClone(caller);
    await this.scope.require(caller, 'read', tx);
    const relations = await this.workflows.dependencyRelations(caller.projectId, unitId, tx);
    check(relations, 'code_unit_not_found', 'No such unit of work in this project', 404);
    const row = await this.row(tx, caller.projectId, unitId);
    if (!row)
      await tx.run(
        'INSERT INTO code_units (project_id,unit_id,workflow,version,declared_at) VALUES (?,?,?,?,?)',
        caller.projectId,
        unitId,
        relations.instance.workflow,
        relations.instance.version,
        now(),
      );
    return this.record((await this.row(tx, caller.projectId, unitId))!);
  }

  /**
   * Called by the owner inside its successful review transaction, after the workflow moved.
   * It refuses only what the owner itself already required of the submission, so a review
   * that would have passed before acceptances existed still passes: whether the accepted code
   * can serve as a base is judged later, where a base is derived. A code-less acceptance
   * reads no capture and ignores whether Code is closing, because nothing about scratch work
   * may come to depend on Code being well.
   */
  async acceptUnit(
    caller: Caller,
    { ...input }: CodeUnitAcceptInput,
    tx: Transaction,
  ): Promise<CodeUnitAcceptance> {
    this.state.assertTransaction(tx);
    caller = structuredClone(caller);
    const relations = await this.workflows.dependencyRelations(caller.projectId, input.unitId, tx);
    check(
      relations?.instance.settled && relations.instance.revision === input.terminalRevision,
      'code_acceptance_unverifiable',
      'Only a unit that has just succeeded at the revision named can be accepted',
      409,
    );
    const body: AcceptanceBody = {
      formatVersion: 1,
      unitId: input.unitId,
      workflow: relations.instance.workflow,
      version: relations.instance.version,
      terminalRevision: input.terminalRevision,
      submissionRef: input.submissionRef,
      reviewRef: input.reviewRef,
      acceptedBy: caller.actorId,
      code:
        input.codeRef === null
          ? null
          : await this.reviewedCode(caller, input.unitId, input.codeRef, input.reviewSessionId, tx),
      storage: input.codeRef === null ? 'none' : 'legacy-local',
    };
    const encoded = canonical(body),
      hash = digest(body);
    const existing = await this.row(tx, caller.projectId, input.unitId);
    if (existing?.acceptance_hash) {
      check(
        existing.acceptance_hash === hash,
        'code_acceptance_conflict',
        'This unit already has a different acceptance',
        409,
      );
      return this.acceptance(existing)!;
    }
    const at = now();
    if (existing)
      await tx.run(
        'UPDATE code_units SET acceptance_json=?,acceptance_hash=?,accepted_at=? WHERE project_id=? AND unit_id=? AND acceptance_json IS NULL',
        encoded,
        hash,
        at,
        caller.projectId,
        input.unitId,
      );
    else
      await tx.run(
        'INSERT INTO code_units (project_id,unit_id,workflow,version,declared_at,acceptance_json,acceptance_hash,accepted_at) VALUES (?,?,?,?,?,?,?,?)',
        caller.projectId,
        input.unitId,
        body.workflow,
        body.version,
        at,
        encoded,
        hash,
        at,
      );
    return this.acceptance((await this.row(tx, caller.projectId, input.unitId))!)!;
  }

  private async reviewedCode(
    caller: Caller,
    unitId: string,
    ref: CodeCaptureRef,
    reviewSessionId: string | null,
    tx: Transaction,
  ): Promise<NonNullable<AcceptanceBody['code']>> {
    this.assertOpen();
    const capture = await this.captures.capture(caller, ref, tx);
    const workspace = capture.workspace;
    check(
      capture.status === 'ready' &&
        workspace &&
        capture.provenance.projectId === caller.projectId &&
        capture.provenance.instanceId === unitId &&
        !capture.provenance.readOnly &&
        oid.test(workspace.headOid),
      'code_acceptance_unverifiable',
      'The accepted code is not a ready capture of this unit’s own writable session',
      409,
    );
    let review: CodeCapture | null = null;
    if (reviewSessionId !== null)
      try {
        review = await this.captures.capture(
          caller,
          { kind: 'session-final', sessionId: reviewSessionId },
          tx,
        );
      } catch (error) {
        // A reviewer without a readable checkout is recorded as not attached, which is true.
        if (!(error instanceof MervError) || error.status >= 500) throw error;
      }
    return {
      ref,
      commit: workspace.headOid,
      tree: workspace.treeOid ?? null,
      repositoryId: workspace.repositoryId,
      reviewAttached: review?.attachedBaseOid === workspace.headOid,
    };
  }

  /**
   * Main is consolidated research, so only a signed-in human administrator names it, and
   * moving it is a compare-and-set against the main that human last read: a replayed or
   * racing call cannot move it backwards. A pin already taken keeps the commit it copied.
   */
  async bindLocal(caller: Caller, value: CodeLocalBindInput): Promise<CodeProjectBinding> {
    this.assertOpen();
    caller = structuredClone(caller);
    const input = parseCodeInput(codeLocalBindInputSchema, value);
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'admin', tx);
      check(
        caller.human && !caller.session && !caller.key,
        'code_human_required',
        'A signed-in project administrator binds the repository and names its main',
        403,
      );
      const principal = `actor:${caller.actorId}`;
      const { requestId, ...payload } = input;
      const inputHash = digest(payload);
      const previous = await tx.get<{ input_hash: string; result_json: string }>(
        'SELECT input_hash,result_json FROM code_operations WHERE project_id=? AND principal_scope=? AND request_id=?',
        caller.projectId,
        principal,
        requestId,
      );
      if (previous) {
        check(
          previous.input_hash === inputHash,
          'request_conflict',
          'This request id was used with different input',
          409,
        );
        return JSON.parse(previous.result_json) as CodeProjectBinding;
      }
      const operationId = newId('cop'),
        at = now();
      const main = canonical({
        oid: input.mainOid,
        admittedBy: caller.actorId,
        admittedAt: at,
        operationId,
      });
      const bound = await this.project(tx, caller.projectId);
      if (!bound) {
        check(
          input.expectedMainOid === undefined,
          'code_main_changed',
          'This project has no main yet; bind it without expectedMainOid',
          409,
        );
        await tx.run(
          'INSERT INTO code_projects (project_id,mode,repository_id,binding_json,main_json,limits_json,warnings_json,updated_at) VALUES (?,?,?,?,?,?,?,?)',
          caller.projectId,
          'local',
          input.repositoryId,
          canonical({ boundBy: caller.actorId, boundAt: at, operationId }),
          main,
          '{}',
          '[]',
          at,
        );
      } else {
        check(
          bound.repositoryId === input.repositoryId,
          'code_rebind_required',
          'This project is bound to another repository, and rebinding is unavailable',
          409,
        );
        check(
          input.expectedMainOid === bound.main.oid,
          'code_main_changed',
          'Main is not where expectedMainOid says; read code.status and decide again',
          409,
        );
        if (input.mainOid !== bound.main.oid)
          await tx.run(
            'UPDATE code_projects SET main_json=?,updated_at=? WHERE project_id=?',
            main,
            at,
            caller.projectId,
          );
      }
      const result = (await this.project(tx, caller.projectId))!;
      await tx.run(
        'INSERT INTO code_operations (id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        operationId,
        caller.projectId,
        principal,
        requestId,
        'local_bind',
        inputHash,
        canonical(payload),
        'completed',
        canonical(result),
        at,
        at,
      );
      await recorded(this.state, tx, caller, 'code.local_bound', caller.projectId, {
        operationId,
        repositoryId: input.repositoryId,
        mainOid: input.mainOid,
        previousMainOid: bound?.main.oid ?? null,
      });
      return result;
    });
  }

  async unit(caller: Caller, unitId: string, tx?: Transaction): Promise<CodeUnit> {
    this.assertOpen();
    caller = structuredClone(caller);
    const read = async (sql: Sql) => {
      const row = await this.row(sql, caller.projectId, unitId);
      check(row, 'code_unit_not_found', 'No such unit of work in this project', 404);
      return this.record(row);
    };
    if (tx) this.state.assertTransaction(tx);
    await this.scope.require(caller, 'read', tx);
    return tx ? await read(tx) : await this.state.read(read);
  }

  async status(caller: Caller): Promise<CodeProjectStatus> {
    this.assertOpen();
    caller = structuredClone(caller);
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      return {
        project: await this.project(tx, caller.projectId),
        units: await mapAsync(
          await tx.all<UnitRow>(
            `SELECT ${unitColumns} FROM code_units WHERE project_id=? ORDER BY declared_at DESC,unit_id LIMIT 200`,
            caller.projectId,
          ),
          (row) => this.record(row),
        ),
        blockers: (await this.workflows.blockers(caller, undefined, tx)).filter(
          (blocker) => blocker.provider === 'code',
        ),
      };
    });
  }

  private async project(sql: Sql, projectId: string): Promise<CodeProjectBinding | null> {
    const row = await sql.get<ProjectRow>(
      'SELECT project_id,repository_id,binding_json,main_json FROM code_projects WHERE project_id=?',
      projectId,
    );
    if (!row) return null;
    const binding = JSON.parse(row.binding_json) as { boundBy: string; boundAt: string };
    const main = JSON.parse(row.main_json) as CodeProjectBinding['main'];
    return {
      mode: 'local',
      repositoryId: row.repository_id,
      boundBy: binding.boundBy,
      boundAt: binding.boundAt,
      main: { oid: main.oid, admittedBy: main.admittedBy, admittedAt: main.admittedAt },
      durability: 'legacy-local',
    };
  }

  private async row(sql: Sql, projectId: string, unitId: string): Promise<UnitRow | undefined> {
    return await sql.get<UnitRow>(
      `SELECT ${unitColumns} FROM code_units WHERE project_id=? AND unit_id=?`,
      projectId,
      unitId,
    );
  }

  private acceptance(row: UnitRow): CodeUnitAcceptance | null {
    if (row.acceptance_json === null) return null;
    const body = JSON.parse(row.acceptance_json) as AcceptanceBody;
    return {
      unitId: row.unit_id,
      hash: row.acceptance_hash!,
      acceptedAt: row.accepted_at!,
      terminalRevision: body.terminalRevision,
      submissionRef: body.submissionRef,
      reviewRef: body.reviewRef,
      acceptedBy: body.acceptedBy,
      reference: body.code?.commit ?? null,
      reviewAttached: body.code?.reviewAttached ?? null,
      storage: body.storage,
    };
  }

  private record(row: UnitRow): CodeUnit {
    const base = row.base_json === null ? null : (JSON.parse(row.base_json) as BaseBody);
    return {
      unitId: row.unit_id,
      workflow: row.workflow,
      version: Number(row.version),
      declaredAt: row.declared_at,
      base: base && {
        unitId: row.unit_id,
        kind: base.kind,
        reference: base.reference,
        sources: base.sources.map(({ unitId, acceptanceHash }) => ({ unitId, acceptanceHash })),
        pinnedAt: row.based_at!,
        leaseId: row.base_lease_id!,
      },
      acceptance: this.acceptance(row),
    };
  }

  close(): void {
    this.closed = true;
  }

  private assertOpen(): void {
    check(!this.closed, 'code_unavailable', 'Code is unavailable', 503);
  }
}
