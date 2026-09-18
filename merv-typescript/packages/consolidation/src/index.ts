import { mapAsync } from '@merv/contracts';
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
import type { Code } from '@merv/code/types';
import type {
  Consolidation,
  ConsolidationCreate,
  ConsolidationRecord,
  ConsolidationSubmission,
  ConsolidationSubmit,
} from './types.js';
import { createSchema, getSchema, parse, submitSchema } from './input.js';
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
  private closed = false;
  private handles = new Map<number, Awaited<ReturnType<Workflows['register']>>>();
  private contexts = new Map<ActiveState, ContextRegistration>();
  private withdrawReview?: () => void;
  /** Complete storage migrations before publishing this service. */
  initialize!: () => Promise<void>;
  constructor(
    private state: State,
    private scope: Scope,
    private artifacts: Artifacts,
    private workflows: Workflows,
    private reviews: Reviews,
    private contextBuilder: ContextBuilder,
    private code: Code,
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
        for (const state of Object.keys(instructions) as ActiveState[]) {
          this.contexts.set(
            state,
            await contextBuilder.register({
              name: `consolidation.${state}`,
              version: 2,
              kind: state === 'consolidating' ? 'work' : 'review',
              recipe: {
                instructions: instructions[state],
                outputInstructions: instructions[state],
                maxChars: 200000,
                sections: [
                  {
                    key: 'assignment',
                    title: 'Frozen pinned source artifacts and experiment decisions',
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
        for (const version of [1, 2])
          this.handles.set(
            version,
            await workflows.register({ ...definition, version }, this.policy(version)),
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
  private open() {
    check(!this.closed, 'consolidation_unavailable', 'Consolidation is unavailable', 503);
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
    this.open();
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
    this.open();
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
    this.open();
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
        const workflow = await this.handles.get(input.workspace === 'git' ? 2 : 1)!.start(
          caller,
          {
            workflow: 'consolidation',
            version: input.workspace === 'git' ? 2 : 1,
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
    return await inTransaction(this.state, transaction, async (tx) => {
      const record = await this.get(caller, id, tx);
      check(
        record.workflow.state === 'complete' && record.completion,
        'consolidation_not_approved',
        'An independently approved consolidation is required',
        409,
      );
      return record;
    });
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
  ) {
    await this.producer(caller, record, tx);
    this.revision(record, input.expectedRevision);
    const experiments = [...record.experimentIds].sort();
    check(
      digest(input.decisions.map((d) => d.experimentId).sort()) === digest(experiments),
      'consolidation_decisions',
      'Exactly one decision is required for every experiment in the declared experiment scope',
      409,
    );
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
      body.encoding === 'utf8' && !!body.content.trim(),
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
    return { report, evidence };
  }
  async submit(
    caller: Caller,
    value: ConsolidationSubmit,
    transaction?: Transaction,
  ): Promise<ConsolidationRecord> {
    this.open();
    const input = parse(submitSchema, value);
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      return await this.command(caller, 'submit', input, tx, async () => {
        const record = await this.get(caller, input.consolidationId, tx);
        const { report, evidence } = await this.validateSubmission(caller, record, input, tx);
        const ids = [...new Set([report.id, ...evidence.map((a) => a.id)])];
        const authored = new Set(
          caller.session
            ? (await this.artifacts.authored(caller, tx)).map((a) => a.id)
            : [report, ...evidence].filter((a) => a.createdBy === caller.actorId).map((a) => a.id),
        );
        const pinnedInputIds = ids.filter((id) => !authored.has(id));
        const proposal =
          record.workspace === 'git'
            ? await this.code.seal(
                caller,
                {
                  commandId: input.commandId!,
                  summary: `Consolidation: ${record.name}`,
                  artifactIds: ids,
                  pinnedInputIds,
                  provenance: own({
                    sources: record.sources.map((a) => ({ id: a.id, hash: a.hash })),
                    decisions: input.decisions,
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
            artifactIds: reviewArtifacts,
            pinnedInputIds: [...new Set([...pinnedInputIds, ...sourceReports])],
            criteria,
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
          decisions: input.decisions,
          proposal,
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
      409,
    );
    check(
      input.verdict !== 'pass' || !input.returnTo,
      'invalid_review_return',
      'Passing reviews do not accept returnTo',
      409,
    );
    if (caller.session) await this.lease(caller, record, tx);
    await this.reviews.checkSubmit(caller, review.id, input, tx);
  }
  private async submitReview(
    caller: Caller,
    input: ReviewApplication,
    tx: Transaction,
  ): Promise<ConsolidationRecord> {
    this.open();
    await this.scope.require(caller, 'review', tx);
    return await this.command(caller, 'review', input, tx, async () => {
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
        await this.code.recordPublicationReview(
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
    return {
      readOnly: reviewing,
      workspace:
        version === 1
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
              ...(version === 2 ? [grant('code.commit'), grant('code.operation')] : []),
            ]),
      ],
    };
  }
  private leaseHooks(): NonNullable<WorkflowAssignmentRule['lease']> {
    return {
      label: async (context) =>
        (await this.get(context.caller, context.snapshot.id, context.tx)).name,
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
    const row = await tx.get<LeaseRow>(
      'SELECT * FROM consolidation_leases WHERE id=? AND project_id=? AND instance_id=? AND revision=? AND actor_id=?',
      lease.leaseId,
      lease.projectId,
      lease.instanceId,
      lease.expectedRevision,
      lease.actorId,
    );
    check(
      row && digest(JSON.parse(row.receipt)) === digest(lease.receipt),
      'stale_lease',
      'The original consolidation ownership receipt is required',
      409,
    );
    if (row.released_at) return;
    if (row.review_id && row.claim_id)
      await this.reviews.releaseClaim(
        {
          projectId: row.project_id,
          reviewId: row.review_id,
          claimId: row.claim_id,
          actorId: row.actor_id,
          reason,
        },
        tx,
      );
    await tx.run('UPDATE consolidation_leases SET released_at=? WHERE id=?', now(), row.id);
  }
  private policy(version: number): Parameters<Workflows['register']>[1] {
    return {
      successStates: ['complete'],
      describe: async (context) => {
        const record = await this.get(context.caller, context.snapshot.id, context.tx);
        return {
          label: record.name,
          gate: context.snapshot.state,
          references: record.sources.map((a) => ({ kind: 'artifact', id: a.id, label: a.title })),
          waiting:
            context.snapshot.state === 'complete'
              ? 'Reviewed consolidation complete. Central Git publication is separate.'
              : instructions[context.snapshot.state as ActiveState],
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
            ...(version === 2 && state === 'consolidation_review'
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
          const preview = await this.contexts.get(state)!.preview(
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
              : instructions[state];
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
          instruction: instructions.consolidating,
          requiresDependencies: true,
          requiredInput: ['reportArtifactId', 'decisions'],
          arguments: (context) => ({
            consolidationId: context.snapshot.id,
            expectedRevision: context.snapshot.revision,
          }),
          check: async (context) => {
            const record = await this.get(context.caller, context.snapshot.id, context.tx);
            await this.producer(context.caller, record, context.tx);
            if (context.input)
              await this.validateSubmission(
                context.caller,
                record,
                parse(submitSchema, context.input),
                context.tx,
              );
          },
        },
        {
          name: 'review',
          states: ['consolidation_review'],
          transitions: ['approve', 'revise'],
          tool: 'review.submit',
          instruction: instructions.consolidation_review,
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
    const hash = digest({ operation, input });
    const previous = await tx.get<{ input_hash: string; result: string }>(
      'SELECT input_hash,result FROM consolidation_commands WHERE project_id=? AND actor_id=? AND request_id=?',
      caller.projectId,
      caller.actorId,
      input.requestId,
    );
    if (previous) {
      check(
        previous.input_hash === hash,
        'request_conflict',
        'requestId already identifies different consolidation input',
        409,
      );
      return JSON.parse(previous.result) as T;
    }
    const result = await execute();
    await tx.run(
      'INSERT INTO consolidation_commands(project_id,actor_id,request_id,input_hash,result) VALUES(?,?,?,?,?)',
      caller.projectId,
      caller.actorId,
      input.requestId,
      hash,
      JSON.stringify(result),
    );
    return result;
  }
  private async event(caller: Caller, type: string, id: string, data: Data, tx: Transaction) {
    await this.state.appendEvent(tx, {
      projectId: caller.projectId,
      actorId: caller.actorId,
      type: `consolidation.${type}`,
      subjectId: id,
      data: { ...data, ...eventSource(caller) },
    });
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
  inject: ['state', 'scope', 'artifacts', 'workflows', 'reviews', 'contextBuilder', 'code'],
  async apply(ctx: Context) {
    const service = await createService(
      new ConsolidationService(
        ctx.state,
        ctx.scope,
        ctx.artifacts,
        ctx.workflows,
        ctx.reviews,
        ctx.contextBuilder,
        ctx.code,
      ),
    );
    ctx.effect(function* () {
      yield () => service.close();
      yield ctx.provide('consolidation', service);
      yield () => service.withdrawReviewOwner();
    });
  },
};
export default consolidationPlugin;
