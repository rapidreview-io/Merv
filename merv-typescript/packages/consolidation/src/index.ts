import { excludedFromReview, releasedLease, visible, mapAsync } from '@merv/contracts';
import { createService, recorded, replayed } from '@merv/contracts';
import { postgresMigrations } from './index.postgres.js';
import type { Context } from 'cordis';
import {
  check,
  digest,
  inTransaction,
  newId,
  now,
  type Artifact,
  type Artifacts,
  type Caller,
  type ContextBuilder,
  type ContextRegistration,
  type Data,
  type ReviewApplication,
  type ReviewRequest,
  type Reviews,
  type Scope,
  type State,
  type Transaction,
  type WorkflowAssignmentRule,
  type WorkflowCheckContext,
  type WorkflowDefinition,
  type WorkflowExecutionPolicy,
  type WorkflowExecutionBinding,
  type WorkflowLease,
  type Workflows,
} from '@merv/contracts';
import type { Code, CodeCandidateDecision, CodeDecisionManifest } from '@merv/code/types';
import type {
  Consolidation,
  ConsolidationCreate,
  ConsolidationRecord,
  ConsolidationEnd,
  ConsolidationSubmission,
  ConsolidationSubmit,
} from './types.js';
import {
  CONSOLIDATION_LIMITS,
  createSchema,
  endChoiceSchema,
  endSchema,
  getSchema,
  parse,
  submitSchema,
} from './input.js';
export type * from './types.js';

const own = (value: unknown): Data => JSON.parse(JSON.stringify(value)) as Data;
const definition: WorkflowDefinition = {
  name: 'consolidation',
  version: 1,
  managed: true,
  initial: 'consolidating',
  states: ['consolidating', 'consolidation_review', 'complete'],
  terminal: ['complete'],
  edges: [
    { from: 'consolidating', action: 'submit', to: 'consolidation_review' },
    { from: 'consolidation_review', action: 'approve', to: 'complete' },
    { from: 'consolidation_review', action: 'revise', to: 'consolidating' },
  ],
};
/**
 * Versions 1 and 2 have no way out. A consolidation whose prerequisite ends without
 * succeeding can neither submit nor begin — both refuse with dependency_failed — and its own
 * guidance tells it to end work it has no action to end with, so it sits in `consolidating`
 * for good. Versions 3 and 4 carry the same work with an ending edge from either live state,
 * as tasks and experiments have always had. The published versions keep their exact shape.
 */
const endable: WorkflowDefinition = {
  ...definition,
  states: [...definition.states, 'abandoned', 'failed'],
  terminal: [...definition.terminal, 'abandoned', 'failed'],
  edges: [
    ...definition.edges,
    ...(['consolidating', 'consolidation_review'] as const).flatMap((from) => [
      { from, action: 'abandon', to: 'abandoned' },
      { from, action: 'mark_failed', to: 'failed' },
    ]),
  ],
};
/** The versions that can be ended; older instances keep the workflow they were started on. */
const ENDABLE = new Set([3, 4, 5]);
/** Version 5 retains the Git workspace contract until its frontier-base preparation ships. */
const GIT = new Set([2, 4, 5]);
const criteria = [
  'Every frozen experiment has an explicit retain, adapt, drop or no-code decision justified by the pinned source artifacts and evidence.',
  'The consolidated result implements the pinned source artifacts without silently replacing its research conclusions or source corpus.',
  'The retained report and tests verify the combined result, identify regressions and limitations, and support the claimed behavior.',
];
const instructions = {
  consolidating:
    'Consolidate the exact pinned source artifacts. Decide what to retain, adapt, drop, or mark no_code for every frozen experiment. Verify inherited evidence and failures. Retain your own report and test evidence. In Git mode create a successful code.commit before submission. Submit through consolidation.submit with the current expectedRevision. Stop after submission.',
  consolidation_review:
    'Independently review the pinned consolidation report, every experiment decision, and the exact sealed code proposal when present. Verify tests and retained evidence. Never change or re-review the pinned source artifacts itself. Submit review.submit: pass completes consolidation; needs_changes or fail returns only to consolidating. Stop after the verdict.',
};
const candidateInstructions = {
  consolidating:
    'Consolidate the pinned sources and frozen accepted units. Supply one retain, drop, adapt or no_code decision per candidate unitId. An adaptation names a retained accepted replacementUnitId already in the frozen set. A carried dropped ancestor requires a reconciliations entry naming unitId, retainedUnitId and rationale. Dropping work on the frozen integration base leaves its effects; removal requires a corrective change. Retain a report and evidence, create a successful code.commit and submit. Stop after submission.',
  consolidation_review:
    'Independently verify the exact sealed result, frozen candidate-set and decision-manifest hashes, integration base, head, tree and evidence. Review every ancestry conflict and its explicit reconciliation; a drop already on main does not remove effects. Submit review.submit: pass completes consolidation with publication outstanding; other verdicts return to consolidating. Stop after the verdict.',
};
const candidateCriteria = [
  'Every frozen accepted candidate has one justified decision; every adaptation names an independently accepted retained replacement in the frozen set.',
  'Every carried ancestor conflict has an explicit reconciliation supported by the reviewed result and evidence; drops already on main are not represented as removals.',
  'The exact pinned candidate set, decision manifest, integration base, submitted head and tree, report and tests support the combined result and its limitations.',
];
type ActiveState = keyof typeof instructions;
interface Row {
  id: string;
  record: string;
  review_id: string | null;
  completion: string | null;
}
interface LeaseRow {
  id: string;
  project_id: string;
  instance_id: string;
  revision: number;
  actor_id: string;
  review_id: string | null;
  claim_id: string | null;
  receipt: string;
  artifacts: string;
  inputs: string;
  released_at: string | null;
}

