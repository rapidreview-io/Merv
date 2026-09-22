import {
  canonical,
  check,
  digest,
  mapAsync,
  MervError,
  newId,
  now,
  recorded,
  type Caller,
  type CodeBasePin,
  type CodeBaseStatus,
  type CodeUnitPublication,
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
import { pinMerge, pendingMerge } from '@merv/code/pending-merge';
import type { CodeCapture, CodeCaptureRef, CodeCaptures, CodeUnits } from './types.js';
import type { CodeWriterService } from '@merv/code/writers';
import type { CodeBaseRecord } from '@merv/contracts';
import { INHERITED_QUARANTINE, type CodeBaseService } from './bases.js';
import { resolutionProvenance } from './provenance.js';
import type { CodeUnitPublicationSeal } from './publications.js';
import { baseKey } from '@merv/code/base-plan';
import { checkBriefSections, checkResolutionCheck } from './base-check.js';

import {
  CodeUnitStore,
  bindsRepository,
  CODE_DRIVER,
  unitColumns,
  oid,
  type UnitRow,
  type ProjectRow,
  type AcceptanceBody,
  type BaseBody,
} from '@merv/code/units';
export { bindsRepository, CODE_DRIVER } from '@merv/code/units';

/**
 * What an open publication means for the unit that is waiting on it. A done unit carrying one
 * of these is not failing and is not work anybody can take: it is a fact about where its
 * accepted code stands, and every one of them names who ends the wait.
 */
function publicationBlockers(publication: CodeUnitPublication): WorkflowProvidedBlockerInput[] {
  if (publication.state === 'published') return [];
  const pull = publication.pull;
  const named = pull ? ` (pull request #${pull.number})` : '';
  const related = pull ? [{ kind: 'pull-request', id: pull.url, label: `#${pull.number}` }] : [];
  const said = {
    pending: {
      code: 'code_publication_pending',
      message: 'waiting on publication: a signed-in operator merges the pull request',
      next: pull
        ? `A signed-in project operator merges pull request #${pull.number} with code.publication.merge; nothing here is owed by an agent.`
        : 'Nothing: the publication journal opens the pull request, and a signed-in operator merges it.',
    },
    stale: {
      code: 'code_publication_stale',
      message: `main moved; a successor task integrates it${named}`,
      next: 'Create the successor work that takes this accepted commit and the newer main; this unit stays as it is.',
    },
    disabled: {
      code: 'code_publication_disabled',
      message: `publication is not enabled for this project${named}`,
      next: 'An administrator repairs enforcement, records a passing canary for this App and its rules, and clears any disablement with code.publication.control.',
    },
    closed: {
      code: 'code_publication_closed',
      message: `the pull request was closed without merging${named}`,
      next: pull
        ? `A signed-in project operator reopens pull request #${pull.number} on GitHub, or creates the successor work that carries this accepted commit to main.`
        : 'Create the successor work that carries this accepted commit to main.',
    },
    unsealed: {
      code: 'code_publish_unverifiable',
      message:
        'this unit was declared to publish to main, but its acceptance could not open a publication',
      next: 'An administrator reads code.status for this unit and creates the successor work that carries its accepted code to main; this unit stays as it is.',
    },
    incident: {
      code: 'code_publication_incident',
      message: `a publication incident is retained for this unit${named}`,
      next: 'An administrator investigates the observed merge commit in code.status.publication; a retry never clears it.',
    },
  }[publication.state];
  return [{ key: 'publication', status: 409, related, ...said }];
}
/** What a derivation finds; only `ready` carries a body a lease may pin. */
type Derived =
  | { status: 'waiting' }
  /** `merge` names the accepted commits a base has still to be made from. */
  | { status: 'blocked'; blockers: WorkflowProvidedBlockerInput[]; merge?: string[] }
  | { status: 'ready'; body: BaseBody; merge?: string[] };
const PROVIDER = 'code';
const EXPLICIT_BASE =
  'Recreate this work with baseTaskId naming one accepted Git task, which is the explicit form of a base';
const IMPORT = 'An administrator imports it with `merv code-import`';

/** Research policy for durable Code records; absent deployments do not install this integration. */
export class CodeUnitService extends CodeUnitStore implements CodeUnits {
  /** Set once the project repositories exist; without it several commits are never merged. */
  bases?: CodeBaseService;
  /** The journal that carries an accepted unit to main; without it nothing publishes. */
  publications?: {
    openUnit(caller: Caller, input: CodeUnitPublicationSeal, tx: Transaction): Promise<void>;
  };
  reviews?: import('@merv/contracts').Reviews;
  resolutionTasks?: import('@merv/contracts').ServiceTaskCreator;
  constructor(
    state: State,
    scope: Scope,
    private readonly workflows: Workflows,
    private readonly captures: CodeCaptures,
    writers: CodeWriterService,
    private readonly sessions: Pick<import('@merv/sessions/types').Sessions, 'contributors'>,
  ) {
    super(state, scope, writers);
    this.unobserve = writers.changes.observe(async (change, tx) => {
      if (change.kind === 'binding') await this.reconcileProject(tx, change.projectId);
      else await this.reconcileUnit(tx, change.projectId, change.unitId);
    });
  }

  private readonly unobserve: () => void;
  override close(): void {
    this.unobserve();
    super.close();
  }

  reviewProvenance(projectId: string, taskId: string, tx: Transaction) {
    check(
      !this.closed && this.bases,
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
    derivationInputs?: string[],
  ): Promise<CodeUnit> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    caller = structuredClone(caller);
    derivationInputs = derivationInputs && [...derivationInputs];
    await this.scope.require(caller, 'read', tx);
    const relations = await this.workflows.dependencyRelations(caller.projectId, unitId, tx);
    check(relations, 'code_unit_not_found', 'No such unit of work in this project', 404);
    for (const id of derivationInputs ?? []) {
      const input = await this.relations(tx, caller.projectId, id);
      check(
        id !== unitId && input.instance.settled,
        'invalid_base',
        'Derivation inputs must be successful units of this project',
        409,
      );
    }
    await this.retainDeclaration(
      caller,
      {
        unitId,
        workflow: relations.instance.workflow,
        version: relations.instance.version,
        baseReference,
        derivationInputs,
      },
      tx,
    );
    // A unit that cannot start is shown from the moment it exists, not from its first poll.
    await this.reconcileUnit(tx, caller.projectId, unitId);
    return await this.record(tx, (await this.row(tx, caller.projectId, unitId))!);
  }

  /** A base's disposition also gates its resolution task, without changing Tasks' history. */
  private async resolutionBlocker(
    tx: Transaction,
    projectId: string,
    unitId: string,
  ): Promise<WorkflowProvidedBlockerInput | null> {
    const base = await this.bases?.forTask(tx, projectId, unitId);
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
    this.assertOpen();
    this.state.assertTransaction(tx);
    caller = structuredClone(caller);
    await this.scope.require(caller, 'read', tx);
    const disposition = await this.resolutionBlocker(tx, caller.projectId, unitId);
    if (disposition) return { status: 'blocked', blockers: [disposition] };
    const row = await this.row(tx, caller.projectId, unitId);
    if (row?.quarantine_base_key)
      return { status: 'blocked', blockers: [this.quarantineBlocker(row.quarantine_base_key)] };
    if (row?.base_json) return { status: 'pinned', pin: this.pin(row)! };
    return this.baseState(await this.derive(tx, caller.projectId, unitId));
  }

  /** A stale publication keeps the original pin and adds one frozen merge round on its branch. */
  async pinPublication(caller: Caller, unitId: string, tx: Transaction) {
    const row = await this.row(tx, caller.projectId, unitId);
    if (row?.workflow !== 'consolidation' || row.version !== 5) return;
    const stale = await tx.get<{ id: string; revision: number }>(
      'SELECT s.id,s.revision FROM code_proposals s JOIN code_publications p ON p.proposal_id=s.id WHERE s.project_id=? AND s.instance_id=? AND p.stale=1 ORDER BY s.revision DESC LIMIT 1',
      caller.projectId,
      unitId,
    );
    if (!stale) return;
    const plan = digest({ publication: stale.id });
    const existing = await pendingMerge(tx, caller.projectId, unitId);
    if (existing?.plan === plan) return;
    const writer = await this.writers.row(tx, caller.projectId, unitId);
    const project = await this.project(tx, caller.projectId);
    check(
      writer && project && row.base_json,
      'code_base_pending',
      'The publication round needs a retained base and writer',
      409,
    );
    await pinMerge(
      tx,
      caller.projectId,
      unitId,
      plan,
      writer.head_oid ?? JSON.parse(row.base_json).reference,
      project.main.oid,
      stale.revision,
    );
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
    const disposition = await this.resolutionBlocker(tx, caller.projectId, unitId);
    if (disposition) throw new MervError(disposition.code, disposition.message, 409);
    const relations = await this.relations(tx, caller.projectId, unitId);
    const declared = relations.dependencies
      .filter((item) => item.kind !== 'system')
      .map((item) => item.id)
      .sort();
    const existing = await this.row(tx, caller.projectId, unitId);
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
      return this.pin(existing)!;
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
    const pinned = await this.retainBase(
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
    const relations = await this.workflows.dependencyRelations(caller.projectId, input.unitId, tx);
    check(
      relations &&
        (relations.instance.settled ||
          (relations.instance.workflow === 'consolidation' &&
            relations.instance.version === 5 &&
            relations.instance.state === 'awaiting_publication')) &&
        relations.instance.revision === input.terminalRevision,
      'code_acceptance_unverifiable',
      'Only a unit approved by its owner at the named revision can be accepted',
      409,
    );
    const disposition = await this.resolutionBlocker(tx, caller.projectId, input.unitId);
    if (disposition) throw new MervError(disposition.code, disposition.message, 409);
    const health = await this.row(tx, caller.projectId, input.unitId);
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
    // A unit that ever had a writer generation lives in Code's repository, and only there.
    const writer = code ? await this.writers.row(tx, caller.projectId, input.unitId) : undefined;
    const kept = !!writer && Number(writer.generation) >= 1;
    let receipt: string | null = null;
    if (code && kept) {
      check(
        writer.quarantine_operation_id === null,
        'code_capture_quarantined',
        'A capture of this unit is quarantined; it cannot be accepted before an operator fences it',
        409,
      );
      receipt = await this.writers.receipt(tx, caller.projectId, input.unitId, code.commit);
      check(
        receipt,
        'code_acceptance_unverifiable',
        'Code never admitted the commit that was reviewed',
        409,
      );
    }
    const pending = await pendingMerge(tx, caller.projectId, input.unitId);
    if (pending) {
      check(
        (relations.instance.workflow === 'consolidation' && relations.instance.version === 5) ||
          (await this.resolutionReview(caller, tx, input)),
        'code_provenance_unverifiable',
        'Resolution acceptance requires a passing review with the current retained contributor provenance.',
        409,
      );
      const proof = receipt
        ? await tx.get<{ result_json: string }>(
            "SELECT result_json FROM code_operations WHERE id=? AND status='completed'",
            receipt,
          )
        : null;
      const verified = proof ? JSON.parse(proof.result_json).merge : null;
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
      storage: code === null ? 'none' : receipt ? 'code' : 'legacy-local',
      ...(receipt ? { receipt } : {}),
    };
    if (body.workflow === 'consolidation' && body.version === 5)
      return await this.retainReviewAcceptance(caller, body, tx);
    const existing = await this.row(tx, caller.projectId, input.unitId);
    const stored = await this.retainUnitAcceptance(caller, body, tx);
    if (!existing?.acceptance_hash && stored.publishes_at)
      await this.sealPublication(caller, relations.instance.name, stored, body, digest(body), tx);
    this.bases?.soon(caller.projectId);
    return this.acceptance(stored)!;
  }

  /**
   * Seals the publication of an accepted unit from its own facts and hands it to the journal
   * a reviewed consolidation already uses: an immutable snapshot, a pull request against main
   * carrying the approval status on exactly this head, and a signed-in operator's merge. The
   * unit is done either way; what is left is a wait on a human, not more work.
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
    check(this.publications, 'code_unavailable', 'The publication journal is unavailable', 503);
    const base = row.base_json ? (JSON.parse(row.base_json) as BaseBody) : null;
    if (!(body.storage === 'code' && body.code?.tree) || !base?.main) {
      await this.reconcileUnit(tx, caller.projectId, row.unit_id);
      return;
    }
    check(this.reviews, 'code_unavailable', 'The review service is unavailable', 503);
    const review = await this.reviews.get(caller, body.reviewRef, tx);
    const publicationId = newId('codeprop');
    await tx.run(
      'UPDATE code_units SET publication_id=? WHERE project_id=? AND unit_id=? AND publication_id IS NULL',
      publicationId,
      caller.projectId,
      row.unit_id,
    );
    await this.publications!.openUnit(
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
   * power: the merge itself still waits for a signed-in operator, and the declaration is the
   * operator's or the directing agent's, never the worker's own. It has to come before the
   * first lease, because main joins the base at derivation and a pin is immutable.
   */
  async publishOnAcceptance(
    caller: Caller,
    { unitId }: { unitId: string },
    tx: Transaction,
  ): Promise<CodeUnit> {
    this.assertOpen();
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
    const row = await this.row(tx, caller.projectId, unitId);
    check(row, 'code_unit_not_found', 'This unit of work has not been declared to Code', 404);
    if (!row.publishes_at) {
      const project = await this.project(tx, caller.projectId);
      check(
        project?.durability === 'code' && project.main.stored,
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
    return await this.record(tx, (await this.row(tx, caller.projectId, unitId))!);
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
  override async status(caller: Caller): Promise<CodeProjectStatus> {
    this.assertOpen();
    caller = structuredClone(caller);
    return await this.state.transaction(async (tx) => {
      // A project snapshot shares dependency reads; writing paths always read fresh facts.
      this.asked.set(tx, new Map());
      const stored = await this.readStatus(caller, tx);
      return {
        ...stored,
        blockers: (await this.workflows.blockers(caller, undefined, tx)).filter(
          (blocker) => blocker.provider === PROVIDER,
        ),
      };
    });
  }

  /**
   * What a unit depends on. A read that has said it is taking the whole project in one
   * transaction gets each answer once; every writing path asks Workflows again, because a
   * transaction that moves an instance must see what it moved.
   */
  private readonly asked = new WeakMap<
    Transaction,
    Map<string, Promise<WorkflowProviderRelations | null>>
  >();
  private async dependencies(
    tx: Transaction,
    projectId: string,
    unitId: string,
  ): Promise<WorkflowProviderRelations | null> {
    const held = this.asked.get(tx);
    if (!held) return await this.workflows.dependencyRelations(projectId, unitId, tx);
    const key = `${projectId}:${unitId}`;
    const known = held.get(key) ?? this.workflows.dependencyRelations(projectId, unitId, tx);
    held.set(key, known);
    return await known;
  }

  private async relations(
    tx: Transaction,
    projectId: string,
    unitId: string,
  ): Promise<WorkflowProviderRelations> {
    const relations = await this.dependencies(tx, projectId, unitId);
    check(relations, 'code_unit_not_found', 'No such unit of work in this project', 404);
    const frontier = await tx.get<{ inputs_json: string }>(
      'SELECT inputs_json FROM code_unit_frontiers WHERE project_id=? AND unit_id=?',
      projectId,
      unitId,
    );
    if (frontier) {
      // Scheduling prerequisites still gate the owner; only the frozen frontier contributes code.
      const inputs = await mapAsync(JSON.parse(frontier.inputs_json) as string[], async (id) => {
        const input = await this.dependencies(tx, projectId, id);
        check(input, 'code_unit_not_found', 'A declared frontier unit is missing', 409);
        return input.instance;
      });
      return {
        ...relations,
        dependencies: [
          ...inputs,
          ...relations.dependencies.filter((edge) => edge.kind === 'system'),
        ],
      };
    }
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
      related = [] as WorkflowProviderDependency[],
    ) => ({
      key,
      code: 'code_base_pending',
      message,
      status: 409,
      next,
      related: related.map((item) => ({ kind: 'workflow', id: item.id, label: item.name })),
    });
    // Only hosted workflow versions declare units; the binding and imported store are retained.
    const bound = (await tx.get<Pick<ProjectRow, 'repository_id' | 'binding_json' | 'main_json'>>(
      'SELECT repository_id,binding_json,main_json FROM code_projects WHERE project_id=?',
      projectId,
    ))!;
    const main = JSON.parse(bound.main_json) as {
      oid: string;
      operationId: string;
      stored?: boolean;
    };
    const publishing = !!(await this.row(tx, projectId, relations.instance.id))?.publishes_at;
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
          repositoryId: bound.repository_id,
          dependencies: [],
          sources: [],
          main: null,
        },
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
      if (unit?.quarantine_base_key) {
        blockers.push(this.quarantineBlocker(unit.quarantine_base_key));
        continue;
      }
      const intact = !accepted || digest(accepted) === unit!.acceptance_hash;
      if (intact && (accepted ? accepted.code === null : !node.declaresWorkspace)) {
        const below = await this.dependencies(tx, projectId, node.id);
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
      if (!intact || !accepted?.code || !bindsRepository(bound, accepted.code.repositoryId)) {
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
      if (
        accepted.storage !== 'code' &&
        // An import delivers this commit either as its tip or as history it contains; the
        // commits each import was found to contain are recorded with it, outside any
        // transaction, so this gate is a read. A tip matches both patterns, which is right.
        !(await tx.get(
          "SELECT id FROM code_operations WHERE project_id=? AND kind='import' AND status='completed' AND (result_json LIKE ? OR result_json LIKE ?) LIMIT 1",
          projectId,
          `%"head":"${accepted.code.commit}"%`,
          `%"contained":[%"${accepted.code.commit}"%`,
        ))
      ) {
        blockers.push(
          pending(
            `acceptance:${node.id}`,
            `“${node.name}” was accepted from a runner’s own repository, and Code’s repository does not hold that commit yet`,
            `${IMPORT}, naming the accepted commit of “${node.name}”.`,
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
      if (main.stored !== true)
        blockers.push(
          pending(
            'main',
            'Code’s repository does not hold the commit that is main, which this unit publishes to',
            `${IMPORT}, or names an imported commit as main with code.local.bind.`,
          ),
        );
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
    if (commits.size > 1 && this.bases?.enabled) {
      const base = await this.bases.find(tx, projectId, commits.keys());
      const path = base ? await this.bases.path(tx, projectId, base.key) : [];
      const held = path.find(
        (record) =>
          record.quarantined ||
          ['suspended', 'cancelled', 'blocked_infra'].includes(record.state) ||
          record.blocker,
      );
      if (held)
        return {
          status: 'blocked',
          merge: [...commits.keys()],
          blockers: [
            {
              key: 'merge',
              code: held.quarantined
                ? 'code_quarantined'
                : [
                      'sessions_unavailable',
                      'dispatch_disabled',
                      'capacity_full',
                      'budget_exceeded',
                      'usage_unavailable',
                    ].includes(held.blocker ?? '')
                  ? 'code_base_admission'
                  : 'code_base_blocked',
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
            repositoryId: bound.repository_id,
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
        const task = await this.dependencies(tx, projectId, record.resolutionTaskId!);
        resolutionBlockers.push({
          key: `resolution:${record.key}`,
          code: 'code_merge_conflict',
          status: 409,
          message: `Base resolution task “${task?.instance.name ?? record.resolutionTaskId}” (${record.resolutionTaskId}) is ${task?.instance.state ?? 'missing'}. ${record.resolutionError ?? `Conflicting paths: ${(record.conflict?.paths ?? []).join(', ')}`}`,
          next:
            task?.instance.state === 'suspended'
              ? 'A signed-in human operator must extend review_rounds with workflow.extend_limit to resume this same task, or cancel/replan the waiting work. Keep this waiter pending.'
              : 'Complete the existing resolution task and its independent review; this unit continues from the accepted result.',
          related: [
            {
              kind: 'task',
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
    if (commits.size > 1)
      return {
        status: 'blocked',
        blockers: [
          {
            key: 'merge',
            code: 'code_merge_required',
            message: `The dependencies of this unit were accepted with ${commits.size} different commits, and automatic merging is disabled`,
            status: 409,
            next: `${EXPLICIT_BASE}, or make one dependency carry the combined code.`,
            related,
          },
        ],
      };
    const [accepted] = [...commits];
    if (!accepted && main.stored !== true)
      return {
        status: 'blocked',
        blockers: [
          pending(
            'main',
            'Code’s repository does not hold the commit that is main',
            `${IMPORT}, or names an imported commit as main with code.local.bind.`,
          ),
        ],
      };
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
    const relations = await this.dependencies(tx, projectId, unitId);
    if (!relations) return;
    const row = await this.row(tx, projectId, unitId);
    if (
      (row?.publication_id || (row?.publishes_at && row.acceptance_json)) &&
      !row.quarantine_base_key
    ) {
      const publication = await this.publicationOf(tx, projectId, row);
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
    if (derived.status !== 'waiting' && derived.merge && this.bases) {
      const base = await this.bases.ensure(tx, projectId, derived.merge);
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
      await this.workflows.systemPrerequisites(PROVIDER).replace(
        {
          projectId,
          instanceId: unitId,
          dependencies: prerequisites,
          requestId: `base:${unitId}:${relations.instance.revision}:${digest(prerequisites)}`,
        },
        tx,
      );
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
      const relations = await this.workflows.dependencyRelations(projectId, row.unit_id, tx);
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
    if (!this.bases?.enabled) return;
    for (const base of await this.bases.records(tx, projectId)) {
      if (base.state !== 'awaiting_resolution' || base.quarantined) continue;
      if (!base.resolutionTaskId && this.resolutionTasks) {
        const [left, right] = await this.bases.inputs(tx, projectId, base);
        if (!left || !right) continue;
        const brief = await this.resolutionBrief(tx, projectId, base, left, right);
        const task = await this.resolutionTasks.create(
          {
            projectId,
            requestId: `base:${base.key}`,
            ...brief,
            baseReference: left,
            checks: [
              `The first completed merge on the task branch must have exactly two parents: the current checkpoint descending from ${left}, and frozen right input ${right}, in that order. Later rounds add ordinary corrective commits.`,
              // A base whose check failed has no conflicting path to resolve, so asking for
              // that would contradict the brief's own Project check section three lines down.
              checkBriefSections(base)
                ? 'Leave no conflict markers.'
                : 'Resolve every conflicting path and leave no conflict markers.',
              // A base whose check failed merged cleanly, so what this round owes is the
              // failing command passing, not paths resolved. That sentence is where
              // "resolution rounds supply reviewed verification evidence" reaches a worker.
              checkResolutionCheck(base) ??
                'Run the project build and tests as far as this workspace permits; retain commands, results, and any checks that could not run as review evidence.',
            ],
          },
          tx,
        );
        await this.bases.linkTask(tx, projectId, base.key, task.id);
        await pinMerge(tx, projectId, task.id, base.key, left, right);
        base.resolutionTaskId = task.id;
      }
      if (base.resolutionTaskId) {
        const unit = await this.row(tx, projectId, base.resolutionTaskId);
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
    check(this.reviews, 'code_provenance_unverifiable', 'The review service is unavailable', 503);
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

  private async resolutionBrief(
    tx: Transaction,
    projectId: string,
    base: CodeBaseRecord,
    left: string,
    right: string,
  ): Promise<{ title: string; goal: string }> {
    const records = await this.bases!.records(tx, projectId);
    const inputs = (key: string) =>
      records.find((record) => record.key === key)?.members ??
      base.members.filter((commit) => baseKey([commit]) === key);
    const names = new Map<string, string[]>();
    const titles = new Map<string, string[]>();
    for (const unit of await tx.all<UnitRow>(
      `SELECT ${unitColumns} FROM code_units WHERE project_id=? AND acceptance_json IS NOT NULL ORDER BY unit_id`,
      projectId,
    )) {
      const accepted = JSON.parse(unit.acceptance_json!) as AcceptanceBody;
      if (!accepted.code || !base.members.includes(accepted.code.commit)) continue;
      const facts = await this.workflows.dependencyRelations(projectId, unit.unit_id, tx);
      const title = facts?.instance.name ?? 'Accepted work';
      titles.set(accepted.code.commit, [...(titles.get(accepted.code.commit) ?? []), title]);
      const entries = names.get(accepted.code.commit) ?? [];
      entries.push(
        `${facts?.instance.name ?? unit.unit_id} (${unit.unit_id}): ${facts?.instance.goal ?? 'No goal was recorded.'}`,
      );
      names.set(accepted.code.commit, entries);
    }
    const side = (key: string) =>
      inputs(key)
        .map((commit) => `${commit}: ${(names.get(commit) ?? ['Accepted input']).join('; ')}`)
        .join('\n');
    // Each section gets its own room, so long provenance cannot push the right input or Git's diagnostics out of the brief.
    const bounded = (value: string, limit: number) =>
      value.length <= limit ? value : `${value.slice(0, limit)}\n[Truncated in the task brief.]`;
    const titleSide = (key: string) => {
      const items = inputs(key).flatMap((commit) => titles.get(commit) ?? ['Accepted work']);
      const first = items[0] ?? 'Accepted work';
      const label = first.length > 80 ? `${first.slice(0, 79)}…` : first;
      return `‘${label}’${items.length > 1 ? ` and ${items.length - 1} more` : ''}`;
    };
    // A failing project check is a conflict with no paths: every heading and the opening
    // sentence a worker reads first would lie, so the brief says what has to pass instead.
    const checked = checkBriefSections(base);
    const sections = checked ?? [
      `Conflicting paths:\n${bounded((base.conflict?.paths ?? []).join('\n'), 4000)}`,
      `Git messages:\n${bounded(base.conflict?.messages ?? '', 4000)}`,
    ];
    return {
      title: checked
        ? `Make the project check pass on ${titleSide(base.left)} with ${titleSide(base.right)}`
        : `Merge ${titleSide(base.left)} with ${titleSide(base.right)}`,
      goal: `${
        checked
          ? `The merge of ${titleSide(base.left)} and ${titleSide(base.right)} is clean; its project check failed.`
          : `Resolve conflicts between ${titleSide(base.left)} and ${titleSide(base.right)}.`
      }\n\nLeft input ${left} (the workspace starts here):\n${bounded(side(base.left), 8000)}\n\nRight input ${right} (frozen):\n${bounded(side(base.right), 8000)}\n\n${sections[0]}\n\nUse code.merge operation start on the clean initial checkout; wait for code.operation. The right input is frozen and never follows a branch. ${checked ? 'Make the command pass on the merged tree, retain its commands and results as evidence' : 'Resolve the files, retain conflict decisions and test evidence'}, then use code.merge operation complete. code.commit and final captures save single-parent WIP before completion. After interruption on any machine, continue from the downloaded checkpoint and its pendingMerge metadata; do not restart over saved WIP. After the first completed merge, later rounds use code.commit for corrections on this same branch. Retain the operation receipt, parent evidence, and commands and results for independent review.\n\n${sections[1]}`,
    };
  }

  /** The project's repository gained history, which a unit may have been waiting for. */
  async imported(tx: Transaction, projectId: string): Promise<void> {
    this.state.assertTransaction(tx);
    await this.reconcileProject(tx, projectId);
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
    if (!this.bases) return;
    const records = await this.bases.records(tx, projectId);
    // Generic Code consumers share storage but do not opt into research quarantine policy.
    const units: UnitRow[] = [];
    for (const row of await tx.all<UnitRow>(
      `SELECT ${unitColumns} FROM code_units WHERE project_id=?`,
      projectId,
    ))
      if (await this.dependencies(tx, projectId, row.unit_id)) units.push(row);
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
      // Two statements rather than one with the key tested inside the CASE: a placeholder whose
      // only use is `? IS NOT NULL` gives PostgreSQL nothing to infer a type from, and it
      // rejects such a statement at parse time whatever the bound value is.
      if (key !== unit.quarantine_base_key)
        await (key
          ? tx.run(
              "UPDATE code_units SET quarantine_base_key=?,writer_state=CASE WHEN writer_state IN ('reserved','active','closing') THEN 'recovery_required' ELSE writer_state END WHERE project_id=? AND unit_id=?",
              key,
              projectId,
              unit.unit_id,
            )
          : tx.run(
              'UPDATE code_units SET quarantine_base_key=NULL WHERE project_id=? AND unit_id=?',
              projectId,
              unit.unit_id,
            ));
      // As in reconcileUnit: a quarantine is a refusal to let more work start on this base,
      // and work that has ended cleared its rows when it ended with nothing left to withdraw
      // one afterwards, so a row written here would block it for good.
      if (
        (key || unit.quarantine_base_key) &&
        !(await this.workflows.dependencyRelations(projectId, unit.unit_id, tx))?.instance.terminal
      )
        await this.setBlockers(
          tx,
          projectId,
          unit.unit_id,
          key ? [this.quarantineBlocker(key)] : [],
        );
    }
  }

  /** Every unpinned unit of a project: for a new main, and for a start after Code was away. */
  private async reconcileProject(tx: Transaction, projectId: string): Promise<void> {
    await this.propagateQuarantine(tx, projectId);
    await this.resolveBases(tx, projectId);
    for (const base of (await this.bases?.records(tx, projectId)) ?? []) {
      if (!base.resolutionTaskId) continue;
      const blocker = await this.resolutionBlocker(tx, projectId, base.resolutionTaskId);
      if (blocker || base.operatorReason)
        await this.setBlockers(tx, projectId, base.resolutionTaskId, blocker ? [blocker] : []);
    }
    for (const { unit_id } of await tx.all<{ unit_id: string }>(
      'SELECT unit_id FROM code_units WHERE project_id=? AND ((base_json IS NULL AND acceptance_json IS NULL) OR publishes_at IS NOT NULL OR generation>0) ORDER BY unit_id',
      projectId,
    ))
      await this.reconcileUnit(tx, projectId, unit_id);
  }

  /** Rebuild projects with open bases or retained writers whose facts may change while detached. */
  async reconcileAll(): Promise<void> {
    const projects = await this.state.read(
      async (sql) =>
        await sql.all<{ project_id: string }>(
          'SELECT DISTINCT project_id FROM code_units WHERE (base_json IS NULL AND acceptance_json IS NULL) OR publishes_at IS NOT NULL OR generation>0 ORDER BY project_id',
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
    if (
      this.bases?.enabled &&
      (await this.bases.records(tx, event.projectId)).some(
        (base) => base.resolutionTaskId === event.subjectId,
      )
    ) {
      await this.reconcileProject(tx, event.projectId);
      return;
    }
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

  async published(
    caller: Caller,
    unitId: string,
    reviewId: string,
    revision: number,
    tx: Transaction,
  ) {
    const relations = await this.workflows.dependencyRelations(caller.projectId, unitId, tx);
    check(
      relations?.instance.settled && relations.instance.revision === revision,
      'code_acceptance_unverifiable',
      'Publication must complete its owner at this exact revision',
      409,
    );
    await this.retainPublishedAcceptance(caller, unitId, reviewId, revision, tx);
  }

  /** Publication enforcement is research policy; the durable store reports retained facts. */
  protected override async publicationOf(
    sql: Sql,
    projectId: string,
    row: UnitRow,
  ): Promise<CodeUnitPublication | null> {
    const publication = await super.publicationOf(sql, projectId, row);
    if (publication?.state !== 'pending') return publication;
    const controls = await sql.get<{ record_json: string }>(
      'SELECT record_json FROM code_publication_controls WHERE project_id=?',
      projectId,
    );
    const enforcement = controls
      ? (JSON.parse(controls.record_json) as {
          disabled?: boolean;
          canary?: unknown;
          visibility?: { incomplete?: boolean };
        })
      : {};
    // Match the publication gate: unavailable enforcement must name the operator recovery,
    // never tell a researcher that a merge can proceed.
    return enforcement.disabled || !enforcement.canary || enforcement.visibility?.incomplete
      ? { ...publication, state: 'disabled' }
      : publication;
  }

  protected override async record(tx: Transaction, row: UnitRow): Promise<CodeUnit> {
    const stored = await super.record(tx, row);
    const base = stored.base;
    // Only a unit that may still take a base is derived: one accepted or ended never will.
    const open =
      !base && row.acceptance_json === null
        ? await this.dependencies(tx, row.project_id, row.unit_id)
        : null;
    return {
      ...stored,
      baseStatus: row.quarantine_base_key
        ? { status: 'blocked', blockers: [this.quarantineBlocker(row.quarantine_base_key)] }
        : base
          ? { status: 'pinned', pin: base }
          : open && !open.instance.terminal
            ? this.baseState(await this.derive(tx, row.project_id, row.unit_id))
            : null,
    };
  }
  private async setBlockers(
    tx: Transaction,
    projectId: string,
    unitId: string,
    blockers: WorkflowProvidedBlockerInput[],
  ): Promise<void> {
    const owner = await this.dependencies(tx, projectId, unitId);
    if (!owner) return;
    const row = owner.instance.terminal ? undefined : await this.writers.row(tx, projectId, unitId);
    const code = row?.quarantine_operation_id
      ? 'code_capture_quarantined'
      : row?.writer_state === 'recovery_required'
        ? 'code_recovery_required'
        : null;
    if (code)
      blockers = [
        ...blockers,
        {
          key: row!.quarantine_operation_id ? 'capture' : 'writer',
          code,
          status: 409,
          message: row!.quarantine_operation_id
            ? 'The final capture was refused; the last admitted commit is retained'
            : 'The last writer never handed over its final capture',
          next: 'Resume that runner, or have a project administrator inspect code.status and run code.unit.fence to retain the last admitted commit.',
          related: [],
        },
      ];
    await this.workflows.replaceBlockers(
      { projectId, instanceId: unitId, provider: PROVIDER, blockers },
      tx,
    );
  }
}
