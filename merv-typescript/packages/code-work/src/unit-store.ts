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
  type Scope,
  type Sql,
  type State,
  type Transaction,
  oidPattern,
} from '@merv/contracts';
import type { WorkflowProvidedBlockerInput } from '@merv/workflows/models';
import type { CodeWriterService } from '@merv/code/writers';
import { resultRef, workBranch } from '@merv/code/store/refs';
import type {
  CodeBasePin,
  CodeBaseStatus,
  CodeUnitPublication,
  CodeProjectStatus,
  CodeUnit,
  CodeUnitAcceptance,
  CodeUnitStanding,
  CodeCaptureRef,
} from './models.js';

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
const publicationColumns =
  'p.record_json,p.pull_json,p.merge_json,p.incident_json,p.error,p.stale,p.verified';
/** A unit with its one word, read from its own fields. */
export const withStanding = (unit: Omit<CodeUnit, 'standing'>): CodeUnit => ({
  ...unit,
  standing: standingOf(unit),
});
/** Quarantine first, because nothing the unit holds may be reused again. */
function standingOf(unit: Omit<CodeUnit, 'standing'>): CodeUnitStanding {
  const base = unit.baseStatus;
  if (
    unit.quarantine ||
    (base?.status === 'blocked' &&
      base.blockers.some((blocker) => blocker.code === 'code_quarantined'))
  )
    return 'quarantined';
  if (unit.acceptance) return unit.acceptance.reference ? 'accepted' : 'artifacts only';
  if (!base) return 'ended';
  if (base.status !== 'pinned') return base.status;
  if (unit.writerState === 'recovery_required') return 'held';
  return unit.generation > 0 ? 'working' : 'ready';
}

/** A publication's standing, before the blockers it holds its unit's work for are said. */
export type PublicationStanding = Omit<CodeUnitPublication, 'blockers'>;
/**
 * The blocker code of each standing that holds a unit's work; a pending local integration has
 * its own. A publication wait is the one opinion Code keeps about work that has ended.
 */
const PUBLICATION_CODE = {
  pending: 'code_publication_pending',
  stale: 'code_publication_stale',
  setup_required: 'code_publication_setup_required',
  disabled: 'code_publication_disabled',
  closed: 'code_publication_closed',
  unsealed: 'code_publish_unverifiable',
  incident: 'code_publication_incident',
} as const;
export const PUBLICATION_CODES: ReadonlySet<string> = new Set(Object.values(PUBLICATION_CODE));
/**
 * What an open publication means for the unit that is waiting on it. A done unit carrying one
 * of these is not failing and is not work anybody can take: it is a fact about where its
 * accepted code stands, and every one of them names who ends the wait.
 */
