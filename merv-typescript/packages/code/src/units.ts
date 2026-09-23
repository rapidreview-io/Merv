import { OperationJournal } from './operation-journal.js';
import {
  canonical,
  check,
  codeLocalBindInputSchema,
  digest,
  inTransaction,
  mapAsync,
  newId,
  now,
  recorded,
  type Caller,
  type CodeBasePin,
  type CodeUnitPublication,
  type GitHubPullRequest,
  type CodeLocalBindInput,
  type CodeProjectBinding,
  type CodeProjectStatus,
  type CodeStoreWarning,
  type CodeUnit,
  type CodeUnitAcceptance,
  type Scope,
  type Sql,
  type State,
  type Transaction,
} from '@merv/contracts';
import { migratePendingMerges } from './pending-merge.js';
import { postgresMigrations } from './units.postgres.js';
import { migratePublications } from './publications-schema.js';
import { migrateBases } from './base-schema.js';
import { parseCodeInput } from './input.js';
import type { CodeCaptureRef } from '@merv/contracts/types';
import type { CodeWriterService } from './writers.js';
import { acceptedRef, workBranch } from './store/refs.js';

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
  pull_json: string | null;
  merge_json: string | null;
  incident_json: string | null;
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

/** Durable Code records. Research owners supply already validated facts in their transaction. */
export class CodeUnitStore {
  protected closed = false;
  constructor(
    protected readonly state: State,
    protected readonly scope: Scope,
    protected readonly writers: CodeWriterService,
  ) {}