/** A domain program over Workflows; it owns no scheduler, identity, Git transport or model call. */
export class ConsolidationService implements Consolidation {
  readonly limits = CONSOLIDATION_LIMITS;
  private closed = false;
  private handles = new Map<number, Awaited<ReturnType<Workflows['register']>>>();
  private contexts = new Map<string, ContextRegistration>();
  private withdrawReview?: () => void;
  /** Complete storage migrations before publishing this service. */
  initialize!: () => Promise<void>;
  constructor(
    private state: State,
    private scope: Scope,
    private artifacts: Artifacts,
    private workflows: Workflows,
    private reviews: Reviews,
    contextBuilder: ContextBuilder,
    private code?: Code,
  ) {
    this.initialize = async () => {
      await state.migrate('consolidation', [
        {
          version: 1,
          postgres: postgresMigrations[1],
          sql: `
CREATE TABLE consolidations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, record TEXT NOT NULL, review_id TEXT, completion TEXT);
CREATE TRIGGER consolidation_identity BEFORE UPDATE OF id,project_id,record ON consolidations BEGIN SELECT RAISE(ABORT,'Consolidation inputs are immutable'); END;
CREATE TRIGGER consolidation_completion BEFORE UPDATE OF completion ON consolidations WHEN OLD.completion IS NOT NULL BEGIN SELECT RAISE(ABORT,'Reviewed consolidation is immutable'); END;
CREATE TRIGGER consolidation_retained BEFORE DELETE ON consolidations BEGIN SELECT RAISE(ABORT,'Consolidations are retained'); END;
CREATE TABLE consolidation_submissions (id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL, UNIQUE(instance_id,revision));
CREATE TRIGGER consolidation_submission_immutable BEFORE UPDATE ON consolidation_submissions BEGIN SELECT RAISE(ABORT,'Consolidation submissions are immutable'); END;
CREATE TRIGGER consolidation_submission_retained BEFORE DELETE ON consolidation_submissions BEGIN SELECT RAISE(ABORT,'Consolidation submissions are retained'); END;
CREATE TABLE consolidation_commands (project_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL, input_hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(project_id,actor_id,request_id));
CREATE TABLE consolidation_leases (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, instance_id TEXT NOT NULL, revision INTEGER NOT NULL, actor_id TEXT NOT NULL, review_id TEXT, claim_id TEXT, receipt TEXT NOT NULL, artifacts TEXT NOT NULL, inputs TEXT NOT NULL, released_at TEXT);
CREATE UNIQUE INDEX consolidation_lease_active ON consolidation_leases(instance_id,revision) WHERE released_at IS NULL;
CREATE TRIGGER consolidation_lease_immutable BEFORE UPDATE OF id,project_id,instance_id,revision,actor_id,review_id,claim_id,receipt,artifacts,inputs ON consolidation_leases BEGIN SELECT RAISE(ABORT,'Consolidation ownership is immutable'); END;
CREATE TRIGGER consolidation_lease_retained BEFORE DELETE ON consolidation_leases BEGIN SELECT RAISE(ABORT,'Consolidation leases are retained'); END;
`,
        },
      ]);
      try {
        for (const recipeVersion of [2, 3])
          for (const state of Object.keys(instructions) as ActiveState[]) {
            const guidance = recipeVersion === 3 ? candidateInstructions : instructions;
            this.contexts.set(
              `${recipeVersion}:${state}`,
              await contextBuilder.register({
                name: `consolidation.${state}`,
                version: recipeVersion,
                kind: state === 'consolidating' ? 'work' : 'review',
                recipe: {
                  instructions: guidance[state],
                  outputInstructions: guidance[state],
                  maxChars: 200000,
                  sections: [
                    {
                      key: 'assignment',
                      title:
                        recipeVersion === 3
                          ? 'Frozen accepted candidates, decisions and ancestry reconciliation'
                          : 'Frozen pinned source artifacts and experiment decisions',
                      required: true,
                    },
                    { key: 'evidence', title: 'Pinned reports and evidence', required: true },
                    {
                      key: 'feedback',
                      title: 'Previous consolidation review feedback',
                      required: false,
                    },
                  ],
                },
              }),
            );
          }
        for (const version of [1, 2, 3, 4, 5])
          this.handles.set(
            version,
            await workflows.register(
              { ...(ENDABLE.has(version) ? endable : definition), version },
              this.policy(version),
            ),
          );
        this.withdrawReview = reviews.registerSubmitOwner({
          id: 'consolidation',
          owns: async (review, tx) =>
            !!(await tx.get(
              'SELECT id FROM consolidations WHERE id=? AND project_id=?',
              review.subjectId,
              review.projectId,
            )),
          submit: async (caller, input, tx) => await this.submitReview(caller, input, tx),
        });
      } catch (error) {
        this.close();
        throw error;
      }
    };
  }
  bindCode(code: Code): () => void {
    this.code = code;
    return () => {
      if (this.code === code) this.code = undefined;
    };
  }
  private requireCode(): Code {
    check(
      this.code,
      'code_unavailable',
      'Code is unavailable; load Code before starting or operating a Git consolidation',
      503,
    );
    return this.code;
  }
  private guidance(version: number) {
    return version === 5 ? candidateInstructions : instructions;
  }
  private capture(caller: Caller): Caller {
    check(!this.closed, 'consolidation_unavailable', 'Consolidation is unavailable', 503);
    return structuredClone(caller);
  }
  private async row(caller: Caller, id: string, tx: Transaction): Promise<Row> {
    const row = await tx.get<Row>(
      'SELECT * FROM consolidations WHERE id=? AND project_id=?',
      id,
      caller.projectId,
    );
    check(row, 'consolidation_not_found', 'Consolidation was not found in this project', 404);
    return row;
  }
  private stored(
    json: string,
  ): Omit<ConsolidationRecord, 'workflow' | 'reviewId' | 'completion' | 'submissions'> {
    const stored = JSON.parse(json);
    if (!stored.sources && stored.reflection) {
      const legacy = stored.reflection;
      const artifacts: Artifact[] = [
        legacy.report,
        ...(legacy.graph ? [legacy.graph] : []),
        legacy.changeSpec,
        ...legacy.lenses.map((lens: { artifact: Artifact }) => lens.artifact),
        ...legacy.corpus.selection.artifacts
          .filter((entry: { status: string }) => entry.status === 'retained')
          .map((entry: { artifact: Artifact }) => entry.artifact),
      ];
      stored.sources = [...new Map(artifacts.map((a) => [a.id, a])).values()];
      stored.experimentIds = legacy.corpus.selection.experiments.map((e: { id: string }) => e.id);
      delete stored.reflection;
    }
    return stored;
  }
  async get(caller: Caller, id: string, transaction?: Transaction): Promise<ConsolidationRecord> {
    caller = this.capture(caller);
    parse(getSchema, { consolidationId: id });
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const row = await this.row(caller, id, tx);
      return {
        ...this.stored(row.record),
        workflow: await this.workflows.get(caller, id, tx),
        reviewId: row.review_id,
        completion: row.completion ? JSON.parse(row.completion) : null,
        submissions: (
          await tx.all<{ record: string }>(
            'SELECT record FROM consolidation_submissions WHERE instance_id=? ORDER BY revision',
            id,
          )
        ).map((row) => JSON.parse(row.record)),
      };
    });
  }
  async list(caller: Caller, transaction?: Transaction): Promise<ConsolidationRecord[]> {
    caller = this.capture(caller);
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      return await mapAsync(
        await tx.all<{ id: string }>(
          tx.dialect === 'postgres'
            ? 'SELECT id FROM consolidations WHERE project_id=? ORDER BY _merv_rowid'
            : 'SELECT id FROM consolidations WHERE project_id=? ORDER BY rowid',
          caller.projectId,
        ),
        async (row) => await this.get(caller, row.id, tx),
      );
    });
  }
  async create(
    caller: Caller,
    value: ConsolidationCreate,
    transaction?: Transaction,
  ): Promise<ConsolidationRecord> {
    caller = this.capture(caller);
    const input = parse(createSchema, value);
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      check(
        !caller.session,
        'forbidden',
        'An assigned worker cannot create another consolidation',
        403,
      );
      return await this.command(caller, 'create', input, tx, async () => {
        const sources = await mapAsync(
          [...new Set(input.sourceArtifactIds)].sort(),
          async (id) => await this.artifacts.get(caller, id, tx),
        );
        const experimentIds = [...new Set(input.experimentIds)].sort();
        // A consolidation names experiments of this project, each read as any record is.
        for (const id of experimentIds)
          check(
            (await this.workflows.get(caller, id, tx)).workflow === 'experiment',
            'invalid_consolidation',
            `${id} is not an experiment`,
            404,
          );
        const version = input.version ?? (input.workspace === 'git' ? 4 : 3);
        check(
          version === 5 || input.taskIds === undefined,
          'invalid_consolidation',
          'Task candidate scope requires version 5',
        );
        check(
          version !== 5 || input.workspace === 'git',
          'invalid_consolidation',
          'Version 5 requires a Git workspace',
        );
        const taskIds = [...new Set(input.taskIds ?? [])].sort();
        for (const id of taskIds)
          check(
            (await this.workflows.get(caller, id, tx)).workflow === 'task',
            'invalid_consolidation',
            `${id} is not a task`,
            404,
          );
        const candidates =
          version === 5
            ? await this.requireCode().freezeCandidates(
                caller,
                [...experimentIds, ...taskIds, ...input.dependsOn],
                tx,
              )
            : undefined;
        const workflow = await this.handles.get(version)!.start(
          caller,
          {
            workflow: 'consolidation',
            version,
            requestId: `consolidation:${caller.actorId}:${input.requestId}`,
            dependsOn: [...new Set(input.dependsOn)],
            data: { name: input.name },
          },
          tx,
        );
        const record = {
          id: workflow.id,
          projectId: caller.projectId,
          ownerId: caller.actorId,
          name: input.name,
          workspace: input.workspace,
          createdAt: now(),
          sources,
          experimentIds,
          ...(candidates ? { taskIds, candidates } : {}),
        };
        await tx.run(
          'INSERT INTO consolidations(id,project_id,record) VALUES(?,?,?)',
          workflow.id,
          caller.projectId,
          JSON.stringify(record),
        );
        await this.event(
          caller,
          'created',
          workflow.id,
          { sourceArtifactIds: sources.map((a) => a.id) },
          tx,
        );
        return await this.get(caller, workflow.id, tx);
      });
    });
  }
  async approved(
    caller: Caller,
    id: string,
    transaction?: Transaction,
  ): Promise<ConsolidationRecord> {
    const record = await this.get(caller, id, transaction);
    check(
      record.workflow.state === 'complete' && record.completion,
      'consolidation_not_approved',
      'An independently approved consolidation is required',
      409,
    );
    return record;
  }
  private revision(record: ConsolidationRecord, expected: number) {
    check(
      record.workflow.revision === expected,
      'revision_conflict',
      'The consolidation revision changed',
      409,
    );
  }
  private async liveLease(
    record: ConsolidationRecord,
    tx: Transaction,
  ): Promise<LeaseRow | undefined> {
    return await tx.get<LeaseRow>(
      'SELECT * FROM consolidation_leases WHERE instance_id=? AND revision=? AND released_at IS NULL',
      record.id,
      record.workflow.revision,
    );
  }
  private async lease(
    caller: Caller,
    record: ConsolidationRecord,
    tx: Transaction,
  ): Promise<LeaseRow> {
    const row = await this.liveLease(record, tx);
    check(
      caller.session && row && row.id === caller.session.id && row.actor_id === caller.actorId,
      'stale_lease',
      'The exact current consolidation worker is required',
      409,
    );
    return row;
  }
  /**
   * Who may end this consolidation. Unlike producing, it is available from either live state
   * and does not ask whether the dependencies are satisfied — an unsatisfiable dependency is
   * the usual reason to end one — but a live worker still owns its record until it lets go.
   */
  private async owner(caller: Caller, record: ConsolidationRecord, tx: Transaction) {
    await this.scope.require(caller, 'write', tx);
    if (caller.session) await this.lease(caller, record, tx);
    else if (caller.actorId !== record.ownerId) await this.scope.require(caller, 'admin', tx);
  }
  private async producer(caller: Caller, record: ConsolidationRecord, tx: Transaction) {
    await this.scope.require(caller, 'write', tx);
    check(
      record.workflow.state === 'consolidating',
      'consolidation_not_writable',
      'Consolidation is awaiting review or complete',
      409,
    );
    if (caller.session) await this.lease(caller, record, tx);
    else {
      if (caller.actorId !== record.ownerId) await this.scope.require(caller, 'admin', tx);
      check(
        !(await this.liveLease(record, tx)),
        'consolidation_leased',
        'The current worker owns this consolidation',
        409,
      );
    }
    await this.workflows.checkDependencies(caller, record.id, tx);
    if (record.workspace === 'git') this.requireCode();
  }
  private async review(
    caller: Caller,
    record: ConsolidationRecord,
    tx: Transaction,
  ): Promise<ReviewRequest> {
    check(
      record.workflow.state === 'consolidation_review' && record.reviewId,
      'stale_review',
      'No current consolidation review',
      409,
    );
    const review = await this.reviews.get(caller, record.reviewId, tx);
    const submission = record.submissions.find((s) => s.reviewId === review.id);
    check(
      review.subjectRevision === record.workflow.revision &&
        submission &&
        submission.revision === record.workflow.revision &&
        submission.producerId === review.producerId,
      'stale_review',
      'The exact consolidation submission must be reviewed',
      409,
    );
    return review;
  }
  private async admit(context: WorkflowCheckContext): Promise<ConsolidationRecord> {
    const record = await this.get(context.caller, context.snapshot.id, context.tx);
    this.revision(record, context.snapshot.revision);
    if (context.snapshot.state === 'consolidating')
      await this.producer(context.caller, record, context.tx);
    else {
      await this.scope.require(context.caller, 'review', context.tx);
      const review = await this.review(context.caller, record, context.tx);
      if (context.caller.session) {
        const lease = await this.lease(context.caller, record, context.tx);
        check(
          lease.claim_id === review.claimId && lease.review_id === review.id,
          'stale_claim',
          'The exact current review claim is required',
          409,
        );
      }
      if (review.status === 'requested')
        await this.reviews.checkStart(context.caller, review.id, context.tx);
      else await this.reviews.checkSubmit(context.caller, review.id, undefined, context.tx);
    }
    return record;
  }
  private sourceArtifacts(record: ConsolidationRecord): string[] {
    return record.sources.map((a) => a.id);
  }
  private async inputs(caller: Caller, record: ConsolidationRecord, tx: Transaction) {
    const current = record.submissions.at(-1);
    const review =
      record.workflow.state === 'consolidation_review'
        ? await this.review(caller, record, tx)
        : null;
    const feedback = (
      await mapAsync(record.submissions, async (submission) => {
        const review = await this.reviews.get(caller, submission.reviewId, tx);
        return review.status === 'submitted' && review.verdict !== 'pass' ? [review] : [];
      })
    ).flat();
    const ids = [
      ...new Set([
        ...this.sourceArtifacts(record),
        ...(current
          ? [
              current.report.id,
              ...current.evidence.map((a) => a.id),
              ...(current.proposal ? [current.proposal.manifestArtifact.id] : []),
            ]
          : []),
      ]),
    ];
    return {
      assignment: own({
        id: record.id,
        name: record.name,
        expectedRevision: record.workflow.revision,
        workspace: record.workspace,
        sources: record.sources,
        experimentIds: record.experimentIds,
        ...(record.candidates ? { candidates: record.candidates, taskIds: record.taskIds } : {}),
        submission: current ?? null,
        review,
      }),
      artifactIds: ids,
      feedback: own({ reviews: feedback }),
    };
  }
  private async allowed(
    caller: Caller,
    record: ConsolidationRecord,
    tx: Transaction,
  ): Promise<string[]> {
    if (!caller.session) return (await this.inputs(caller, record, tx)).artifactIds;
    const lease = await this.lease(caller, record, tx);
    return [
      ...new Set([
        ...(JSON.parse(lease.artifacts) as string[]),
        ...(await this.artifacts.authored(caller, tx)).map((a) => a.id),
      ]),
    ].sort();
  }
  private async validateSubmission(
    caller: Caller,
    record: ConsolidationRecord,
    input: ConsolidationSubmit,
    tx: Transaction,
    manifest?: CodeDecisionManifest,
  ) {
    await this.producer(caller, record, tx);
    this.revision(record, input.expectedRevision);
    if (record.workflow.version === 5) {
      check(
        record.candidates && input.decisions.every((d) => 'unitId' in d),
        'consolidation_decisions',
        'Version 5 requires decisions by frozen candidate unitId',
        409,
      );
      await this.requireCode().verifyCandidates(
        caller,
        record.candidates,
        input.decisions as CodeCandidateDecision[],
        input.reconciliations ?? [],
        manifest,
        tx,
      );
    } else {
      check(
        input.reconciliations === undefined &&
          input.decisions.every((d) => 'experimentId' in d) &&
          digest(input.decisions.map((d) => ('experimentId' in d ? d.experimentId : '')).sort()) ===
            digest([...record.experimentIds].sort()),
        'consolidation_decisions',
        'Exactly one decision is required for every experiment in the declared experiment scope',
        409,
      );
    }
    check(
      record.workspace === 'git' ||
        input.decisions.every((d) => d.decision === 'drop' || d.decision === 'no_code'),
      'consolidation_code_required',
      'Retaining or adapting code requires a Git consolidation',
      409,
    );
    check(
      record.workspace === 'git'
        ? !!input.commandId && !!caller.session?.invocationId
        : !input.commandId,
      'consolidation_commit_required',
      'Git consolidation requires this worker’s successful commit operation; scratch consolidation cannot attach an unrelated commit',
      409,
    );
    const report = await this.artifacts.get(caller, input.reportArtifactId, tx);
    check(
      !this.sourceArtifacts(record).includes(report.id),
      'consolidation_report',
      'The consolidation report must be a new artifact, not one of its frozen sources',
    );
    const authored = new Set(
      caller.session ? (await this.artifacts.authored(caller, tx)).map((a) => a.id) : [],
    );
    check(
      report.createdBy === caller.actorId && (!caller.session || authored.has(report.id)),
      'invalid_evidence_author',
      'The current producer must author the consolidation report',
      403,
    );
    const body = await this.artifacts.read(caller, report.id);
    check(
      body.encoding === 'utf8' && visible(body.content),
      'consolidation_report',
      'A readable nonempty UTF-8 consolidation report is required',
    );
    const allowed = new Set(await this.allowed(caller, record, tx));
    const ids = [...new Set(input.evidenceArtifactIds ?? [])];
    check(
      ids.length === (input.evidenceArtifactIds ?? []).length && !ids.includes(report.id),
      'consolidation_evidence',
      'Evidence identifiers must be distinct and exclude the report',
    );
    const evidence = await mapAsync(ids, async (id) => {
      const artifact = await this.artifacts.get(caller, id, tx);
      check(
        allowed.has(id) || (!caller.session && artifact.createdBy === caller.actorId),
        'forbidden',
        'Evidence must belong to the frozen source corpus or current producer',
        403,
      );
      return artifact;
    });
    return { report, evidence, manifest };
  }
  /**
   * End a consolidation that cannot continue. The usual reason is a prerequisite that ended
   * without succeeding, which leaves submitting and beginning both refused; before versions 3
   * and 4 there was no move left at all and the record stayed in `consolidating` for good.
   */
  async end(
    caller: Caller,
    value: ConsolidationEnd,
    transaction?: Transaction,
  ): Promise<ConsolidationRecord> {
    caller = this.capture(caller);
    const input = parse(endSchema, value);
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      return await this.command(caller, 'end', input, tx, async () => {
        const record = await this.get(caller, input.consolidationId, tx);
        check(
          ENDABLE.has(record.workflow.version),
          'consolidation_not_endable',
          'This consolidation was started on a workflow version with no ending transition',
          409,
        );
        await this.owner(caller, record, tx);
        await this.handles.get(record.workflow.version)!.transition(
          caller,
          {
            instanceId: record.id,
            expectedRevision: input.expectedRevision,
            action: input.outcome === 'failed' ? 'mark_failed' : 'abandon',
            input: own({ outcome: input.outcome, reason: input.reason }),
            requestId: `consolidation:end:${caller.actorId}:${input.requestId}`,
          },
          tx,
        );
        return await this.get(caller, record.id, tx);
      });
    });
  }

  async submit(
    caller: Caller,
    value: ConsolidationSubmit,
    transaction?: Transaction,
  ): Promise<ConsolidationRecord> {
    caller = this.capture(caller);
    const input = parse(submitSchema, value);
    const prepared = await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      // Replays need neither the repository nor a second ancestry inspection.
      if (
        await tx.get(
          'SELECT 1 FROM consolidation_commands WHERE project_id=? AND actor_id=? AND request_id=?',
          caller.projectId,
          caller.actorId,
          input.requestId,
        )
      ) {
        return {
          replay: await this.command<ConsolidationRecord>(caller, 'submit', input, tx, () => {
            throw new Error('The existing command must replay');
          }),
        };
      }
      const record = await this.get(caller, input.consolidationId, tx);
      if (record.workflow.version === 5) {
        check(
          !transaction,
          'consolidation_preparation_required',
          'Version 5 submission prepares ancestry before opening its own transaction',
          409,
        );
        await this.validateSubmission(caller, record, input, tx);
      }
      return { record };
    });
    if ('replay' in prepared) return prepared.replay!;
    const preparedManifest =
      prepared.record.workflow.version === 5
        ? await this.requireCode().inspectCandidates(
            caller,
            prepared.record.candidates!,
            input.decisions as CodeCandidateDecision[],
            input.reconciliations ?? [],
          )
        : undefined;
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      return await this.command(caller, 'submit', input, tx, async () => {
        const record = await this.get(caller, input.consolidationId, tx);
        const { report, evidence, manifest } = await this.validateSubmission(
          caller,
          record,
          input,
          tx,
          preparedManifest,
        );
        const ids = [...new Set([report.id, ...evidence.map((a) => a.id)])];
        const authored = new Set(
          caller.session
            ? (await this.artifacts.authored(caller, tx)).map((a) => a.id)
            : [report, ...evidence].filter((a) => a.createdBy === caller.actorId).map((a) => a.id),
        );
        const pinnedInputIds = ids.filter((id) => !authored.has(id));
        const proposal =
          record.workspace === 'git'
            ? await this.requireCode().seal(
                caller,
                {
                  commandId: input.commandId!,
                  summary: `Consolidation: ${record.name}`,
                  artifactIds: ids,
                  pinnedInputIds,
                  provenance: own({
                    sources: record.sources.map((a) => ({ id: a.id, hash: a.hash })),
                    ...(manifest
                      ? { candidates: record.candidates, manifest }
                      : { decisions: input.decisions }),
                  }),
                  requestId: input.requestId,
                },
                { tool: 'consolidation.submit', input: own(input) },
                tx,
              )
            : null;
        const moved = await this.handles.get(record.workflow.version)!.transition(
          caller,
          {
            instanceId: record.id,
            expectedRevision: input.expectedRevision,
            action: 'submit',
            input: own(input),
            requestId: `consolidation:submit:${caller.actorId}:${input.requestId}`,
          },
          tx,
        );
        const sourceReports = this.sourceArtifacts(record);
        const reviewArtifacts = [
          ...new Set([
            ...ids,
            ...sourceReports,
            ...(proposal ? [proposal.manifestArtifact.id] : []),
          ]),
        ];
        const review = await this.reviews.request(
          caller,
          {
            subjectId: record.id,
            subjectRevision: moved.revision,
            producerId: caller.actorId,
            administrativeActorId: record.ownerId,
            // Neither the owner nor the authority that directed a worker is independent of its work.
            ...(caller.session
              ? {
                  excludedActorIds: [
                    ...new Set([record.ownerId, (await this.scope.authorityActor(caller, tx)).id]),
                  ],
                }
              : {}),
            artifactIds: reviewArtifacts,
            pinnedInputIds: [...new Set([...pinnedInputIds, ...sourceReports])],
            criteria: record.workflow.version === 5 ? candidateCriteria : criteria,
            ...(manifest
              ? { provenanceOwner: 'code.consolidation', requiredCriteria: [1, 2, 3] }
              : {}),
            formatVersion: 2,
            requestId: `consolidation:review:${caller.actorId}:${input.requestId}`,
          },
          tx,
        );
        const submission: ConsolidationSubmission = {
          id: newId('consolidation_submission'),
          revision: moved.revision,
          reviewId: review.id,
          producerId: caller.actorId,
          sessionId: caller.session?.id ?? null,
          createdAt: now(),
          report,
          evidence,
          decisions: manifest?.decisions ?? input.decisions,
          proposal,
          ...(manifest ? { manifest } : {}),
        };
        await tx.run(
          'INSERT INTO consolidation_submissions(id,instance_id,revision,record) VALUES(?,?,?,?)',
          submission.id,
          record.id,
          moved.revision,
          JSON.stringify(submission),
        );
        await tx.run('UPDATE consolidations SET review_id=? WHERE id=?', review.id, record.id);
        await this.event(
          caller,
          'submitted',
          record.id,
          { submissionId: submission.id, reviewId: review.id },
          tx,
        );
        return await this.get(caller, record.id, tx);
      });
    });
  }
  private async checkReview(
    caller: Caller,
    record: ConsolidationRecord,
    input: ReviewApplication,
    tx: Transaction,
  ) {
    const review = await this.review(caller, record, tx);
    this.revision(record, input.expectedRevision);
    check(
      input.reviewId === review.id,
      'stale_review',
      'Review must match the exact current consolidation',
      409,
    );
    check(
      input.verdict === 'pass' || !input.returnTo || input.returnTo === 'consolidating',
      'invalid_review_return',
      'Consolidation review can return only to consolidating',
      400,
    );
    check(
      input.verdict !== 'pass' || !input.returnTo,
      'invalid_review_return',
      'Passing reviews do not accept returnTo',
      400,
    );
    if (caller.session) await this.lease(caller, record, tx);
    await this.reviews.checkSubmit(caller, review.id, input, tx);
  }
  private async submitReview(
    caller: Caller,
    input: ReviewApplication,
    tx: Transaction,
  ): Promise<ConsolidationRecord> {
    caller = this.capture(caller);
    await this.scope.require(caller, 'review', tx);
    return await this.command(caller, 'review', input, tx, async () => {
      check(
        input.paperChanges === undefined,
        'paper_edits_unavailable',
        'Only experiment and reflection reviewers update the paper with a verdict',
      );
      const review = await this.reviews.get(caller, input.reviewId, tx);
      const record = await this.get(caller, review.subjectId, tx);
      await this.checkReview(caller, record, input, tx);
      const action = input.verdict === 'pass' ? 'approve' : 'revise';
      await this.handles.get(record.workflow.version)!.transition(
        caller,
        {
          instanceId: record.id,
          expectedRevision: input.expectedRevision,
          action,
          input: own(input),
          requestId: `consolidation:verdict:${caller.actorId}:${input.requestId}`,
        },
        tx,
      );
      const { expectedRevision: _revision, ...verdict } = input;
      await this.reviews.submit(caller, verdict, tx);
      const submission = record.submissions.find((s) => s.reviewId === review.id)!;
      if (submission.proposal)
        await this.requireCode().recordPublicationReview(
          caller,
          submission.proposal,
          review.id,
          input.verdict,
          tx,
        );
      if (action === 'approve')
        await tx.run(
          'UPDATE consolidations SET completion=? WHERE id=?',
          JSON.stringify({
            submissionId: submission.id,
            reviewId: review.id,
            completedAt: now(),
            centralGit: record.workspace === 'git' ? 'not-published' : 'not-applicable',
          }),
          record.id,
        );
      await tx.run('UPDATE consolidations SET review_id=NULL WHERE id=?', record.id);
      await this.event(
        caller,
        action === 'approve' ? 'completed' : 'returned',
        record.id,
        { reviewId: review.id, submissionId: submission.id },
        tx,
      );
      return await this.get(caller, record.id, tx);
    });
  }
  private execution(state: ActiveState, version: number): WorkflowExecutionPolicy {
    const target = (field: 'instanceId' | 'revision') => ({ kind: 'target' as const, field });
    const reference = (name: string) => ({ kind: 'reference' as const, name });
    const oneOf = (name: string) => ({ kind: 'oneOf' as const, name });
    const grant = (name: string, bindings: Record<string, WorkflowExecutionBinding> = {}) => ({
      name,
      alternatives: [bindings],
    });
    const reviewing = state === 'consolidation_review';
    // 3 and 4 are 1 and 2 with a way out, so each keeps its partner's environment exactly.
    const git = GIT.has(version);
    return {
      readOnly: reviewing,
      workspace: !git
        ? { mode: 'none' }
        : reviewing
          ? {
              mode: 'ephemeral',
              namespace: 'consolidation-reviews',
              base: 'reference:code',
              retain: false,
            }
          : {
              mode: 'persistent',
              namespace: 'consolidations',
              base: 'central',
              perBase: true,
              retain: true,
              advancesCentral: false,
            },
      tools: [
        grant('workflow.status_and_next', { instanceId: target('instanceId') }),
        grant('workflow.assignment', { instanceId: target('instanceId') }),
        grant('consolidation.get', { consolidationId: target('instanceId') }),
        grant('artifact.get', { artifactId: oneOf('artifacts') }),
        grant('artifact.read', { artifactId: oneOf('artifacts') }),
        grant('review.get', { reviewId: oneOf('reviews') }),
        ...(reviewing
          ? [
              grant('review.start', { reviewId: reference('reviewId') }),
              grant('review.submit', {
                reviewId: reference('reviewId'),
                claimId: reference('claimId'),
                expectedRevision: target('revision'),
              }),
            ]
          : [
              grant('artifact.create'),
              grant('consolidation.submit', {
                consolidationId: target('instanceId'),
                expectedRevision: target('revision'),
                reportArtifactId: oneOf('artifacts'),
                evidenceArtifactIds: { kind: 'subset' as const, name: 'artifacts' },
              }),
              ...(git ? [grant('code.commit'), grant('code.operation')] : []),
            ]),
        ...(ENDABLE.has(version)
          ? [
              grant('consolidation.end', {
                consolidationId: target('instanceId'),
                expectedRevision: target('revision'),
              }),
            ]
          : []),
      ],
    };
  }
  private leaseHooks(): NonNullable<WorkflowAssignmentRule['lease']> {
    return {
      label: async (context) =>
        (await this.get(context.caller, context.snapshot.id, context.tx)).name,
      excludes: async (context, actorId) => {
        const record = await this.get(context.caller, context.snapshot.id, context.tx);
        return (
          context.snapshot.state === 'consolidation_review' &&
          !!record.reviewId &&
          excludedFromReview(
            await this.reviews.get(context.caller, record.reviewId, context.tx),
            actorId,
          )
        );
      },
      role: async (context): Promise<'operator' | 'producer' | 'reviewer' | 'reader'> => {
        check(!context.caller.session, 'forbidden', 'An assigned worker cannot delegate work', 403);
        const record = await this.get(context.caller, context.snapshot.id, context.tx);
        if (context.snapshot.state === 'consolidating') {
          await this.producer(context.caller, record, context.tx);
          return 'producer';
        }
        await this.scope.require(context.caller, 'review', context.tx);
        const review = await this.review(context.caller, record, context.tx);
        check(
          review.status === 'requested' && !(await this.liveLease(record, context.tx)),
          'review_unavailable',
          'Consolidation review is already reserved',
          409,
        );
        return 'reviewer';
      },
      acquire: async (context) => {
        await this.leaseHooks().role({ ...context, caller: context.source });
        const record = await this.get(context.caller, context.snapshot.id, context.tx);
        check(
          context.caller.session?.id === context.leaseId &&
            context.caller.projectId === context.source.projectId,
          'invalid_lease',
          'Consolidation lease must belong to this worker',
          403,
        );
        const review =
          context.snapshot.state === 'consolidation_review'
            ? await this.reviews.start(context.caller, record.reviewId!, context.tx)
            : null;
        const inputs = await this.inputs(context.caller, record, context.tx);
        const receipt: Data = {
          leaseId: context.leaseId,
          instanceId: record.id,
          revision: record.workflow.revision,
          actorId: context.caller.actorId,
          reviewId: review?.id ?? null,
          claimId: review?.claimId ?? null,
        };
        await context.tx.run(
          'INSERT INTO consolidation_leases(id,project_id,instance_id,revision,actor_id,review_id,claim_id,receipt,artifacts,inputs) VALUES(?,?,?,?,?,?,?,?,?,?)',
          context.leaseId,
          context.caller.projectId,
          record.id,
          record.workflow.revision,
          context.caller.actorId,
          review?.id ?? null,
          review?.claimId ?? null,
          JSON.stringify(receipt),
          JSON.stringify(inputs.artifactIds),
          JSON.stringify(inputs),
        );
        return receipt;
      },
      check: async (context, receipt) => {
        const record = await this.admit(context);
        check(
          digest(JSON.parse((await this.lease(context.caller, record, context.tx)).receipt)) ===
            digest(receipt),
          'stale_lease',
          'The exact original ownership receipt is required',
          409,
        );
      },
      outputs: async (context) => {
        await this.lease(context.caller, await this.admit(context), context.tx);
        return {
          artifacts: (await this.artifacts.authored(context.caller, context.tx)).map((a) => a.id),
        };
      },
      release: async ({ lease, reason, tx }) => await this.release(lease, reason, tx),
    };
  }
  private async release(lease: WorkflowLease, reason: string, tx: Transaction) {
    this.state.assertTransaction(tx);
    await releasedLease(tx, this.reviews, 'consolidation_leases', lease, reason, {
      instance_id: lease.instanceId,
    });
  }
  private policy(version: number): Parameters<Workflows['register']>[1] {
    return {
      successStates: ['complete'],
      // When a prerequisite ends without succeeding, ending this work is the move; the engine
      // offers it as the next action and names the gate dependency_failed.
      ...(ENDABLE.has(version) ? { dependencyFailureAction: 'end' } : {}),
      describe: async (context) => {
        const record = await this.get(context.caller, context.snapshot.id, context.tx);
        return {
          label: record.name,
          gate: context.snapshot.state,
          references: record.sources.map((a) => ({ kind: 'artifact', id: a.id, label: a.title })),
          waiting:
            context.snapshot.state === 'complete'
              ? 'Reviewed consolidation complete. Central Git publication is separate.'
              : this.guidance(version)[context.snapshot.state as ActiveState],
        };
      },
      assignments: (Object.keys(instructions) as ActiveState[]).map((state) => ({
        state,
        requiresDependencies: true,
        check: async (context) => {
          await this.admit(context);
        },
        execution: this.execution(state, version),
        lease: this.leaseHooks(),
        references: async (context) => {
          const record = await this.admit(context);
          const review =
            state === 'consolidation_review'
              ? await this.review(context.caller, record, context.tx)
              : null;
          const submission = record.submissions.at(-1);
          return {
            artifacts: await this.allowed(context.caller, record, context.tx),
            reviews: [...new Set([...record.submissions.map((s) => s.reviewId)])],
            ...(review ? { reviewId: review.id } : {}),
            ...(review?.claimId ? { claimId: review.claimId } : {}),
            ...(GIT.has(version) && state === 'consolidation_review'
              ? { code: submission!.proposal!.receipt.headOid }
              : {}),
          };
        },
        build: async (context) => {
          const record = await this.admit(context);
          const inputs = context.caller.session
            ? (JSON.parse((await this.lease(context.caller, record, context.tx)).inputs) as Awaited<
                ReturnType<ConsolidationService['inputs']>
              >)
            : await this.inputs(context.caller, record, context.tx);
          const preview = await this.contexts.get(`${version === 5 ? 3 : 2}:${state}`)!.preview(
            context.caller,
            {
              subject: { id: record.id, revision: record.workflow.revision },
              inputs: {
                assignment: { text: JSON.stringify(inputs.assignment) },
                evidence: { artifactIds: inputs.artifactIds, mode: 'auto' },
                feedback: { text: JSON.stringify(inputs.feedback) },
              },
            },
            context.tx,
          );
          const tool = state === 'consolidating' ? 'consolidation.submit' : 'review.submit';
          const review =
            state === 'consolidation_review'
              ? await this.review(context.caller, record, context.tx)
              : null;
          const instruction =
            review?.status === 'requested'
              ? 'Call review.start for the exact current review, then refresh workflow.assignment.'
              : this.guidance(version)[state];
          return {
            role: state === 'consolidating' ? 'producer' : 'reviewer',
            label: `${record.name}: ${state}`,
            brief: instruction,
            references: preview.sources.map((a) => ({
              kind: 'artifact',
              id: a.id,
              label: a.title,
            })),
            handoff: {
              instruction,
              tools:
                review?.status === 'requested' ? ['review.start', 'workflow.assignment'] : [tool],
            },
            execution: { readOnly: state === 'consolidation_review', tools: [] },
            context: preview,
          };
        },
      })),
      actions: [
        {
          name: 'submit',
          states: ['consolidating'],
          transitions: ['submit'],
          tool: 'consolidation.submit',
          instruction: this.guidance(version).consolidating,
          requiresDependencies: true,
          // Git mode also needs the commandId of this worker's own successful code.commit,
          // and only a leased worker can obtain one. Saying so here is the difference between
          // an owner reading "supply a report and decisions" and being told what it cannot do.
          requiredInput: async (context: WorkflowCheckContext) =>
            GIT.has(context.snapshot.version)
              ? ['reportArtifactId', 'decisions', 'commandId']
              : ['reportArtifactId', 'decisions'],
          arguments: (context) => ({
            consolidationId: context.snapshot.id,
            expectedRevision: context.snapshot.revision,
          }),
          check: async (context) => {
            const record = await this.get(context.caller, context.snapshot.id, context.tx);
            await this.producer(context.caller, record, context.tx);
            // Guidance never asks for a requestId, so a preflight does not carry one; demanding
            // it here reported the submission blocked when the call would have accepted it.
            if (context.input)
              await this.validateSubmission(
                context.caller,
                record,
                parse(submitSchema, { requestId: 'preflight', ...context.input }),
                context.tx,
              );
          },
        },
        {
          name: 'review',
          states: ['consolidation_review'],
          transitions: ['approve', 'revise'],
          tool: 'review.submit',
          instruction: this.guidance(version).consolidation_review,
          requiredInput: ['verdict', 'notes', 'synopsis', 'findings'],
          arguments: async (context) => {
            const review = await this.review(
              context.caller,
              await this.get(context.caller, context.snapshot.id, context.tx),
              context.tx,
            );
            return {
              reviewId: review.id,
              ...(review.claimId ? { claimId: review.claimId } : {}),
              expectedRevision: context.snapshot.revision,
            };
          },
          check: async (context) => {
            const record = await this.get(context.caller, context.snapshot.id, context.tx);
            const review = await this.review(context.caller, record, context.tx);
            if (context.input) {
              const input = context.input as unknown as ReviewApplication;
              await this.checkReview(context.caller, record, input, context.tx);
              check(
                !context.transition ||
                  context.transition === (input.verdict === 'pass' ? 'approve' : 'revise'),
                'invalid_review_return',
                'Verdict must match the selected consolidation transition',
                409,
              );
            } else await this.reviews.checkSubmit(context.caller, review.id, undefined, context.tx);
          },
        },
        ...(ENDABLE.has(version)
          ? [
              {
                name: 'end',
                states: ['consolidating', 'consolidation_review'],
                transitions: ['abandon', 'mark_failed'],
                // Never the suggested move: ending is what you reach for when the work cannot
                // go on, and the engine offers it by name when a prerequisite has died.
                suggested: false,
                tool: 'consolidation.end',
                instruction:
                  'End this consolidation when it cannot continue: abandoned when the work is no longer wanted, failed when it was attempted and cannot be completed. Requires a specific reason. This is terminal.',
                requiredInput: ['outcome', 'reason'],
                arguments: (context: WorkflowCheckContext) => ({
                  consolidationId: context.snapshot.id,
                  expectedRevision: context.snapshot.revision,
                }),
                check: async (context: WorkflowCheckContext) => {
                  const record = await this.get(context.caller, context.snapshot.id, context.tx);
                  await this.owner(context.caller, record, context.tx);
                  if (context.input) parse(endChoiceSchema, context.input);
                },
              },
            ]
          : []),
        {
          name: 'start_review',
          states: ['consolidation_review'],
          tool: 'review.start',
          instruction: 'Claim this exact independent consolidation review.',
          arguments: async (context) => ({
            reviewId: (await this.get(context.caller, context.snapshot.id, context.tx)).reviewId!,
          }),
          check: async (context) => {
            const review = await this.review(
              context.caller,
              await this.get(context.caller, context.snapshot.id, context.tx),
              context.tx,
            );
            await this.reviews.checkStart(context.caller, review.id, context.tx);
          },
        },
      ],
    };
  }
  private async command<T>(
    caller: Caller,
    operation: string,
    input: { requestId: string },
    tx: Transaction,
    execute: () => T | Promise<T>,
  ): Promise<T> {
    return await replayed(tx, 'consolidation_commands', caller, operation, input, execute);
  }
  private async event(caller: Caller, type: string, id: string, data: Data, tx: Transaction) {
    await recorded(this.state, tx, caller, `consolidation.${type}`, id, data);
  }
  withdrawReviewOwner() {
    this.withdrawReview?.();
    this.withdrawReview = undefined;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.withdrawReviewOwner();
    for (const handle of this.handles.values()) handle.dispose();
    for (const context of this.contexts.values()) context.dispose();
  }
}
export const consolidationPlugin = {
  name: 'merv-consolidation',
  inject: ['state', 'scope', 'artifacts', 'workflows', 'reviews', 'contextBuilder'],
  async apply(ctx: Context) {
    const service = await createService(
      new ConsolidationService(
        ctx.state,
        ctx.scope,
        ctx.artifacts,
        ctx.workflows,
        ctx.reviews,
        ctx.contextBuilder,
      ),
    );
    ctx.inject(['code'], (ctx) => {
      ctx.effect(() => service.bindCode(ctx.code));
    });
    ctx.effect(function* () {
      yield () => service.close();
      yield ctx.provide('consolidation', service);
      yield () => service.withdrawReviewOwner();
    });
  },
};
export default consolidationPlugin;
