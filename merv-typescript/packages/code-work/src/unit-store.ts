import { initializeCheckConfiguration } from './check-configuration.js';
import { initializeWorkRecords } from './work-schema.js';
import { initializeWorkHolds } from './repository-holds.js';
import type { CodeUnitStore } from '@merv/code/units';
import {
  canonical,
  check,
  digest,
  inTransaction,
  mapAsync,
  now,
  type Caller,
  type GitHubPullRequest,
  type CodeLocalBindInput,
  type CodeProjectBinding,
  type CodeStoreWarning,
  type Scope,
  type Sql,
  type State,
  type Transaction,
} from '@merv/contracts';
import type { CodeCaptureRef } from '@merv/contracts/types';
import type { CodeWriterService } from '@merv/code/writers';
import { resultRef, workBranch } from '@merv/code/store/refs';
import type {
  CodeBasePin,
  CodeUnitPublication,
  CodeProjectStatus,
  CodeUnit,
  CodeUnitAcceptance,
} from './models.js';

export interface ProjectRow {
  project_id: string;
  repository_id: string;
  binding_json: string;
  main_json: string;
  store_json: string | null;
}
export interface UnitRow {
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
  quarantine_base_key: string | null;
  publishes_at: string | null;
  publication_id: string | null;
}
/** The hashed body of an acceptance. It carries no time, so a repeated acceptance is byte-equal. */
export interface AcceptanceBody {
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
  /** Only with `code` storage: the operation that made the commit durable in Code's repository. */
  receipt?: string;
}
/** The hashed body of a base pin. Lease and time stay outside it, so racing derivations agree. */
export interface BaseBody {
  formatVersion: 1;
  kind: CodeBasePin['kind'];
  reference: string;
  repositoryId: string;
  /** The declared dependency ids the pin was derived from; they may not change afterwards. */
  dependencies: string[];
  sources: { unitId: string; acceptanceHash: string; terminalRevision: number }[];
  main: { oid: string; operationId: string } | null;
}
/** The publication facts of one unit, read by the id its acceptance sealed. */
export interface PublicationRow {
  record_json: string;
  pull_json: string | null;
  merge_json: string | null;
  incident_json: string | null;
  error: string | null;
  stale: number;
  verified: number;
}
/**
 * Whether an acceptance made under `repositoryId` belongs to this project: the repository it is
 * bound to now, or any it was bound to before a verified rebind. A pre-rebind acceptance that
 * passes here goes on to the storage gate below, which a project-keyed import receipt satisfies
 * — safe only because a rebind proves Code's own repository holds every commit the project
 * retained as authoritative before it writes the new binding. Base derivation and publication
 * validate repository lineage through this shared check.
 */
export function bindsRepository(
  bound: { repository_id: string; binding_json: string },
  repositoryId: string,
): boolean {
  if (bound.repository_id === repositoryId) return true;
  const binding = JSON.parse(bound.binding_json) as { previous?: { repositoryId: string }[] };
  return !!binding.previous?.some((entry) => entry.repositoryId === repositoryId);
}
export const unitColumns =
  'project_id,unit_id,workflow,version,declared_at,base_json,base_hash,base_lease_id,based_at,acceptance_json,acceptance_hash,accepted_at,quarantine_base_key,publishes_at,publication_id';
export const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const CODE_DRIVER = 'code.v2';

/** Durable Code records. Work-unit owners supply already validated facts in their transaction. */
export class WorkUnitRecords {
  protected closed = false;
  /** `code` is Code's own unit store, already initialized; it outlives this owner. */
  constructor(
    protected readonly state: State,
    protected readonly scope: Scope,
    protected readonly writers: CodeWriterService,
    protected readonly code: CodeUnitStore,
  ) {}

  /** Complete storage migrations before publishing this service. */
  async initialize(): Promise<void> {
    await initializeWorkRecords(this.state);
    await initializeWorkHolds(this.state);
    await initializeCheckConfiguration(this.state);
  }

  async moveMain(
    caller: Caller,
    oid: string,
    tx: Transaction,
    expectedOid?: string,
    operationId?: string,
  ): Promise<void> {
    const project = await this.code.project(tx, caller.projectId);
    check(project, 'code_project_unbound', 'This project has no Code binding', 409);
    await this.code.setMainStored(tx, {
      projectId: caller.projectId,
      expectedOid: expectedOid ?? project.main.oid,
      oid,
      actorId: caller.actorId,
      ...(operationId ? { operationId } : {}),
    });
  }

