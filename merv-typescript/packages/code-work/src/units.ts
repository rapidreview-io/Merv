import { baseKey } from './base-plan.js';
import { admissionCause, blockerGroup, whoseOf } from './blockers.js';
import { pendingMerge, pinMerge } from '@merv/code/pending-merge';
import type { CodeWriterService } from '@merv/code/writers';
import type { CodeUnitStore } from '@merv/code/units';
import {
  canonical,
  check,
  digest,
  MervError,
  newId,
  now,
  type Caller,
  type Scope,
  type Sql,
  type State,
  type StoredEvent,
  type Transaction,
  type Workflows,
  oidPattern,
} from '@merv/contracts';
import type {
  WorkflowProvidedBlockerInput,
  WorkflowRelation,
  WorkflowRelations,
} from '@merv/workflows/models';
import { checkFailure } from './base-check.js';
import { INHERITED_QUARANTINE, type CodeBaseService } from './bases.js';
import { resolutionProvenance } from './provenance.js';
import { publicationControls, publicationGate } from './publication-host.js';
import type { CodeUnitPublicationSeal } from './publications.js';
import type {
  CodeCapture,
  CodeCaptureRef,
  CodeCaptures,
  ResolutionInput,
  ResolutionWork,
  ResolutionWorkCreator,
} from './types.js';

import {
  WorkUnitRecords,
  acceptance,
  pin,
  publicationBlockers,
  type PublicationStanding,
  unitColumns,
  type AcceptanceBody,
  type BaseBody,
  type UnitRow,
} from './unit-store.js';
import type {
  CodeBaseRecord,
  CodeBasePin,
  CodeBaseStatus,
  CodeProjectStatus,
  CodeUnit,
  CodeUnitAcceptance,
  CodeUnitAcceptInput,
} from './models.js';

/** What a derivation finds; only `ready` carries a body a lease may pin. */
type Derived =
  | { status: 'waiting' }
  /** `merge` names the accepted commits a base has still to be made from. */
  | { status: 'blocked'; blockers: WorkflowProvidedBlockerInput[]; merge?: string[] }
  | { status: 'ready'; body: BaseBody; merge?: string[] };
const PROVIDER = 'code';
const EXPLICIT_BASE =
  'Import the project repository into managed Code, then create new work with accepted code prerequisites in dependsOn';
const IMPORT = 'An administrator imports it with `merv code-import`';
/**
 * The units a project pass derives again: those still waiting for a base, and those whose
 * publication has not settled. A settled one's blocker never changes again, so it is skipped.
 */
const RECONCILED =
  '(base_json IS NULL AND acceptance_json IS NULL) OR publication_id IN (SELECT proposal_id FROM code_publications WHERE settled=0)';

