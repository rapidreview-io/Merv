import {
  canonical,
  check,
  codeLocalBindInputSchema,
  digest,
  inTransaction,
  mapAsync,
  MervError,
  newId,
  now,
  recorded,
  type Caller,
  type CodeBasePin,
  type CodeBaseStatus,
  type CodeLocalBindInput,
  type CodeProjectBinding,
  type CodeProjectStatus,
  type CodeUnit,
  type CodeUnitAcceptance,
  type CodeUnitAcceptInput,
  type Scope,
  type Sql,
  type State,
  type StoredEvent,
  type Transaction,
  type WorkflowProvidedBlockerInput,
  type WorkflowProviderDependency,
  type WorkflowProviderRelations,
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
/** What a derivation finds; only `ready` carries a body a lease may pin. */
type Derived =
  | { status: 'waiting' }
  | { status: 'blocked'; blockers: WorkflowProvidedBlockerInput[] }
  | { status: 'ready'; body: BaseBody };
const PROVIDER = 'code';
const EXPLICIT_BASE =
  'Recreate this work with baseTaskId naming one accepted Git task, which is the explicit form of a base';
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
    // A unit that cannot start is shown from the moment it exists, not from its first poll.
    await this.reconcileUnit(tx, caller.projectId, unitId);
    return await this.record(tx, (await this.row(tx, caller.projectId, unitId))!);
  }

  /**
   * What a lease would find now. It never writes: lease admission, assignment checks and the
   * dispatch candidate scan all ask, and any of them may run for a caller who holds no lease.
   */
  async baseStatus(caller: Caller, unitId: string, tx: Transaction): Promise<CodeBaseStatus> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    caller = structuredClone(caller);
    await this.scope.require(caller, 'read', tx);
    const row = await this.row(tx, caller.projectId, unitId);
    if (row?.base_json) return { status: 'pinned', pin: this.pin(row)! };
    return this.baseState(
      await this.derive(tx, caller.projectId, await this.relations(tx, caller.projectId, unitId)),
    );
  }

  /** The pin alone, for an owner's references(): that hook runs on every read and must not derive. */
  async basePin(caller: Caller, unitId: string, tx: Transaction): Promise<CodeBasePin | null> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    caller = structuredClone(caller);
    await this.scope.require(caller, 'read', tx);
    const row = await this.row(tx, caller.projectId, unitId);
    return row ? this.pin(row) : null;
  }

  /**
   * Called only from the owner's lease acquisition, so the base is fixed in the transaction
   * that creates the lease and rolls back with a refused offer. The derivation is repeated
   * here rather than trusted from admission: a dependency accepted in between changes it. The
   * hashed body leaves out lease and time, so two racing offers derive byte-equal pins and
   * the one that lands second simply reads the first.
   */
  async pinBase(
    caller: Caller,
    { unitId, leaseId }: { unitId: string; leaseId: string },
    tx: Transaction,
  ): Promise<CodeBasePin> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    caller = structuredClone(caller);
    await this.scope.require(caller, 'read', tx);
    const relations = await this.relations(tx, caller.projectId, unitId);
    const declared = relations.dependencies.map((item) => item.id).sort();
    const existing = await this.row(tx, caller.projectId, unitId);
    if (existing?.base_json) {
      check(
        canonical((JSON.parse(existing.base_json) as BaseBody).dependencies) ===
          canonical(declared),
        'code_dependencies_changed',
        'The dependencies of this unit changed after its base was pinned',
        409,
      );
      return this.pin(existing)!;
    }
    const derived = await this.derive(tx, caller.projectId, relations);
    if (derived.status !== 'ready') {
      // A dependency that is not settled is refused by Workflows before any lease hook runs;
      // should that ever change, the refusal is still one a poll never counts as a failure.
      const first = derived.status === 'blocked' ? derived.blockers[0] : undefined;
      throw new MervError(
        first?.code ?? 'code_base_pending',
        first?.message ??
          'A base cannot be derived until every dependency of this unit has settled',
        409,
      );
    }
    const at = now();
    if (!existing)
      await tx.run(
        'INSERT INTO code_units (project_id,unit_id,workflow,version,declared_at) VALUES (?,?,?,?,?)',
        caller.projectId,
        unitId,
        relations.instance.workflow,
        relations.instance.version,
        at,
      );
    await tx.run(
      'UPDATE code_units SET base_json=?,base_hash=?,base_lease_id=?,based_at=? WHERE project_id=? AND unit_id=? AND base_json IS NULL',
      canonical(derived.body),
      digest(derived.body),
      leaseId,
      at,
      caller.projectId,
      unitId,
    );
    const stored = (await this.row(tx, caller.projectId, unitId))!;
    if (stored.base_lease_id === leaseId)
      for (const target of derived.body.main
        ? [`main:${derived.body.main.oid}`]
        : derived.body.sources.map((item) => `acceptance:${item.unitId}@${item.acceptanceHash}`))
        await tx.run(
          'INSERT INTO code_edges (project_id,source_ref,relation,target_ref,created_at) VALUES (?,?,?,?,?)',
          caller.projectId,
          `unit:${unitId}`,
          'based_on',
          target,
          at,
        );
    await this.workflows.replaceBlockers(
      { projectId: caller.projectId, instanceId: unitId, provider: PROVIDER, blockers: [] },
      tx,
    );
    return this.pin(stored)!;
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
      // Naming main is what every unit with no accepted code beneath it was waiting for.
      await this.reconcileProject(tx, caller.projectId);
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
    return await inTransaction(this.state, tx, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const row = await this.row(tx, caller.projectId, unitId);
      check(row, 'code_unit_not_found', 'No such unit of work in this project', 404);
      return await this.record(tx, row);
    });
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
          async (row) => await this.record(tx, row),
        ),
        blockers: (await this.workflows.blockers(caller, undefined, tx)).filter(
          (blocker) => blocker.provider === 'code',
        ),
      };
    });
  }

  private async relations(
    tx: Transaction,
    projectId: string,
    unitId: string,
  ): Promise<WorkflowProviderRelations> {
    const relations = await this.workflows.dependencyRelations(projectId, unitId, tx);
    check(relations, 'code_unit_not_found', 'No such unit of work in this project', 404);
    return relations;
  }

  /**
   * The base a unit's declared dependencies imply. An accepted dependency with code ends the
   * walk on its path; one that succeeded without code is looked past, to what it was built
   * on. Everything else fails closed, because a pin is immutable: a success on a version that
   * declares a workspace but left no verifiable acceptance blocks, and so does a code-less
   * success whose own prerequisites are unfinished, since what lies beneath it is unknown.
   * Whether a version declares a workspace is Workflows' persisted fact, so the answer is the
   * same while that dependency's owner is unloaded.
   */
  private async derive(
    tx: Transaction,
    projectId: string,
    relations: WorkflowProviderRelations,
  ): Promise<Derived> {
    if (relations.dependencies.some((item) => !item.settled)) return { status: 'waiting' };
    const pending = (
      key: string,
      message: string,
      next: string,
      related = [] as WorkflowProviderDependency[],
    ) => ({
      key,
      code: 'code_base_pending',
      message,
      status: 409,
      next,
      related: related.map((item) => ({ kind: 'workflow', id: item.id, label: item.name })),
    });
    const bound = await tx.get<ProjectRow>(
      'SELECT project_id,repository_id,binding_json,main_json FROM code_projects WHERE project_id=?',
      projectId,
    );
    if (!bound)
      return {
        status: 'blocked',
        blockers: [
          pending(
            'main',
            'This project is not bound to a repository, so no base can be derived',
            'A signed-in project administrator runs code.local.bind, naming the runner’s repository and the commit that is main.',
          ),
        ],
      };
    const blockers: WorkflowProvidedBlockerInput[] = [];
    const commits = new Map<
      string,
      { sources: BaseBody['sources']; units: WorkflowProviderDependency[] }
    >();
    const seen = new Set<string>();
    const queue = [...relations.dependencies];
    for (let node = queue.shift(); node; node = queue.shift()) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      const unit = await this.row(tx, projectId, node.id);
      const accepted = unit?.acceptance_json
        ? (JSON.parse(unit.acceptance_json) as AcceptanceBody)
        : null;
      const intact = !accepted || digest(accepted) === unit!.acceptance_hash;
      if (intact && (accepted ? accepted.code === null : !node.declaresWorkspace)) {
        const below = await this.workflows.dependencyRelations(projectId, node.id, tx);
        for (const child of below?.dependencies ?? [])
          if (child.settled) queue.push(child);
          else
            blockers.push(
              pending(
                `dependency:${child.id}`,
                `“${node.name}” succeeded without code, but its own prerequisite “${child.name}” has not succeeded, so what it was built on is unknown`,
                `Finish “${child.name}”. If it has failed: ${EXPLICIT_BASE}.`,
                [node, child],
              ),
            );
        continue;
      }
      if (!intact || !accepted?.code || accepted.code.repositoryId !== bound.repository_id) {
        blockers.push(
          pending(
            `acceptance:${node.id}`,
            !accepted
              ? `“${node.name}” succeeded with a workspace but has no recorded acceptance, so its code cannot be verified`
              : intact
                ? `“${node.name}” was accepted with code from a repository this project is not bound to`
                : `The recorded acceptance of “${node.name}” no longer matches its hash`,
            `${EXPLICIT_BASE}, or redo “${node.name}” so that its success is accepted.`,
            [node],
          ),
        );
        continue;
      }
      const entry = commits.get(accepted.code.commit) ?? { sources: [], units: [] };
      entry.sources.push({
        unitId: node.id,
        acceptanceHash: unit!.acceptance_hash!,
        terminalRevision: accepted.terminalRevision,
      });
      entry.units.push(node);
      commits.set(accepted.code.commit, entry);
    }
    const blocked = blockers.filter(
      (item, index) => blockers.findIndex((other) => other.key === item.key) === index,
    );
    if (blocked.length) return { status: 'blocked', blockers: blocked };
    if (commits.size > 1)
      return {
        status: 'blocked',
        blockers: [
          {
            key: 'merge',
            code: 'code_merge_required',
            message: `The dependencies of this unit were accepted with ${commits.size} different commits, and they are not merged automatically yet`,
            status: 409,
            next: `${EXPLICIT_BASE}, or make one dependency carry the combined code.`,
            related: [...commits.values()]
              .flatMap((entry) => entry.units)
              .sort((left, right) => left.id.localeCompare(right.id))
              .map((item) => ({ kind: 'workflow', id: item.id, label: item.name })),
          },
        ],
      };
    const main = JSON.parse(bound.main_json) as { oid: string; operationId: string };
    const [accepted] = [...commits];
    return {
      status: 'ready',
      body: {
        formatVersion: 1,
        kind: accepted ? 'accepted' : 'main',
        reference: accepted ? accepted[0] : main.oid,
        repositoryId: bound.repository_id,
        dependencies: relations.dependencies.map((item) => item.id).sort(),
        sources: (accepted?.[1].sources ?? []).sort((left, right) =>
          left.unitId.localeCompare(right.unitId),
        ),
        main: accepted ? null : { oid: main.oid, operationId: main.operationId },
      },
    };
  }

  private baseState(derived: Derived): CodeBaseStatus {
    return derived.status === 'ready'
      ? {
          status: 'ready',
          kind: derived.body.kind,
          sources: derived.body.sources.map((item) => item.unitId),
        }
      : derived;
  }

  /**
   * Publishes what a derivation finds for one unit that has neither a base nor an acceptance.
   * A blocked unit is refused at lease admission and so never becomes a dispatch candidate;
   * this row is the only place anyone would see why. A unit that has ended is left alone:
   * Workflows already cleared it and would drop the write.
   */
  private async reconcileUnit(tx: Transaction, projectId: string, unitId: string): Promise<void> {
    const row = await this.row(tx, projectId, unitId);
    if (!row || row.base_json !== null || row.acceptance_json !== null) return;
    const relations = await this.workflows.dependencyRelations(projectId, unitId, tx);
    if (!relations || relations.instance.terminal) return;
    const derived = await this.derive(tx, projectId, relations);
    await this.workflows.replaceBlockers(
      {
        projectId,
        instanceId: unitId,
        provider: PROVIDER,
        blockers: derived.status === 'blocked' ? derived.blockers : [],
      },
      tx,
    );
  }

  /** Every unpinned unit of a project: for a new main, and for a start after Code was away. */
  private async reconcileProject(tx: Transaction, projectId: string): Promise<void> {
    for (const { unit_id } of await tx.all<{ unit_id: string }>(
      'SELECT unit_id FROM code_units WHERE project_id=? AND base_json IS NULL AND acceptance_json IS NULL ORDER BY unit_id',
      projectId,
    ))
      await this.reconcileUnit(tx, projectId, unit_id);
  }

  /** Run once when Code loads: events that ended work while it was unloaded start from now. */
  async reconcileAll(): Promise<void> {
    const projects = await this.state.read(
      async (sql) =>
        await sql.all<{ project_id: string }>(
          'SELECT DISTINCT project_id FROM code_units WHERE base_json IS NULL AND acceptance_json IS NULL ORDER BY project_id',
        ),
    );
    for (const { project_id } of projects)
      await this.state.transaction(async (tx) => await this.reconcileProject(tx, project_id));
  }

  /**
   * The durable consumer of workflow.transition. A base changes only when work ends, so every
   * other transition costs one read; then only what waits on the ended work is derived again,
   * climbing past a dependent that has itself ended, because a derivation looks through those.
   */
  async transitioned(event: StoredEvent, tx: Transaction): Promise<void> {
    const ended = await this.workflows.dependencyRelations(event.projectId, event.subjectId, tx);
    if (!ended?.instance.terminal) return;
    const seen = new Set<string>();
    const queue = [...ended.dependents];
    for (let node = queue.shift(); node; node = queue.shift()) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      if (!node.terminal) {
        await this.reconcileUnit(tx, event.projectId, node.id);
        continue;
      }
      const above = await this.workflows.dependencyRelations(event.projectId, node.id, tx);
      queue.push(...(above?.dependents ?? []));
    }
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

  private pin(row: UnitRow): CodeBasePin | null {
    if (row.base_json === null) return null;
    const base = JSON.parse(row.base_json) as BaseBody;
    return {
      unitId: row.unit_id,
      kind: base.kind,
      reference: base.reference,
      sources: base.sources.map(({ unitId, acceptanceHash }) => ({ unitId, acceptanceHash })),
      pinnedAt: row.based_at!,
      leaseId: row.base_lease_id!,
    };
  }

  private async record(tx: Transaction, row: UnitRow): Promise<CodeUnit> {
    const base = this.pin(row);
    // Only a unit that may still take a base is derived: one accepted or ended never will.
    const open =
      !base && row.acceptance_json === null
        ? await this.workflows.dependencyRelations(row.project_id, row.unit_id, tx)
        : null;
    return {
      unitId: row.unit_id,
      workflow: row.workflow,
      version: Number(row.version),
      declaredAt: row.declared_at,
      base,
      baseStatus: base
        ? { status: 'pinned', pin: base }
        : open && !open.instance.terminal
          ? this.baseState(await this.derive(tx, row.project_id, open))
          : null,
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