  async retainBaseResult(
    tx: Transaction,
    projectId: string,
    key: string,
    commit: string,
  ): Promise<void> {
    await this.code.retainStoredCommit(tx, {
      projectId,
      key: `base:${key}`,
      unitId: `base:${key}`,
      commit,
      storage: 'code',
      createdAt: now(),
    });
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
   * Every accepted commit this repository holds, with the unit it belongs to and the main to
   * compare them against. Whether main already contains one is a question for Git, which is
   * asked once, outside every transaction, by whoever holds the repository. A pull request
   * closed unmerged rejected its unit and every acceptance its base was made from, so none of
   * them is offered again.
   */
  async acceptedCandidates(
    caller: Caller,
    tx?: Transaction,
  ): Promise<{
    main: string;
    candidates: { unitId: string; commit: string; quarantined: boolean }[];
  }> {
    this.assertOpen();
    caller = structuredClone(caller);
    return await inTransaction(this.state, tx, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const project = await this.project(tx, caller.projectId);
      check(project, 'code_project_unbound', 'This project has no Code binding', 409);
      const candidates: { unitId: string; commit: string; quarantined: boolean }[] = [];
      const rows = await tx.all<UnitRow>(
        `SELECT ${unitColumns} FROM code_units WHERE project_id=? AND acceptance_json IS NOT NULL ORDER BY unit_id`,
        caller.projectId,
      );
      const rejected = new Set<string>();
      for (const row of rows)
        if ((await this.publicationOf(tx, caller.projectId, row))?.state === 'closed') {
          rejected.add(row.unit_id);
          this.pin(row)?.sources.forEach((source) => rejected.add(source.unitId));
        }
      for (const row of rows) {
        const accepted = JSON.parse(row.acceptance_json!) as AcceptanceBody;
        // A code-less success is nothing main could be missing.
        if (!accepted.code || rejected.has(row.unit_id)) continue;
        candidates.push({
          unitId: row.unit_id,
          commit: accepted.code.commit,
          quarantined: !!row.quarantine_base_key,
        });
      }
      return { main: project.main.oid, candidates };
    });
  }

  /**
   * Main is the project baseline, so only a signed-in human administrator names it, and
   * moving it is a compare-and-set against the main that human last read: a replayed or
   * racing call cannot move it backwards. A pin already taken keeps the commit it copied.
   * `stored` is what Code's own repository said of that commit before this transaction began,
   * so that nothing in here, or in an owner's create transaction later, has to ask Git.
   */
  async bindLocal(
    caller: Caller,
    value: CodeLocalBindInput,
    stored = false,
    tx?: Transaction,
  ): Promise<CodeProjectBinding> {
    return this.code.bindLocal(caller, value, stored, tx);
  }

  async hosted(caller: Caller, tx: Transaction): Promise<boolean> {
    return this.code.hosted(caller, tx);
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
    return await this.state.transaction((tx) => this.readStatus(caller, tx));
  }

  protected async readStatus(caller: Caller, tx: Transaction): Promise<CodeProjectStatus> {
    await this.scope.require(caller, 'read', tx);
    const warnings = await tx.get<{ warnings_json: string }>(
      'SELECT warnings_json FROM code_projects WHERE project_id=?',
      caller.projectId,
    );
    return {
      project: await this.project(tx, caller.projectId),
      store: null,
      operations: [],
      mirror: null,
      warnings: JSON.parse(warnings?.warnings_json ?? '[]') as CodeStoreWarning[],
      units: await mapAsync(
        await tx.all<UnitRow>(
          `SELECT ${unitColumns} FROM code_units WHERE project_id=? ORDER BY declared_at DESC,unit_id LIMIT 200`,
          caller.projectId,
        ),
        async (row) => await this.record(tx, row),
      ),
      blockers: [],
    };
  }

  async project(sql: Sql, projectId: string): Promise<CodeProjectBinding | null> {
    return this.code.project(sql, projectId);
  }

  /** Read once per snapshot, or per write transaction until it writes; each caller gets a copy. */
  protected async row(sql: Sql, projectId: string, unitId: string): Promise<UnitRow | undefined> {
    const row = await this.state.remember(`code-work:unit:${projectId}:${unitId}`, () =>
      sql.get<UnitRow>(
        `SELECT ${unitColumns} FROM code_units WHERE project_id=? AND unit_id=?`,
        projectId,
        unitId,
      ),
    );
    return row && { ...row };
  }

  protected async retainAcceptance(
    caller: Caller,
    unitId: string,
    body: AcceptanceBody,
    at: string,
    tx: Transaction,
  ) {
    if (body.code)
      await this.code.retainStoredCommit(tx, {
        projectId: caller.projectId,
        actorId: caller.actorId,
        key: `unit:${unitId}`,
        ...(body.storage === 'code' ? { ref: resultRef(unitId), mirror: true } : {}),
        unitId,
        commit: body.code.commit,
        storage: body.storage === 'code' ? 'code' : 'external',
        ...(body.receipt ? { receipt: body.receipt } : {}),
      });
  }