  /** Complete storage migrations before publishing this service. */
  async initialize(): Promise<void> {
    await this.state.migrate('code_units', [
      {
        version: 1,
        sql: postgresMigrations[1],
      },
      {
        version: 2,
        sql: postgresMigrations[2],
      },
      {
        // Publishing to main is declared once on the unit and, once sealed, its publication is
        // immutable. Version 2 shipped on 2026-09-22 before these columns existed.
        version: 3,
        sql: postgresMigrations[3],
      },
      {
        // The binding is still not something a writer may edit; it is now something exactly one
        // operation may. Naming a prepared rebind would not be enough on its own: it would let
        // any writer put any value in repository_id, and would leave binding_json rewritable in
        // that window — including rewriting `previous`, the list that keeps every pre-rebind
        // acceptance valid at derive(), and a forged entry there is how an acceptance stamped
        // with a foreign repository would pass that gate. So the value written must be the one
        // the operation was journalled with (payload_json is immutable under
        // code_operations_identity), and the new lineage must be the old one exactly, with one
        // entry appended that names the repository being left. A subquery in a WHEN clause is
        // already how code_units_generation_open reads code_operations, in version 1.
        version: 4,
        sql: postgresMigrations[4],
      },
    ]);
    await migratePendingMerges(this.state);
    await migratePublications(this.state);
    await migrateBases(this.state);
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
   * asked once, outside every transaction, by whoever holds the repository.
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
      for (const row of await tx.all<UnitRow>(
        `SELECT ${unitColumns} FROM code_units WHERE project_id=? AND acceptance_json IS NOT NULL ORDER BY unit_id`,
        caller.projectId,
      )) {
        const accepted = JSON.parse(row.acceptance_json!) as AcceptanceBody;
        // A code-less success is nothing main could be missing. A legacy acceptance is code
        // this repository holds as soon as it was imported, which is the same question
        // derive() asks before it will build on one; only what was never imported is unasked.
        if (!accepted.code) continue;
        if (
          accepted.storage !== 'code' &&
          !(await tx.get(
            "SELECT id FROM code_operations WHERE project_id=? AND kind='import' AND status='completed' AND result_json LIKE ? LIMIT 1",
            caller.projectId,
            `%"head":"${accepted.code.commit}"%`,
          ))
        )
          continue;
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
    this.assertOpen();
    caller = structuredClone(caller);
    const input = parseCodeInput(codeLocalBindInputSchema, value);
    return await inTransaction(this.state, tx, async (tx) => {
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
      const journal = new OperationJournal(tx, caller.projectId, principal, requestId, inputHash);
      const previous = await journal.previous();
      if (previous) {
        // Every bind journalled before the lineage existed stored a result without `previous`,
        // and the contract now says the field is always there: the journal stays byte-identical
        // and the answer is normalised on the way out.
        const replayed = JSON.parse(previous.result_json) as CodeProjectBinding;
        return { ...replayed, previous: replayed.previous ?? [] };
      }
      const operationId = newId('cop'),
        at = now();
      const main = canonical({
        oid: input.mainOid,
        admittedBy: caller.actorId,
        admittedAt: at,
        operationId,
        ...(stored ? { stored: true } : {}),
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
          'This project is bound to another repository; code.repository.rebind changes the binding after verifying that Code holds the project’s history',
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
      await this.writers.changes.emit({ kind: 'binding', projectId: caller.projectId }, tx);
      const result = (await this.project(tx, caller.projectId))!;
      await journal.complete(operationId, 'local_bind', payload, result, at);
      await recorded(this.state, tx, caller, 'code.local_bound', caller.projectId, {
        operationId,
        repositoryId: input.repositoryId,
        mainOid: input.mainOid,
        previousMainOid: bound?.main.oid ?? null,
      });
      return result;
    });
  }

  async hosted(caller: Caller, tx: Transaction): Promise<boolean> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    caller = structuredClone(caller);
    await this.scope.require(caller, 'read', tx);
    return (await this.project(tx, caller.projectId))?.durability === 'code';
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

  protected async project(sql: Sql, projectId: string): Promise<CodeProjectBinding | null> {
    const row = await sql.get<ProjectRow>(
      'SELECT project_id,repository_id,binding_json,main_json,store_json FROM code_projects WHERE project_id=?',
      projectId,
    );
    if (!row) return null;
    const binding = JSON.parse(row.binding_json) as {
      boundBy: string;
      boundAt: string;
      previous?: CodeProjectBinding['previous'];
    };
    const main = JSON.parse(row.main_json) as CodeProjectBinding['main'];
    return {
      mode: 'local',
      repositoryId: row.repository_id,
      boundBy: binding.boundBy,
      boundAt: binding.boundAt,
      previous: binding.previous ?? [],
      main: {
        oid: main.oid,
        admittedBy: main.admittedBy,
        admittedAt: main.admittedAt,
        stored: main.stored === true,
      },
      // Once imported a project stays with Code's repository: a main it does not hold yet
      // blocks work, it never sends new work back to a runner's own repository.
      durability: row.store_json === null ? 'legacy-local' : 'code',
    };
  }

  protected async row(sql: Sql, projectId: string, unitId: string): Promise<UnitRow | undefined> {
    return await sql.get<UnitRow>(
      `SELECT ${unitColumns} FROM code_units WHERE project_id=? AND unit_id=?`,
      projectId,
      unitId,
    );
  }

  protected async retainAcceptance(
    caller: Caller,
    unitId: string,
    body: AcceptanceBody,
    at: string,
    tx: Transaction,
  ) {
    const { code, receipt } = body;
    if (receipt && code) {
      // The ref the acceptance is kept under is made after this transaction, by the journal.
      const payload = {
        format: 1,
        source: 'accept-ref',
        actorId: caller.actorId,
        unitId,
        tip: code.commit,
      };
      await tx.run(
        'INSERT INTO code_operations (id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,created_at,unit_id,phase,progress_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        newId('cop'),
        caller.projectId,
        'system:code',
        `accept-ref:${unitId}`,
        'accept-ref',
        digest(payload),
        canonical(payload),
        'prepared',
        at,
        unitId,
        'objects_durable',
        canonical({
          received: 0,
          expectedOld: null,
          target: code.commit,
          receiptRef: acceptedRef(unitId),
        }),
        at,
      );
    }
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
      'SELECT pull_json,merge_json,incident_json,stale,verified FROM code_publications WHERE proposal_id=? AND project_id=?',
      row.publication_id,
      projectId,
    );
    if (!publication) return null;
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
            : 'pending';
    return {
      state,
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

  protected async retainReviewAcceptance(
    caller: Caller,
    body: AcceptanceBody,
    tx: Transaction,
  ): Promise<CodeUnitAcceptance> {
    this.state.assertTransaction(tx);
    const encoded = canonical(body),
      hash = digest(body);
    const existing = await tx.get<{ acceptance_json: string; accepted_at: string }>(
      'SELECT acceptance_json,accepted_at FROM code_review_acceptances WHERE project_id=? AND unit_id=? AND review_id=?',
      caller.projectId,
      body.unitId,
      body.reviewRef,
    );
    check(
      !existing || existing.acceptance_json === encoded,
      'code_acceptance_conflict',
      'This review already accepted different code',
      409,
    );
    const at = existing?.accepted_at ?? now();
    if (!existing)
      await tx.run(
        'INSERT INTO code_review_acceptances(project_id,unit_id,review_id,acceptance_json,accepted_at) VALUES(?,?,?,?,?)',
        caller.projectId,
        body.unitId,
        body.reviewRef,
        encoded,
        at,
      );
    return this.acceptanceValue(body, hash, at);
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

  protected async retainPublishedAcceptance(
    caller: Caller,
    unitId: string,
    reviewId: string,
    revision: number,
    tx: Transaction,
  ) {
    this.state.assertTransaction(tx);
    const round = await tx.get<{ acceptance_json: string; accepted_at: string }>(
      'SELECT acceptance_json,accepted_at FROM code_review_acceptances WHERE project_id=? AND unit_id=? AND review_id=?',
      caller.projectId,
      unitId,
      reviewId,
    );
    check(
      round,
      'code_acceptance_unverifiable',
      'The approved publication acceptance is missing',
      409,
    );
    const body: AcceptanceBody = {
      ...JSON.parse(round.acceptance_json),
      terminalRevision: revision,
    };
    await this.writeAcceptance(caller, body, round.accepted_at, tx);
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

  /** Store the accepted identity and its durable Git ref together for either publication path. */
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