/** Work-unit policy for durable Code records; absent deployments do not install this integration. */
export class CodeUnitService {
  /** The durable unit records this policy reads through and retains facts in. */
  readonly records: WorkUnitRecords;
  /** Set by Code Work's start, before anything derives a unit: where several commits merge. */
  bases!: CodeBaseService;
  /** Set by Code Work's start: the journal that carries an accepted unit to main. */
  publications!: {
    openUnit(caller: Caller, input: CodeUnitPublicationSeal, tx: Transaction): Promise<void>;
  };
  resolutionTasks?: ResolutionWorkCreator;
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly workflows: Workflows,
    private readonly captures: Pick<CodeCaptures, 'capture'>,
    private readonly writers: CodeWriterService,
    /** Code's own unit store, already initialized; it outlives this owner. */
    readonly code: CodeUnitStore,
    private readonly sessions: Pick<import('@merv/sessions/types').Sessions, 'contributors'>,
    private readonly reviews: Pick<import('@merv/contracts').Reviews, 'get'>,
  ) {
    this.records = new WorkUnitRecords(state, scope, writers, code, {
      publication: (sql, projectId, stored) => this.enforcedPublication(sql, projectId, stored),
      baseStatus: (tx, row, base) => this.derivedBaseStatus(tx, row, base),
    });
  }

  /** Complete storage migrations before publishing this service. */
  async initialize(): Promise<void> {
    await this.records.initialize();
  }
  close(): void {
    this.records.close();
  }

  reviewProvenance(projectId: string, taskId: string, tx: Transaction) {
    check(
      !this.records.closed,
      'code_provenance_unverifiable',
      'Base provenance is unavailable',
      503,
    );
    return resolutionProvenance(tx, this.bases, this.sessions, projectId, taskId);
  }

  async declareUnit(
    caller: Caller,
    unitId: string,
    tx: Transaction,
    baseReference?: string,
  ): Promise<CodeUnit> {
    this.records.assertOpen();
    this.state.assertTransaction(tx);
    caller = structuredClone(caller);
    await this.scope.require(caller, 'read', tx);
    const relations = await this.workflows.relations(caller.projectId, unitId, tx);
    check(relations, 'code_unit_not_found', 'No such unit of work in this project', 404);
    await this.records.retainDeclaration(
      caller,
      {
        unitId,
        workflow: relations.instance.workflow,
        version: relations.instance.version,
        baseReference,
      },
      tx,
    );
    // A unit that cannot start is shown from the moment it exists, not from its first poll.
    await this.reconcileUnit(tx, caller.projectId, unitId);
    return await this.records.record(tx, (await this.records.row(tx, caller.projectId, unitId))!);
  }

  /** A base's disposition also gates its resolution task, without changing Tasks' history. */
  private async resolutionBlocker(
    tx: Transaction,
    projectId: string,
    unitId: string,
  ): Promise<WorkflowProvidedBlockerInput | null> {
    const base = await this.bases.forTask(tx, projectId, unitId);
    if (!base || (!base.quarantined && !['suspended', 'cancelled'].includes(base.state)))
      return null;
    return {
      key: 'resolution-base',
      code: base.quarantined ? 'code_quarantined' : 'code_base_blocked',
      status: 409,
      message: `Resolution base ${base.key} is ${base.quarantined ? 'quarantined' : base.state}: ${base.operatorReason ?? 'operator control'}.`,
      next:
        base.state === 'suspended' && !base.quarantined
          ? 'An administrator uses code.base.resume before this resolution can continue.'
          : 'The base is retained but unusable; an administrator creates corrective work and replans the waiters.',
      related: [],
    };
  }

  /**
   * What a lease would find now. It never writes: lease admission, assignment checks and the
   * dispatch candidate scan all ask, and any of them may run for a caller who holds no lease.
   */
  async baseStatus(caller: Caller, unitId: string, tx: Transaction): Promise<CodeBaseStatus> {
    this.records.assertOpen();
    this.state.assertTransaction(tx);
    caller = structuredClone(caller);
    await this.scope.require(caller, 'read', tx);
    const disposition = await this.resolutionBlocker(tx, caller.projectId, unitId);
    if (disposition) return { status: 'blocked', blockers: [disposition] };
    const row = await this.records.row(tx, caller.projectId, unitId);
    if (row?.quarantine_base_key)
      return { status: 'blocked', blockers: [this.quarantineBlocker(row.quarantine_base_key)] };
    if (row?.base_json) return { status: 'pinned', pin: pin(row)! };
    return this.baseState(await this.derive(tx, caller.projectId, unitId));
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
    this.records.assertOpen();
    this.state.assertTransaction(tx);
    caller = structuredClone(caller);
    await this.scope.require(caller, 'read', tx);
    const disposition = await this.resolutionBlocker(tx, caller.projectId, unitId);
    if (disposition) throw new MervError(disposition.code, disposition.message, 409);
    const relations = await this.relations(tx, caller.projectId, unitId);
    const declared = relations.dependencies
      .filter((item) => item.kind !== 'system')
      .map((item) => item.id)
      .sort();
    const existing = await this.records.row(tx, caller.projectId, unitId);
    check(
      !existing?.quarantine_base_key,
      'code_quarantined',
      'This unit retains a quarantined base; corrective work must use a new unit',
      409,
    );
    if (existing?.base_json) {
      check(
        canonical((JSON.parse(existing.base_json) as BaseBody).dependencies) ===
          canonical(declared),
        'code_dependencies_changed',
        'The dependencies of this unit changed after its base was pinned',
        409,
      );
      return pin(existing)!;
    }
    const derived = await this.derive(tx, caller.projectId, unitId);
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
    const pinned = await this.records.retainBase(
      caller,
      {
        unitId,
        leaseId,
        body: derived.body,
        workflow: relations.instance.workflow,
        version: relations.instance.version,
      },
      tx,
    );
    await this.setBlockers(tx, caller.projectId, unitId, []);
    return pinned;
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
    const relations = await this.workflows.relations(caller.projectId, input.unitId, tx);
    check(
      relations &&
        relations.instance.settled &&
        relations.instance.revision === input.terminalRevision,
      'code_acceptance_unverifiable',
      'Only a unit approved by its owner at the named revision can be accepted',
      409,
    );
    const disposition = await this.resolutionBlocker(tx, caller.projectId, input.unitId);
    if (disposition) throw new MervError(disposition.code, disposition.message, 409);
    const health = await this.records.row(tx, caller.projectId, input.unitId);
    check(
      !health?.quarantine_base_key,
      'code_quarantined',
      'This unit retains a quarantined base and cannot be accepted',
      409,
    );
    const code =
      input.codeRef === null
        ? null
        : await this.reviewedCode(caller, input.unitId, input.codeRef, input.reviewSessionId, tx);
    // Reviewed code is accepted only as a commit Code admitted from the unit's own writer.
    let admitted: Awaited<ReturnType<CodeWriterService['receipt']>> = null;
    if (code) {
      const writer = await this.writers.row(tx, caller.projectId, input.unitId);
      check(
        writer && Number(writer.generation) >= 1,
        'code_acceptance_unverifiable',
        'Code never admitted the commit that was reviewed',
        409,
      );
      check(
        writer.quarantine_operation_id === null,
        'code_capture_quarantined',
        'A capture of this unit is quarantined; it cannot be accepted before an operator fences it',
        409,
      );
      admitted = await this.writers.receipt(tx, caller.projectId, input.unitId, code.commit);
      // A writer fenced before its branch ever moved kept the base it was pinned to.
      const kept =
        writer.writer_state === 'closed' &&
        writer.head_oid === null &&
        writer.base_json !== null &&
        code.commit === this.writers.base(writer);
      check(
        admitted || kept,
        'code_acceptance_unverifiable',
        'Code never admitted the commit that was reviewed',
        409,
      );
    }
    const pending = await pendingMerge(tx, caller.projectId, input.unitId);
    if (pending) {
      check(
        await this.resolutionReview(caller, tx, input),
        'code_provenance_unverifiable',
        'Resolution acceptance requires a passing review with the current retained contributor provenance.',
        409,
      );
      const verified = admitted?.merge;
      check(
        code &&
          verified?.firstMerge &&
          verified.firstMerge === pending.firstMerge &&
          verified.plan === pending.plan &&
          verified.left === pending.firstParent &&
          verified.right === pending.secondParent,
        'code_resolution_merge_required',
        'Resolution acceptance requires the admitted two-parent merge of the frozen inputs and its corrective first-parent lineage.',
        409,
      );
    }
    const body: AcceptanceBody = {
      formatVersion: 1,
      unitId: input.unitId,
      workflow: relations.instance.workflow,
      version: relations.instance.version,
      terminalRevision: input.terminalRevision,
      submissionRef: input.submissionRef,
      reviewRef: input.reviewRef,
      acceptedBy: caller.actorId,
      code,
      storage: code === null ? 'none' : 'code',
      ...(admitted ? { receipt: admitted.id } : {}),
    };
    const existing = await this.records.row(tx, caller.projectId, input.unitId);
    const stored = await this.records.retainUnitAcceptance(caller, body, tx);
    if (!existing?.acceptance_hash && stored.publishes_at)
      await this.sealPublication(caller, relations.instance.name, stored, body, digest(body), tx);
    this.bases.soon(caller.projectId);
    return acceptance(stored)!;
  }

  /**
   * Seals an immutable snapshot and the exact independent review. Local integration retains
   * that head on Merv main; GitHub publication adds a pull request and a signed-in operator's
   * merge. The accepted unit remains done while its integration is reconciled.
   *
   * A unit whose facts cannot open a publication is still accepted. Acceptance is the record
   * of work that was done and reviewed, and `publishes_at` is write-once, so refusing here
   * would refuse the review itself and leave work that could never be accepted by anyone.
   * The unit ends with a retained blocker naming the operator recovery instead.
   */
  private async sealPublication(
    caller: Caller,
    title: string,
    row: UnitRow,
    body: AcceptanceBody,
    acceptanceHash: string,
    tx: Transaction,
  ): Promise<void> {
    const base = row.base_json ? (JSON.parse(row.base_json) as BaseBody) : null;
    if (!(body.storage === 'code' && body.code?.tree) || !base?.main) {
      await this.reconcileUnit(tx, caller.projectId, row.unit_id);
      return;
    }
    const review = await this.reviews.get(caller, body.reviewRef, tx);
    const publicationId = newId('codeprop');
    await tx.run(
      'UPDATE code_units SET publication_id=? WHERE project_id=? AND unit_id=? AND publication_id IS NULL',
      publicationId,
      caller.projectId,
      row.unit_id,
    );
    await this.publications.openUnit(
      caller,
      {
        publicationId,
        unitId: row.unit_id,
        title,
        reviewId: body.reviewRef,
        baseOid: base.reference,
        headOid: body.code.commit,
        treeOid: body.code.tree,
        approval: {
          source: 'unit',
          integrationBase: base.main.oid,
          certificateHash: review.provenance?.hash ?? null,
          acceptanceHash,
        },
      },
      tx,
    );
    await this.reconcileUnit(tx, caller.projectId, row.unit_id);
  }

  /**
   * Records, once, that this unit's accepted code goes to main. It is a declaration and not a
   * power: integration requires independent review, and GitHub merges also require a signed-in
   * operator. The declaration is the operator's or directing agent's, never the worker's own.
   * It has to come before the
   * first lease, because main joins the base at derivation and a pin is immutable.
   */
  async publishOnAcceptance(
    caller: Caller,
    { unitId }: { unitId: string },
    tx: Transaction,
  ): Promise<CodeUnit> {
    this.records.assertOpen();
    this.state.assertTransaction(tx);
    caller = structuredClone(caller);
    // A leased worker holds `write`, which is how acceptance reaches Code from a reviewer
    // session, so the refusal is named here rather than left to the scope: nothing a worker
    // does may put its own branch on the road to main.
    check(
      !caller.session,
      'session_forbidden',
      'A leased worker cannot declare that its own work publishes to main',
      403,
    );
    await this.scope.require(caller, 'write', tx);
    const row = await this.records.row(tx, caller.projectId, unitId);
    check(row, 'code_unit_not_found', 'This unit of work has not been declared to Code', 404);
    if (!row.publishes_at) {
      const project = await this.code.project(tx, caller.projectId);
      check(
        project?.main.stored,
        'code_publish_unhosted',
        'Publishing to main needs Code to host this project and hold the commit that is main',
        409,
      );
      check(
        !row.acceptance_json,
        'code_publish_accepted',
        'This unit is already accepted; a successor publishes what it left',
        409,
      );
      check(
        !row.base_json &&
          !(await tx.get(
            'SELECT 1 FROM code_unit_inputs WHERE project_id=? AND unit_id=?',
            caller.projectId,
            unitId,
          )),
        'code_publish_based',
        'This unit already stands on a base that does not include main; a successor publishes what it left',
        409,
      );
      // The reads above name what is wrong in the ordinary case; the write repeats them, so a
      // lease or an acceptance committing between them cannot leave a unit marked to publish
      // while standing on a base that never took main — a state nothing could recover from.
      const marked = await tx.run(
        'UPDATE code_units SET publishes_at=? WHERE project_id=? AND unit_id=? AND publishes_at IS NULL AND base_json IS NULL AND acceptance_json IS NULL',
        now(),
        caller.projectId,
        unitId,
      );
      check(
        marked.changes === 1,
        'code_publish_based',
        'This unit took a base or an acceptance while publication was being declared; a successor publishes what it left',
        409,
      );
      await this.reconcileUnit(tx, caller.projectId, unitId);
    }
    return await this.records.record(tx, (await this.records.row(tx, caller.projectId, unitId))!);
  }

  private async reviewedCode(
    caller: Caller,
    unitId: string,
    ref: CodeCaptureRef,
    reviewSessionId: string | null,
    tx: Transaction,
  ): Promise<NonNullable<AcceptanceBody['code']>> {
    this.records.assertOpen();
    const capture = await this.captures.capture(caller, ref, tx);
    const workspace = capture.workspace;
    check(
      capture.status === 'ready' &&
        workspace &&
        capture.provenance.projectId === caller.projectId &&
        capture.provenance.instanceId === unitId &&
        !capture.provenance.readOnly &&
        oidPattern.test(workspace.headOid),
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
  async status(caller: Caller): Promise<CodeProjectStatus> {
    this.records.assertOpen();
    caller = structuredClone(caller);
    return await this.state.transaction(async (tx) => {
      const stored = await this.records.readStatus(caller, tx);
      return {
        ...stored,
        blockers: (await this.workflows.blockers(caller, undefined, tx))
          .filter((blocker) => blocker.provider === PROVIDER)
          .map((blocker) => ({ ...blocker, group: blockerGroup(blocker.code) })),
      };
    });
  }

  private async relations(
    tx: Transaction,
    projectId: string,
    unitId: string,
  ): Promise<WorkflowRelations> {
    const relations = await this.workflows.relations(projectId, unitId, tx);
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
  private async derive(tx: Transaction, projectId: string, unitId: string): Promise<Derived> {
    let relations = await this.relations(tx, projectId, unitId);
    relations = {
      ...relations,
      dependencies: relations.dependencies.filter((item) => item.kind !== 'system'),
    };
    if (relations.dependencies.some((item) => !item.settled)) return { status: 'waiting' };
    const pending = (
      key: string,
      message: string,
      next: string,
      related = [] as WorkflowRelation[],
    ) => ({
      key,
      code: 'code_base_pending',
      message,
      status: 409,
      next,
      related: related.map((item) => ({ kind: 'workflow', id: item.id, label: item.name })),
    });
    // Only hosted workflow versions declare units; the binding and imported store are retained.
    const bound = (await this.state.remember(`code-work:binding:${projectId}`, () =>
      this.code.binding(tx, projectId),
    ))!;
    const { main } = bound;
    const missingMain = async () => {
      const initializing = await this.code.initializing(tx, projectId);
      return pending(
        initializing ? 'initialization' : 'main',
        initializing
          ? 'Merv is initializing the project’s Git repository'
          : 'Code’s repository does not hold the commit that is main',
        initializing
          ? 'Initialization retries automatically. Check Code operations for a storage error if it remains pending; no GitHub connection or manual import is required.'
          : `${IMPORT}, or names an imported commit as main with code.local.bind.`,
      );
    };
    const publishing = !!(await this.records.row(tx, projectId, relations.instance.id))
      ?.publishes_at;
    const fixed = await tx.get<{ reference: string }>(
      'SELECT reference FROM code_unit_inputs WHERE project_id=? AND unit_id=?',
      projectId,
      relations.instance.id,
    );
    if (fixed)
      return {
        status: 'ready',
        body: {
          formatVersion: 1,
          kind: 'accepted',
          reference: fixed.reference,
          repositoryId: bound.repositoryId,
          dependencies: [],
          sources: [],
          main: null,
        },
      };
    const blockers: WorkflowProvidedBlockerInput[] = [];
    const commits = new Map<string, { sources: BaseBody['sources']; units: WorkflowRelation[] }>();
    const seen = new Set<string>();
    const queue = [...relations.dependencies];
    for (let node = queue.shift(); node; node = queue.shift()) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      const unit = await this.records.row(tx, projectId, node.id);
      const accepted = unit?.acceptance_json
        ? (JSON.parse(unit.acceptance_json) as AcceptanceBody)
        : null;
      if (unit?.quarantine_base_key) {
        blockers.push(this.quarantineBlocker(unit.quarantine_base_key));
        continue;
      }
      const intact = !accepted || digest(accepted) === unit!.acceptance_hash;
      if (intact && (accepted ? accepted.code === null : !node.declaresWorkspace)) {
        const below = await this.workflows.relations(projectId, node.id, tx);
        for (const child of (below?.dependencies ?? []).filter((item) => item.kind !== 'system'))
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
      if (!intact || !accepted?.code || !bound.repositoryIds.includes(accepted.code.repositoryId)) {
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
    // A unit that publishes to main is prepared from main as well: the integration everyone
    // would otherwise do after the review happens once, before the work starts, and a clash
    // with main becomes an ordinary resolution task instead of a stale publication. A unit
    // with no code-bearing dependency already starts from main, below.
    if (publishing && commits.size) {
      if (main.stored !== true) blockers.push(await missingMain());
      else if (!commits.has(main.oid)) commits.set(main.oid, { sources: [], units: [] });
    }
    const blocked = blockers.filter(
      (item, index) => blockers.findIndex((other) => other.key === item.key) === index,
    );
    if (blocked.length) return { status: 'blocked', blockers: blocked };
    const related = [...commits.values()]
      .flatMap((entry) => entry.units)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((item) => ({ kind: 'workflow', id: item.id, label: item.name }));
    // Several accepted commits are one base, made once for everyone who waits on that set.
    if (commits.size > 1) {
      const base = await this.bases.find(tx, projectId, commits.keys());
      const path = base ? await this.bases.path(tx, projectId, base.key) : [];
      const held = path.find(
        (record) =>
          record.quarantined ||
          ['suspended', 'cancelled', 'blocked_infra'].includes(record.state) ||
          record.blocker,
      );
      // An admission refusal names which cap or budget holds the merge as its cause.
      const admission =
        !held?.quarantined && admissionCause(held?.blocker) ? held!.blocker! : undefined;
      if (held)
        return {
          status: 'blocked',
          merge: [...commits.keys()],
          blockers: [
            {
              key: 'merge',
              code: held.quarantined
                ? 'code_quarantined'
                : admission
                  ? 'code_base_admission'
                  : 'code_base_blocked',
              ...(admission ? { cause: admission } : {}),
              status: 409,
              message: `Base ${held.key} is ${held.quarantined ? 'quarantined' : held.state}: ${held.blocker ?? held.operatorReason ?? 'operator control'}.`,
              next:
                held.quarantined || held.state === 'cancelled'
                  ? 'An operator must create corrective work and replan these waiters; this retained base cannot be used.'
                  : held.state === 'suspended'
                    ? 'An administrator uses code.base.resume and a reason.'
                    : held.state === 'blocked_infra'
                      ? 'An administrator repairs the infrastructure, then uses code.base.retry.'
                      : held.attempts > 0
                        ? 'The server retries this infrastructure failure automatically; after five failed executions an administrator uses code.base.retry.'
                        : 'Enable project dispatch, restore Sessions, free service capacity, or raise/clear the budget with usage.set_budget. Admission retries automatically without consuming launch or review limits.',
              related,
            },
          ],
        };
      if (base?.state === 'resolved' && base.result)
        return {
          status: 'ready',
          merge: [...commits.keys()],
          body: {
            formatVersion: 1,
            kind: 'merged',
            reference: base.result.commit,
            repositoryId: bound.repositoryId,
            dependencies: relations.dependencies.map((item) => item.id).sort(),
            sources: [...commits.values()]
              .flatMap((entry) => entry.sources)
              .sort((left, right) => left.unitId.localeCompare(right.unitId)),
            // Main is not an acceptance, so it is never a source; the pin names it here, which
            // is also what the publication envelope reads back as its integration base.
            main: publishing ? { oid: main.oid, operationId: main.operationId } : null,
          },
        };
      // The same frozen path already passed disposition checks above; reuse its snapshot.
      const resolutions = path.filter(
        (record) => record.resolutionTaskId && record.state !== 'resolved',
      );
      const resolutionBlockers: WorkflowProvidedBlockerInput[] = [];
      for (const record of resolutions) {
        const task = await this.workflows.relations(projectId, record.resolutionTaskId!, tx);
        resolutionBlockers.push({
          key: `resolution:${record.key}`,
          code: 'code_merge_conflict',
          ...(task?.instance.state === 'suspended' ? { cause: 'suspended' } : {}),
          status: 409,
          message: `Base resolution task “${task?.instance.name ?? record.resolutionTaskId}” (${record.resolutionTaskId}) is ${task?.instance.state ?? 'missing'}. ${record.resolutionError ?? `Conflicting paths: ${(record.conflict?.paths ?? []).join(', ')}`}`,
          next:
            task?.instance.state === 'suspended'
              ? `${this.resolutionTasks?.resume ?? 'The resolution task resumes as its own next move says'}, or an operator cancels/replans the waiting work. Keep this waiter pending.`
              : 'Complete the existing resolution task and its independent review; this unit continues from the accepted result.',
          related: [
            {
              kind: task?.instance.workflow ?? 'workflow',
              id: record.resolutionTaskId!,
              label: task?.instance.name ?? record.resolutionTaskId!,
            },
          ],
        });
      }
      if (resolutionBlockers.length)
        return { status: 'blocked', merge: [...commits.keys()], blockers: resolutionBlockers };
      const waiting =
        !base || ['waiting_inputs', 'queued', 'running', 'retry_wait'].includes(base.state);
      const conflicted = base?.state === 'awaiting_resolution';
      return {
        status: 'blocked',
        merge: [...commits.keys()],
        blockers: [
          {
            key: 'merge',
            code: waiting
              ? 'code_base_wait'
              : conflicted
                ? 'code_merge_conflict'
                : 'code_base_blocked',
            message: waiting
              ? `The ${commits.size} commits this unit’s dependencies were accepted with are being merged into one base`
              : conflicted
                ? base?.conflict?.paths.length
                  ? `The commits this unit’s dependencies were accepted with do not merge cleanly: ${base.conflict.paths.slice(0, 5).join(', ')}`
                  : 'The commits this unit’s dependencies were accepted with merged cleanly, and the project check of that merge failed'
                : `The base of this unit could not be made (${base?.state})`,
            status: 409,
            next: waiting
              ? 'Nothing: the merge runs on the server, and this unit is offered when it is done.'
              : conflicted
                ? 'The conflict is resolved by one reviewed task; this unit continues from its accepted commit.'
                : 'An operator looks at the base with code.status.',
            related,
          },
        ],
      };
    }
    const [accepted] = [...commits];
    if (!accepted && main.stored !== true)
      return {
        status: 'blocked',
        blockers: [await missingMain()],
      };
    return {
      status: 'ready',
      body: {
        formatVersion: 1,
        kind: accepted ? 'accepted' : 'main',
        reference: accepted ? accepted[0] : main.oid,
        repositoryId: bound.repositoryId,
        dependencies: relations.dependencies.map((item) => item.id).sort(),
        sources: (accepted?.[1].sources ?? []).sort((left, right) =>
          left.unitId.localeCompare(right.unitId),
        ),
        // A publishing unit whose one accepted commit is main itself still records it: the
        // envelope it seals later reads its integration base from here.
        main: accepted && !publishing ? null : { oid: main.oid, operationId: main.operationId },
      },
    };
  }

  private baseState(derived: Derived): CodeBaseStatus {
    return derived.status === 'ready'
      ? {
          status: 'ready',
          kind: derived.body.kind,
          sources: derived.body.sources.map((item) => item.unitId),
          // A merged base is ready at one commit the server made; the accepted commits it
          // was made from are what join this unit to that base record.
          ...(derived.merge ? { merge: derived.merge } : {}),
        }
      : derived;
  }

  /**
   * Publishes what a derivation finds for one unit that has neither a base nor an acceptance.
   * A blocked unit is refused at lease admission and so never becomes a dispatch candidate;
   * this row is the only place anyone would see why.
   *
   * A publication wait is the one opinion Code keeps about work that has already ended: it
   * names a human who can still end it, so it is a fact about done work rather than work
   * nobody may take. Every other opinion here is about work still to do, and work that has
   * ended lost its rows at that transition with nothing left to run again and withdraw one,
   * so those are never written onto an instance that has ended.
   */
  private async reconcileUnit(tx: Transaction, projectId: string, unitId: string): Promise<void> {
    const relations = await this.workflows.relations(projectId, unitId, tx);
    if (!relations) return;
    const row = await this.records.row(tx, projectId, unitId);
    if (
      (row?.publication_id || (row?.publishes_at && row.acceptance_json)) &&
      !row.quarantine_base_key
    ) {
      const publication = await this.records.publicationOf(tx, projectId, row);
      await this.setBlockers(
        tx,
        projectId,
        unitId,
        publication ? publicationBlockers(publication) : [],
      );
      return;
    }
    if (row?.quarantine_base_key) {
      if (!relations.instance.terminal)
        await this.setBlockers(tx, projectId, unitId, [
          this.quarantineBlocker(row.quarantine_base_key),
        ]);
      return;
    }
    if (!row || relations.instance.terminal) return;
    const resolution = await this.resolutionBlocker(tx, projectId, unitId);
    if (resolution || row.base_json !== null || row.acceptance_json !== null) {
      await this.setBlockers(tx, projectId, unitId, resolution ? [resolution] : []);
      return;
    }
    let derived = await this.derive(tx, projectId, relations.instance.id);
    // The first unit to wait on a set writes its record and plan; this is a writing path,
    // which a derivation itself never is.
    let prerequisites: string[] = [];
    if (derived.status !== 'waiting' && derived.merge) {
      const base = await this.bases.ensure(tx, projectId, derived.merge);
      // Main is no unit's acceptance, so the lineage names it: a resolution of a clash with
      // main is then reviewed like any other, with main contributing no authors.
      const main = row.publishes_at && (await this.code.project(tx, projectId))?.main.oid;
      if (main && derived.merge.includes(main))
        await tx.run(
          'INSERT INTO code_edges (project_id,source_ref,relation,target_ref,created_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING',
          projectId,
          `base:${base.key}`,
          'merges',
          `main:${main}`,
          now(),
        );
      let path = await this.bases.path(tx, projectId, base.key);
      if (
        path.some((record) => record.state === 'awaiting_resolution' && !record.resolutionTaskId)
      ) {
        await this.resolveBases(tx, projectId);
        path = await this.bases.path(tx, projectId, base.key);
      }
      prerequisites = path
        .flatMap((record) => (record.resolutionTaskId ? [record.resolutionTaskId] : []))
        .sort();
      derived = await this.derive(tx, projectId, relations.instance.id);
      // A pending task has no automatic work to wake; waking it here would schedule another reconciliation forever.
      if (base.state === 'queued') this.bases.soon(projectId);
    }
    const attached = relations.dependencies
      .filter((edge) => edge.kind === 'system' && edge.owner === PROVIDER)
      .map((edge) => edge.id)
      .sort();
    if (JSON.stringify(attached) !== JSON.stringify(prerequisites))
      await this.workflows
        .systemPrerequisites(PROVIDER)
        .replace({ projectId, instanceId: unitId, dependencies: prerequisites }, tx);
    await this.setBlockers(
      tx,
      projectId,
      unitId,
      derived.status === 'blocked' ? derived.blockers : [],
    );
  }

  /** All current waiters contribute their roots before the shared record becomes immutable. */
  async baseSponsors(tx: Transaction, projectId: string, members: string[]): Promise<string[]> {
    const waiters: string[] = [];
    for (const row of await tx.all<{ unit_id: string }>(
      'SELECT unit_id FROM code_units WHERE project_id=? AND base_json IS NULL AND acceptance_json IS NULL',
      projectId,
    )) {
      const relations = await this.workflows.relations(projectId, row.unit_id, tx);
      if (!relations || relations.instance.terminal) continue;
      const derived = await this.derive(tx, projectId, relations.instance.id);
      if (
        'merge' in derived &&
        derived.merge &&
        members.every((member) => derived.merge!.includes(member))
      )
        waiters.push(row.unit_id);
    }
    return this.workflows.sponsoringRoots(projectId, waiters, tx);
  }

  /** Creation and linkage share the caller's transaction, so a crash never leaves an orphan. */
  private async resolveBases(tx: Transaction, projectId: string): Promise<void> {
    for (const base of await this.bases.records(tx, projectId)) {
      if (base.state !== 'awaiting_resolution' || base.quarantined) continue;
      if (!base.resolutionTaskId && this.resolutionTasks) {
        const [left, right] = await this.bases.inputs(tx, projectId, base);
        if (!left || !right) continue;
        const task = await this.resolutionTasks.create(
          {
            projectId,
            requestId: `base:${base.key}`,
            baseReference: left,
            work: await this.resolutionWork(tx, projectId, base, left, right),
          },
          tx,
        );
        await this.bases.linkTask(tx, projectId, base.key, task.id);
        await pinMerge(tx, projectId, task.id, base.key, left, right);
        base.resolutionTaskId = task.id;
      }
      if (base.resolutionTaskId) {
        const unit = await this.records.row(tx, projectId, base.resolutionTaskId);
        const accepted = unit?.acceptance_json
          ? (JSON.parse(unit.acceptance_json) as AcceptanceBody)
          : null;
        if (accepted?.code && digest(accepted) === unit!.acceptance_hash)
          await this.bases.recordAcceptance(tx, projectId, base, accepted.code.commit);
      }
    }
  }

  /** The accepting transaction compares the exact reviewed certificate once. */
  private async resolutionReview(
    caller: Caller,
    tx: Transaction,
    input: CodeUnitAcceptInput,
  ): Promise<boolean> {
    const review = await this.reviews.get(caller, input.reviewRef, tx);
    const provenance = await this.reviewProvenance(caller.projectId, input.unitId, tx);
    return (
      review.subjectId === input.unitId &&
      review.subjectRevision === input.terminalRevision - 1 &&
      review.snapshotHash === input.submissionRef &&
      review.status === 'submitted' &&
      review.verdict === 'pass' &&
      !!review.provenance &&
      canonical(review.provenance) === canonical(provenance)
    );
  }

  /** Each side of a conflicted base: its accepted commits and the units accepted with them. */
  private async resolutionWork(
    tx: Transaction,
    projectId: string,
    base: CodeBaseRecord,
    left: string,
    right: string,
  ): Promise<ResolutionWork> {
    const records = await this.bases.records(tx, projectId);
    const units = new Map<string, ResolutionInput['units']>();
    for (const unit of await tx.all<UnitRow>(
      `SELECT ${unitColumns} FROM code_units WHERE project_id=? AND acceptance_json IS NOT NULL ORDER BY unit_id`,
      projectId,
    )) {
      const accepted = JSON.parse(unit.acceptance_json!) as AcceptanceBody;
      if (!accepted.code || !base.members.includes(accepted.code.commit)) continue;
      const name =
        (await this.workflows.relations(projectId, unit.unit_id, tx))?.instance.name ?? null;
      const entries = units.get(accepted.code.commit) ?? [];
      units.set(accepted.code.commit, [...entries, { id: unit.unit_id, name }]);
    }
    const side = (key: string, commit: string) => ({
      commit,
      inputs: (
        records.find((record) => record.key === key)?.members ??
        base.members.filter((member) => baseKey([member]) === key)
      ).map((member) => ({ commit: member, units: units.get(member) ?? [] })),
    });
    return {
      kind: 'base',
      left: side(base.left, left),
      right: side(base.right, right),
      conflict: { paths: base.conflict?.paths ?? [], messages: base.conflict?.messages ?? '' },
      check: checkFailure(base),
    };
  }

  /**
   * The project's repository gained history or its main was bound again (no unit), or one
   * unit's writer moved: what waited for it is derived again.
   */
  async changed(tx: Transaction, projectId: string, unitId?: string): Promise<void> {
    this.state.assertTransaction(tx);
    if (unitId) await this.reconcileUnit(tx, projectId, unitId);
    else await this.reconcileProject(tx, projectId);
  }

  private quarantineBlocker(key: string): WorkflowProvidedBlockerInput {
    return {
      key: 'quarantine',
      code: 'code_quarantined',
      status: 409,
      message: `This unit uses quarantined base ${key}. Its retained pin and acceptance cannot be reused.`,
      next: 'An administrator creates corrective work and replans the waiters, or, for a quarantine verified to be a false alarm, uses code.base.release. Fencing a capture cannot clear base quarantine.',
      related: [],
    };
  }

  /**
   * Quarantine follows retained lineage, including pins and successes that already left the
   * queue. The reach is derived here rather than accumulated, so releasing the base an
   * operator quarantined retracts everything that only inherited from it, while a base an
   * operator quarantined in its own right keeps its whole reach.
   */
  private async propagateQuarantine(tx: Transaction, projectId: string): Promise<void> {
    const records = await this.bases.records(tx, projectId);
    // Generic Code consumers share storage but do not opt into work-unit quarantine policy.
    // With no quarantined base nothing is reached, so only units still marked need clearing.
    const units: Array<UnitRow & { terminal: boolean }> = [];
    for (const row of await tx.all<UnitRow>(
      `SELECT ${unitColumns} FROM code_units WHERE project_id=?${records.some((base) => base.quarantined) ? '' : ' AND quarantine_base_key IS NOT NULL'}`,
      projectId,
    )) {
      const relations = await this.workflows.relations(projectId, row.unit_id, tx);
      if (relations) units.push({ ...row, terminal: relations.instance.terminal });
    }
    const tainted = new Map<string, string>();
    const reached = new Map<string, string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const base of records) {
        const from = records.find((b) => b.quarantined && [base.left, base.right].includes(b.key));
        const cause = from?.key ?? base.members.map((c) => tainted.get(c)).find(Boolean);
        if (!base.quarantined && cause) {
          await tx.run(
            "UPDATE code_bases SET health='quarantined',operator_reason=?,updated_at=? WHERE project_id=? AND base_key=?",
            `${INHERITED_QUARANTINE}${cause}`,
            now(),
            projectId,
            base.key,
          );
          base.quarantined = true;
          changed = true;
        }
        if (base.quarantined && base.result && !tainted.has(base.result.commit)) {
          tainted.set(base.result.commit, base.key);
          changed = true;
        }
      }
      for (const unit of units) {
        const pin = unit.base_json ? (JSON.parse(unit.base_json) as BaseBody) : null;
        const cause =
          pin &&
          (tainted.get(pin.reference) ??
            pin.sources.map((source) => reached.get(source.unitId)).find(Boolean));
        const resolution = records.find(
          (b) => b.quarantined && b.resolutionTaskId === unit.unit_id,
        );
        if (!reached.has(unit.unit_id) && (cause || resolution)) {
          reached.set(unit.unit_id, cause || resolution!.key);
          changed = true;
        }
        const accepted = unit.acceptance_json
          ? (JSON.parse(unit.acceptance_json) as AcceptanceBody)
          : null;
        const key = reached.get(unit.unit_id);
        if (key && accepted?.code && !tainted.has(accepted.code.commit)) {
          tainted.set(accepted.code.commit, key);
          changed = true;
        }
      }
    }
    for (const unit of units) {
      const key = reached.get(unit.unit_id) ?? null;
      if (key !== unit.quarantine_base_key) {
        await tx.run(
          'UPDATE code_units SET quarantine_base_key=? WHERE project_id=? AND unit_id=?',
          key,
          projectId,
          unit.unit_id,
        );
        await this.code.blockWorkspace(tx, { projectId, unitId: unit.unit_id, reason: key });
      }
      // As in reconcileUnit: a quarantine is a refusal to let more work start on this base,
      // and work that has ended cleared its rows when it ended with nothing left to withdraw
      // one afterwards, so a row written here would block it for good.
      if ((key || unit.quarantine_base_key) && !unit.terminal)
        await this.setBlockers(
          tx,
          projectId,
          unit.unit_id,
          key ? [this.quarantineBlocker(key)] : [],
        );
    }
  }

  /**
   * Every unpinned unit of a project: for a new main, and for a start after Code was away. A
   * writer that moved while this owner was away may have left a blocker to clear, so `away`
   * takes every unit that ever had one; otherwise each writer move was seen as it happened, and
   * only a writer that can still raise a blocker is taken. A publishing unit is always taken: its
   * blockers are read back from its publication and the project's publication controls.
   */
  private async reconcileProject(tx: Transaction, projectId: string, away = false): Promise<void> {
    await this.propagateQuarantine(tx, projectId);
    await this.resolveBases(tx, projectId);
    for (const base of await this.bases.records(tx, projectId)) {
      if (!base.resolutionTaskId) continue;
      const blocker = await this.resolutionBlocker(tx, projectId, base.resolutionTaskId);
      if (blocker || base.operatorReason)
        await this.setBlockers(tx, projectId, base.resolutionTaskId, blocker ? [blocker] : []);
    }
    const units = new Set(
      (
        await tx.all<{ unit_id: string }>(
          `SELECT unit_id FROM code_units WHERE project_id=? AND (${RECONCILED} OR publication_id IS NOT NULL OR (publishes_at IS NOT NULL AND acceptance_json IS NOT NULL))`,
          projectId,
        )
      ).map((row) => row.unit_id),
    );
    for (const writer of await this.writers.writerIdentities(tx, projectId, !away))
      units.add(writer.unitId);
    for (const unitId of [...units].sort()) await this.reconcileUnit(tx, projectId, unitId);
  }

  /** Rebuild projects whose facts may change while detached; `resolving`, those owed a task. */
  async reconcileAll(resolving = false): Promise<void> {
    const projects = await this.state.read(async (sql) => {
      const ids = new Set(
        (
          await sql.all<{ project_id: string }>(
            resolving
              ? "SELECT DISTINCT project_id FROM code_bases WHERE state='awaiting_resolution' AND health='healthy' AND resolution_task_id IS NULL"
              : `SELECT DISTINCT project_id FROM code_units WHERE ${RECONCILED}`,
          )
        ).map((row) => row.project_id),
      );
      if (!resolving)
        for (const writer of await this.writers.writerIdentities(sql)) ids.add(writer.projectId);
      return [...ids].sort();
    });
    for (const projectId of projects)
      await this.state.transaction((tx) => this.reconcileProject(tx, projectId, !resolving));
  }

  /**
   * The durable consumer of workflow.transition. A base changes only when work ends, so a move
   * the event says did not end the work costs nothing past the base check (an event recorded
   * before events said so is read as before); then only what waits on the ended work is derived
   * again, climbing past a dependent that has itself ended, because a derivation looks through
   * those.
   */
  async transitioned(event: StoredEvent, tx: Transaction): Promise<void> {
    if (await this.bases.forTask(tx, event.projectId, event.subjectId)) {
      await this.reconcileProject(tx, event.projectId);
      return;
    }
    if (event.data.terminal === false) return;
    const ended = await this.workflows.relations(event.projectId, event.subjectId, tx);
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
      const above = await this.workflows.relations(event.projectId, node.id, tx);
      queue.push(...(above?.dependents ?? []));
    }
  }

  /** Publication enforcement is work-unit policy; the durable store reports retained facts. */
  private async enforcedPublication(
    sql: Sql,
    projectId: string,
    publication: PublicationStanding | null,
  ): Promise<PublicationStanding | null> {
    if (publication?.state !== 'pending' || publication.destination === 'local') return publication;
    const gate = publicationGate(await publicationControls(sql, projectId));
    // A failed canary explicitly disables publication. Missing setup also blocks merging,
    // but must not say an operator needs to clear a disablement that never happened. Rules
    // the App cannot see wait on an administrator's acknowledgement; a merge still reads them.
    if (gate.includes('code_publication_disabled')) return { ...publication, state: 'disabled' };
    if (gate.length) return { ...publication, state: 'setup_required' };
    return publication;
  }

  /** Only a unit that may still take a base is derived: one accepted or ended never will. */
  private async derivedBaseStatus(
    tx: Transaction,
    row: UnitRow,
    base: CodeBasePin | null,
  ): Promise<CodeBaseStatus | null> {
    const open =
      !base && row.acceptance_json === null
        ? await this.workflows.relations(row.project_id, row.unit_id, tx)
        : null;
    return row.quarantine_base_key
      ? { status: 'blocked', blockers: [this.quarantineBlocker(row.quarantine_base_key)] }
      : base
        ? { status: 'pinned', pin: base }
        : open && !open.instance.terminal
          ? this.baseState(await this.derive(tx, row.project_id, row.unit_id))
          : null;
  }
  private async setBlockers(
    tx: Transaction,
    projectId: string,
    unitId: string,
    blockers: WorkflowProvidedBlockerInput[],
  ): Promise<void> {
    const owner = await this.workflows.relations(projectId, unitId, tx);
    if (!owner) return;
    const row = owner.instance.terminal ? undefined : await this.writers.row(tx, projectId, unitId);
    // A writer generation ends with its session; only a quarantined capture waits for anyone.
    if (row?.quarantine_operation_id)
      blockers = [
        ...blockers,
        {
          key: 'capture',
          code: 'code_capture_quarantined',
          status: 409,
          message: 'The final capture was refused; the last admitted commit is retained',
          next: 'Have a project administrator inspect code.status and run code.unit.fence to retain the last admitted commit.',
          related: [],
        },
      ];
    await this.workflows.replaceBlockers(
      {
        projectId,
        instanceId: unitId,
        provider: PROVIDER,
        // Each says whose move ending it is, which the record's gate answers to its reader.
        blockers: blockers.map((blocker) => {
          const whose = whoseOf(blocker);
          return whose ? { ...blocker, whose } : blocker;
        }),
      },
      tx,
    );
  }
}