  /** What the sealed publication of this unit says now; null while nothing declared one. */
  protected async publicationOf(
    sql: Sql,
    projectId: string,
    row: UnitRow,
  ): Promise<CodeUnitPublication | null> {
    if (!row.publication_id)
      // Declared to publish, accepted, and nothing opened: its own facts could not be sealed.
      return row.publishes_at && row.acceptance_json ? { state: 'unsealed' } : null;
    const publication = await sql.get<PublicationRow>(
      'SELECT record_json,pull_json,merge_json,incident_json,error,stale,verified FROM code_publications WHERE proposal_id=? AND project_id=?',
      row.publication_id,
      projectId,
    );
    if (!publication) return null;
    const { destination } = JSON.parse(publication.record_json) as {
      destination?: 'local' | 'github';
    };
    const pull = publication.pull_json
      ? (JSON.parse(publication.pull_json) as GitHubPullRequest)
      : null;
    const merge = publication.merge_json
      ? (JSON.parse(publication.merge_json) as { commitSha: string | null })
      : null;
    const mergeCommit = merge?.commitSha ?? pull?.mergeCommitSha ?? null;
    const state = publication.incident_json
      ? 'incident'
      : Number(publication.verified)
        ? 'published'
        : Number(publication.stale)
          ? 'stale'
          : pull && pull.state === 'closed' && !pull.merged
            ? 'closed'
            : // A sync failing before any pull request opens waits on an operator, not the server.
              !pull && publication.error
              ? 'setup_required'
              : 'pending';
    return {
      state,
      ...(destination ? { destination } : {}),
      ...(pull ? { pull: { number: pull.number, url: pull.url } } : {}),
      ...(state === 'published' && mergeCommit ? { mergeCommit } : {}),
    };
  }
  protected acceptance(row: UnitRow): CodeUnitAcceptance | null {
    return row.acceptance_json === null
      ? null
      : this.acceptanceValue(
          JSON.parse(row.acceptance_json),
          row.acceptance_hash!,
          row.accepted_at!,
        );
  }

  private acceptanceValue(
    body: AcceptanceBody,
    hash: string,
    acceptedAt: string,
  ): CodeUnitAcceptance {
    return {
      unitId: body.unitId,
      hash: hash,
      acceptedAt: acceptedAt,
      terminalRevision: body.terminalRevision,
      submissionRef: body.submissionRef,
      reviewRef: body.reviewRef,
      acceptedBy: body.acceptedBy,
      reference: body.code?.commit ?? null,
      reviewAttached: body.code?.reviewAttached ?? null,
      storage: body.storage,
      ...(body.receipt ? { receipt: body.receipt } : {}),
    };
  }

  protected pin(row: UnitRow): CodeBasePin | null {
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

  close(): void {
    this.closed = true;
  }

  protected assertOpen(): void {
    check(!this.closed, 'code_unavailable', 'Code is unavailable', 503);
  }
  protected async record(tx: Transaction, row: UnitRow): Promise<CodeUnit> {
    const base = this.pin(row);
    return {
      unitId: row.unit_id,
      workflow: row.workflow,
      version: Number(row.version),
      declaredAt: row.declared_at,
      branch: workBranch(row.unit_id),
      base,
      baseStatus: base ? { status: 'pinned', pin: base } : null,
      acceptance: this.acceptance(row),
      publication: await this.publicationOf(tx, row.project_id, row),
      ...(await this.writers.facts(tx, row.project_id, row.unit_id)),
    };
  }

  protected async retainDeclaration(
    caller: Caller,
    input: {
      unitId: string;
      workflow: string;
      version: number;
      baseReference?: string;
      derivationInputs?: string[];
    },
    tx: Transaction,
  ): Promise<UnitRow> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    const { unitId, baseReference, derivationInputs } = input;
    await this.code.declareWorkspace(caller, { unitId }, tx);
    const row = await this.row(tx, caller.projectId, unitId);
    if (!row) await this.insertUnit(tx, caller.projectId, input, now());
    if (baseReference !== undefined) {
      check(
        !(await tx.get(
          'SELECT 1 FROM code_unit_frontiers WHERE project_id=? AND unit_id=?',
          caller.projectId,
          unitId,
        )),
        'code_base_conflict',
        'A declared frontier cannot be replaced by a fixed input',
        409,
      );
      check(
        !caller.session && oid.test(baseReference),
        'invalid_base',
        'Only an owner can declare a fixed unit input',
        403,
      );
      const existing = await tx.get<{ reference: string }>(
        'SELECT reference FROM code_unit_inputs WHERE project_id=? AND unit_id=?',
        caller.projectId,
        unitId,
      );
      check(
        !existing || existing.reference === baseReference,
        'code_base_conflict',
        'This unit already has another fixed input',
        409,
      );
      if (!existing)
        await tx.run(
          'INSERT INTO code_unit_inputs(project_id,unit_id,reference) VALUES (?,?,?)',
          caller.projectId,
          unitId,
          baseReference,
        );
    }
    if (derivationInputs !== undefined) {
      check(
        baseReference === undefined,
        'invalid_base',
        'A unit has either fixed or derived inputs',
      );
      const inputs = [...new Set(derivationInputs)].sort();
      const existing = await tx.get<{ inputs_json: string }>(
        'SELECT inputs_json FROM code_unit_frontiers WHERE project_id=? AND unit_id=?',
        caller.projectId,
        unitId,
      );
      check(
        existing ? existing.inputs_json === canonical(inputs) : !row,
        'code_base_conflict',
        'The declared unit frontier cannot change',
        409,
      );
      if (!existing)
        await tx.run(
          'INSERT INTO code_unit_frontiers(project_id,unit_id,inputs_json) VALUES (?,?,?)',
          caller.projectId,
          unitId,
          canonical(inputs),
        );
    }
    return (await this.row(tx, caller.projectId, unitId))!;
  }