export function publicationBlockers(
  publication: PublicationStanding,
): WorkflowProvidedBlockerInput[] {
  if (publication.state === 'published') return [];
  const pull = publication.pull;
  const named = pull ? ` (pull request #${pull.number})` : '';
  const related = pull ? [{ kind: 'pull-request', id: pull.url, label: `#${pull.number}` }] : [];
  const said = {
    pending: {
      code:
        publication.destination === 'local'
          ? 'code_publication_local_pending'
          : PUBLICATION_CODE.pending,
      message:
        publication.destination === 'local'
          ? 'waiting for the reviewed commit to be integrated into Merv main'
          : 'waiting on publication: a signed-in operator merges the pull request',
      next:
        publication.destination === 'local'
          ? 'Nothing: Code integrates the reviewed commit by itself within a minute, as the project owner; a project with no owner needs code.publication.sync. No GitHub connection is required.'
          : pull
            ? `A signed-in project operator merges pull request #${pull.number} with code.publication.merge; nothing here is owed by an agent.`
            : 'Nothing: Code opens the pull request by itself within a minute, as the project owner (a project with no owner needs code.publication.sync), and a signed-in operator merges it.',
    },
    stale: {
      code: PUBLICATION_CODE.stale,
      message: `main moved; a successor task integrates it${named}`,
      next: 'Create the successor work that takes this accepted commit and the newer main; this unit stays as it is.',
    },
    setup_required: {
      code: PUBLICATION_CODE.setup_required,
      message: `publication setup is incomplete${named}`,
      next: "An operator fixes what code.status names (the publication's lastError, its required merge-safety check or rules visibility); Code then continues and a signed-in operator merges the reviewed pull request.",
    },
    disabled: {
      code: PUBLICATION_CODE.disabled,
      message: `publication was disabled after failed enforcement${named}`,
      next: 'An administrator repairs enforcement, records a passing canary for this App and its rules, and clears any disablement with code.publication.control.',
    },
    closed: {
      code: PUBLICATION_CODE.closed,
      message: `the pull request was closed without merging${named}`,
      next: 'An operator creates the successor work that carries this accepted commit to main.',
    },
    unsealed: {
      code: PUBLICATION_CODE.unsealed,
      message:
        'this unit was declared to publish to main, but its acceptance could not open a publication',
      next: 'An administrator reads code.status for this unit and creates the successor work that carries its accepted code to main; this unit stays as it is.',
    },
    incident: {
      code: PUBLICATION_CODE.incident,
      message: `a publication incident is retained for this unit${named}`,
      next: 'An administrator investigates the observed merge commit in code.status.publication; a retry never clears it.',
    },
  }[publication.state];
  return [{ key: 'publication', status: 409, related, ...said }];
}
/** What a stored publication says of itself, before any enforcement is read. */
function storedPublication(publication: PublicationRow): PublicationStanding {
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
/** The acceptance a row retains; null until the unit is accepted. */
export function acceptance(row: UnitRow): CodeUnitAcceptance | null {
  if (row.acceptance_json === null) return null;
  const body = JSON.parse(row.acceptance_json) as AcceptanceBody;
  return {
    unitId: body.unitId,
    hash: row.acceptance_hash!,
    acceptedAt: row.accepted_at!,
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
/** The base pin a row retains; null until one is pinned. */
export function pin(row: UnitRow): CodeBasePin | null {
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
export const unitColumns =
  'project_id,unit_id,workflow,version,declared_at,base_json,base_hash,base_lease_id,based_at,acceptance_json,acceptance_hash,accepted_at,quarantine_base_key,publishes_at,publication_id';

/**
 * What the work-unit policy adds when a unit is read: the enforcement a pending publication is
 * held by, and the base a unit still waiting for one would be given now.
 */
export interface UnitReadPolicy {
  publication(
    sql: Sql,
    projectId: string,
    stored: PublicationStanding | null,
  ): Promise<PublicationStanding | null>;
  baseStatus(
    tx: Transaction,
    row: UnitRow,
    base: CodeBasePin | null,
  ): Promise<CodeBaseStatus | null>;
}

/** Durable Code records. Work-unit owners supply already validated facts in their transaction. */
export class WorkUnitRecords {
  closed = false;
  /** `code` is Code's own unit store, already initialized; it outlives this owner. */
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly writers: CodeWriterService,
    private readonly code: CodeUnitStore,
    private readonly policy: UnitReadPolicy,
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
    return row ? pin(row) : null;
  }

  /**
   * The commit a writer of this unit starts from now: the newest Code admitted for it, else its
   * pinned base; null before a pin. A pure read too, so a step that only reads, such as a design
   * written against the code that will run, is shown exactly that.
   */
  async resumesFrom(caller: Caller, unitId: string, tx: Transaction): Promise<string | null> {
    const base = await this.basePin(caller, unitId, tx);
    if (!base) return null;
    return (await this.writers.facts(tx, caller.projectId, unitId)).canonicalHead ?? base.reference;
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
      const project = await this.code.project(tx, caller.projectId);
      check(project, 'code_project_unbound', 'This project has no Code binding', 409);
      const candidates: { unitId: string; commit: string; quarantined: boolean }[] = [];
      const rows = await tx.all<UnitRow>(
        `SELECT ${unitColumns} FROM code_units WHERE project_id=? AND acceptance_json IS NOT NULL ORDER BY unit_id`,
        caller.projectId,
      );
      // Only a consolidation, a unit declared to publish to main, has a pull request.
      const published = await tx.all<PublicationRow & { unit_id: string }>(
        `SELECT u.unit_id,${publicationColumns} FROM code_units u JOIN code_publications p ON p.project_id=u.project_id AND p.proposal_id=u.publication_id WHERE u.project_id=? AND u.publishes_at IS NOT NULL AND u.acceptance_json IS NOT NULL`,
        caller.projectId,
      );
      const units = new Map(rows.map((row) => [row.unit_id, row]));
      const rejected = new Set<string>();
      for (const publication of published)
        if (storedPublication(publication).state === 'closed') {
          rejected.add(publication.unit_id);
          const row = units.get(publication.unit_id);
          if (row) pin(row)?.sources.forEach((source) => rejected.add(source.unitId));
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
  async readStatus(caller: Caller, tx: Transaction): Promise<CodeProjectStatus> {
    await this.scope.require(caller, 'read', tx);
    return {
      project: await this.code.project(tx, caller.projectId),
      store: null,
      operations: [],
      mirror: null,
      warnings: await this.code.warnings(tx, caller.projectId),
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

  /** Read once per snapshot, or per write transaction until it writes; each caller gets a copy. */
  async row(sql: Sql, projectId: string, unitId: string): Promise<UnitRow | undefined> {
    const row = await this.state.remember(`code-work:unit:${projectId}:${unitId}`, () =>
      sql.get<UnitRow>(
        `SELECT ${unitColumns} FROM code_units WHERE project_id=? AND unit_id=?`,
        projectId,
        unitId,
      ),
    );
    return row && { ...row };
  }

  private async retainAcceptance(
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

  /** What the sealed publication of this unit says now, as the policy reads it. */
  async publicationOf(
    sql: Sql,
    projectId: string,
    row: UnitRow,
  ): Promise<PublicationStanding | null> {
    const stored = await this.storedPublicationOf(sql, projectId, row);
    return await this.policy.publication(sql, projectId, stored);
  }
  /** What the sealed publication of this unit says of itself; null while nothing declared one. */
  private async storedPublicationOf(
    sql: Sql,
    projectId: string,
    row: UnitRow,
  ): Promise<PublicationStanding | null> {
    if (!row.publication_id)
      // Declared to publish, accepted, and nothing opened: its own facts could not be sealed.
      return row.publishes_at && row.acceptance_json ? { state: 'unsealed' } : null;
    const publication = await sql.get<PublicationRow>(
      `SELECT ${publicationColumns} FROM code_publications p WHERE proposal_id=? AND project_id=?`,
      row.publication_id,
      projectId,
    );
    return publication ? storedPublication(publication) : null;
  }

  close(): void {
    this.closed = true;
  }

  assertOpen(): void {
    check(!this.closed, 'code_unavailable', 'Code is unavailable', 503);
  }
  async record(tx: Transaction, row: UnitRow): Promise<CodeUnit> {
    const base = pin(row);
    const publication = await this.publicationOf(tx, row.project_id, row);
    const facts = await this.writers.facts(tx, row.project_id, row.unit_id);
    return withStanding({
      unitId: row.unit_id,
      workflow: row.workflow,
      version: Number(row.version),
      declaredAt: row.declared_at,
      branch: workBranch(row.unit_id),
      base,
      baseStatus: await this.policy.baseStatus(tx, row, base),
      acceptance: acceptance(row),
      publication: publication && {
        ...publication,
        blockers: publicationBlockers(publication),
      },
      ...facts,
    });
  }

  async retainDeclaration(
    caller: Caller,
    input: {
      unitId: string;
      workflow: string;
      version: number;
      baseReference?: string;
    },
    tx: Transaction,
  ): Promise<UnitRow> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    const { unitId, baseReference } = input;
    await this.code.declareWorkspace(caller, { unitId }, tx);
    const row = await this.row(tx, caller.projectId, unitId);
    if (!row) await this.insertUnit(tx, caller.projectId, input, now());
    if (baseReference !== undefined) {
      check(
        !caller.session && oidPattern.test(baseReference),
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
    return (await this.row(tx, caller.projectId, unitId))!;
  }

  async retainBase(
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
    return pin(stored)!;
  }

  async retainUnitAcceptance(
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