  protected async retainBase(
    caller: Caller,
    input: { unitId: string; workflow: string; version: number; leaseId: string; body: BaseBody },
    tx: Transaction,
  ): Promise<CodeBasePin> {
    this.state.assertTransaction(tx);
    const { unitId, leaseId, body } = input;
    const existing = await this.row(tx, caller.projectId, unitId);
    const at = now();
    if (!existing) await this.insertUnit(tx, caller.projectId, input, at);
    await tx.run(
      'UPDATE code_units SET base_json=?,base_hash=?,base_lease_id=?,based_at=? WHERE project_id=? AND unit_id=? AND base_json IS NULL',
      canonical(body),
      digest(body),
      leaseId,
      at,
      caller.projectId,
      unitId,
    );
    const stored = (await this.row(tx, caller.projectId, unitId))!;
    await this.code.pinWorkspace(
      caller,
      { unitId, reference: (JSON.parse(stored.base_json!) as BaseBody).reference },
      tx,
    );
    await this.code.retainStoredCommit(tx, {
      projectId: caller.projectId,
      key: `pin:${unitId}`,
      unitId,
      commit: (JSON.parse(stored.base_json!) as BaseBody).reference,
      storage: 'external',
      createdAt: stored.based_at!,
    });
    if (stored.base_lease_id === leaseId)
      for (const target of [
        ...body.sources.map((item) => `acceptance:${item.unitId}@${item.acceptanceHash}`),
        ...(body.main ? [`main:${body.main.oid}`] : []),
      ])
        await tx.run(
          'INSERT INTO code_edges (project_id,source_ref,relation,target_ref,created_at) VALUES (?,?,?,?,?)',
          caller.projectId,
          `unit:${unitId}`,
          'based_on',
          target,
          at,
        );
    return this.pin(stored)!;
  }

  protected async retainUnitAcceptance(
    caller: Caller,
    body: AcceptanceBody,
    tx: Transaction,
  ): Promise<UnitRow> {
    this.state.assertTransaction(tx);
    const hash = digest(body);
    const existing = await this.row(tx, caller.projectId, body.unitId);
    if (existing?.acceptance_hash) {
      check(
        existing.acceptance_hash === hash,
        'code_acceptance_conflict',
        'This unit already has a different acceptance',
        409,
      );
      return existing;
    }
    const at = now();
    if (!existing) await this.insertUnit(tx, caller.projectId, body, at);
    await this.writeAcceptance(caller, body, at, tx);
    return (await this.row(tx, caller.projectId, body.unitId))!;
  }

  private async insertUnit(
    tx: Transaction,
    projectId: string,
    unit: { unitId: string; workflow: string; version: number },
    at: string,
  ): Promise<void> {
    await tx.run(
      'INSERT INTO code_units (project_id,unit_id,workflow,version,declared_at) VALUES (?,?,?,?,?)',
      projectId,
      unit.unitId,
      unit.workflow,
      unit.version,
      at,
    );
  }

  /** Store the accepted identity and its durable Git ref together. */
  private async writeAcceptance(
    caller: Caller,
    body: AcceptanceBody,
    at: string,
    tx: Transaction,
  ): Promise<void> {
    await tx.run(
      'UPDATE code_units SET acceptance_json=?,acceptance_hash=?,accepted_at=? WHERE project_id=? AND unit_id=? AND acceptance_json IS NULL',
      canonical(body),
      digest(body),
      at,
      caller.projectId,
      body.unitId,
    );
    await this.retainAcceptance(caller, body.unitId, body, at, tx);
  }
}
